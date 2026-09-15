# ADR 0006 — Split the compliance check from the volume commitment

- **Status:** Accepted
- **Date:** 2026-09-14

## Context

The compliance gate does two things: it decides whether a transfer may proceed,
and it records the amount against the sender's rolling daily ceiling. The
ceiling is what catches structuring — many small transfers just under the
reporting threshold — so it is not optional bookkeeping.

A single `check_and_commit` function is the obvious API. It is also the wrong
one, for two independent reasons.

## Decision

Two functions.

- `check_transfer_allowed(sender, amount, corridor_id) -> Result<bool, ComplianceError>`
  is **pure**: no writes, so it is safe in a read-only simulation.
- `commit_transfer(sender, amount, corridor_id) -> Result<i128, ComplianceError>`
  writes the amount into the sender's daily bucket and is callable **only by the
  registered escrow**.

The escrow calls both inside one transaction: check, lock funds, commit, persist.

A third function, `explain_transfer`, is the non-failing companion for UIs. It
returns a `TransferDecision` with the required tier, the held tier, a reason
`Symbol` and the remaining daily headroom — and never errors, including for an
unknown corridor.

## Why

**Read-only simulation is a first-class use case.** A sender app needs to answer
"what tier does this amount need, and do I have headroom?" before the sender
commits to anything. Soroban simulations are read-only and rejected outright if
they attempt a write, so a combined function could not be simulated — which means
the app would have to reimplement the tiering rules off-chain. Those rules are
per-corridor configuration, so an off-chain copy would drift, and the drift would
be invisible until the app approved something the chain then rejected.

`explain_transfer` exists for exactly this, and it is also why it does not error
on an unknown corridor: returning `UnknownCorridor` as an error would make the
caller handle a refusal path *as* a failure, and the two want different UI.

**Split writes keep the headroom check honest.** If checking and committing were
one call, a sender submitting two transfers concurrently would have both pass the
check against the same headroom, and the second would be committed after the
first had already consumed it. With `check` → `commit` inside one escrow
transaction, the two calls are atomic: a failure in either reverts the whole
transfer, and a second transfer in flight cannot consume headroom the first has
already reserved.

## Consequences

**Good.**

- The gate is testable as a pure function, which is why the boundary tests
  (`tier_bands_flip_exactly_at_the_configured_amounts`) are cheap and exact.
- UIs get a reason without duplicating rule logic.
- The escrow's ordering is explicit in its rustdocs: validate → check → move
  funds → commit → persist. Compliance is verified **before any funds move**,
  which is asserted by
  `compliance_refusal_happens_before_any_funds_move`.

**Accepted costs.**

- Two cross-contract calls per transfer instead of one, which is two more
  opportunities for a cross-contract failure — handled explicitly as an incident
  rather than a refusal (`ComplianceCallFailed`).
- `commit_transfer` must enforce its own caller restriction, since it is now
  independently callable. It takes `escrow.require_auth()` against the registered
  escrow address, and a direct call by anyone else fails. Verified by
  `a_stranger_cannot_commit_volume_against_a_senders_limit` and
  `commit_requires_a_registered_escrow`.
- A caller that invoked `check` and then skipped `commit` would pass the
  per-transfer gate while bypassing the cumulative ceiling. That is precisely the
  risk the caller restriction closes.

## Verification

`structuring_many_small_transfers_still_hits_the_daily_ceiling`,
`commits_accumulate_into_the_daily_bucket`,
`commits_are_isolated_per_sender_and_per_corridor`,
`explain_transfer_never_errors_for_an_unknown_corridor`.
