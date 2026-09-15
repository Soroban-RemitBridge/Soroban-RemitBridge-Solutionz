# ADR 0004 — `refund_expired` is permissionless

- **Status:** Accepted
- **Date:** 2026-09-14

## Context

A transfer that nobody claims before `expiry` has funds sitting in escrow. Some
caller has to be able to return them, and the choice of caller is a choice about
who can withhold a sender's money.

Options considered:

1. **Sender only.** Requires the sender's signature.
2. **Sender or admin.** The operator can trigger it, or the sender can.
3. **Anyone.**

## Decision

**Anyone** may call `refund_expired` after expiry. The destination is the address
recorded at creation and is not a parameter, so a third party can help unwind a
transfer but can never redirect it.

## Why

**Option 1 strands funds.** The single most likely reason a sender does not claim
a refund is that they have lost access to their key — the same event that
motivates the refund in the first place. Sender-only refunds are, in the cases
that matter, no refund at all.

**Option 2 creates a withholding power.** If the operator is a required path, the
operator can decline. That is a power with no legitimate use and obvious abuse
potential: an escrow operator that can hold funds indefinitely has leverage it
should not have, and users have no way to distinguish "the operator is busy" from
"the operator will not".

**Option 3 removes the question.** The refund is self-executing on a timer. The
sender's exit does not depend on the operator's cooperation, the agent's
cooperation, or their own key.

## Consequences

**Good.**

- A sender's recovery path is unconditional. There is no privileged party whose
  absence, unavailability or bad intent can strand funds.
- The refund can be triggered by the app automatically, by a block explorer, or
  by anyone who notices a stale transfer — which makes the recovery path
  resilient to the sender's app being broken or uninstalled.

**Accepted costs.**

- **Anyone pays the fee.** The caller bears the transaction cost of a refund that
  benefits the sender. In practice the sender's app, the backend's indexer or the
  operator subsidises it; the on-chain rule cannot require that.
- **Refunds can be griefed into happening early.** A caller can refund the
  instant a transfer expires. This is not a griefing vector worth defending
  against: expiry is a deadline the sender chose, and extending it after the fact
  would be the escrow contradicting its own committed term.
- **A late agent is not protected.** An agent holding a valid code at the moment
  of expiry cannot claim; the transfer is refundable. This is the intended
  trade-off and it is why the agent app re-reads status immediately before
  releasing cash (see [ADR 0001](0001-commit-reveal-claim-codes.md)).

## Verification

`anyone_can_refund_an_expired_transfer_but_only_to_the_sender`,
`claiming_after_expiry_is_refused_in_favour_of_a_refund`,
`refunds_and_claims_race_cleanly_and_only_one_wins`.
