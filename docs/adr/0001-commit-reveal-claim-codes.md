# ADR 0001 — Commit-reveal claim codes

- **Status:** Accepted
- **Date:** 2026-09-14

## Context

A sender locks funds that an agent must later release as cash to a recipient who
has no wallet. Something has to authorise the release.

Three shapes were considered:

1. **The escrow stores the claim code.** The agent presents the code, the
   contract compares it to the stored value.
2. **The escrow stores `sha256(code)`.** The agent presents the code, the
   contract hashes it and compares.
3. **The recipient has a wallet.** The escrow pays an address the recipient
   controls.

## Decision

Store `sha256(claim_code)` in the escrow. `create_transfer` takes
`claim_hash: BytesN<32>`; `claim_transfer` takes `reveal: BytesN<32>` and
requires `sha256(reveal) == claim_hash`.

The claim code is generated on the sender's device as **32 characters from a
32-symbol Crockford base32 alphabet**, so its UTF-8 bytes are exactly the 32-byte
reveal. No encoding step sits between what the sender writes down and what the
contract verifies.

## Why not the alternatives

**Option 1 fails on first principles.** A ledger is world-readable. Storing the
code there means anyone with a block explorer can claim the transfer. The attack
requires no exploit — the theft is the feature working as designed.

**Option 3 deletes the user the project exists for.** Requiring a wallet means
requiring wallet literacy, a funded account and a seed-phrase backup from someone
who may be collecting cash at a market stall. Recipients being non-users is the
product, not a limitation.

## Consequences

**Good.**

- A ledger disclosure reveals that a transfer exists, its amount and its expiry.
  It does not reveal who can claim it.
- A database compromise does not yield claimable codes — they only ever exist on
  two devices.
- Idempotency is structural: the record flips to `Claimed` in the same
  invocation that pays out, so replay is impossible rather than checked for.

**Accepted costs.**

- **The commit is only as strong as the code's entropy.** The contract cannot
  distinguish `sha256("1234")` from `sha256(160 random bits)`, so code generation
  is a security-critical client requirement that no Rust can enforce. Specified
  in [`docs/security.md`](../security.md), implemented once, in
  `mobile/src/lib/claim.ts`.
- **Anyone holding the code can claim.** Not a flaw: it is the mechanism that
  makes a wallet-free recipient work, and the sender UI says so plainly.
- **The recipient must protect the code** with no recovery path if they lose it.
  The sender's recourse is to wait for expiry and refund.

## Verification

`claiming_twice_pays_once`, `a_wrong_reveal_leaves_the_funds_untouched`,
`refunds_and_claims_race_cleanly_and_only_one_wins`.
