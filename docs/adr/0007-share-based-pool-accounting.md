# ADR 0007 — Share-based pool accounting from day one

- **Status:** Accepted
- **Date:** 2026-09-14

## Context

Liquidity providers deposit stablecoin into a regional pool; agents draw float
against their bonded collateral. The pool pays **no yield today** — settlement
fees are not routed to it, and nothing accrues.

Given that, the simplest accounting is `deposited[provider] += amount` and
`total_deposited += amount`: one integer per provider, and a withdrawal is a
subtraction. With no yield, that model and a share-based one produce identical
numbers.

## Decision

Use **shares** from the start.

- `total_shares` and a per-provider `share_balance` are tracked from the first
  deposit.
- Deposit returns the number of shares minted: `amount * total_shares / total_deposited`
  when the pool is non-empty, and shares equal the amount when it is empty (the
  first deposit sets the share price to exactly 1).
- Withdrawal takes shares and returns the corresponding underlying float.

The doc comment on `PoolState` records the reason inline, next to the data it
explains.

## Why

**The alternative is not "simpler", it is a migration with ambiguous outcomes.**
The moment the pool pays anything — a share of settlement fees, a yield-bearing
token, an incentive programme — a balance-based pool has to be replaced. At that
point, every existing depositor's claim has to be converted, and the conversion
is the hard part: depositors who joined at different times have different
entitlements, and the data needed to compute them (the deposit history and the
volume it underwrote) was never recorded, because with no yield there was nothing
to record.

**The cost of doing it now is two integers and one division.** The cost of doing
it later is a migration whose correct answer is not recoverable from the
on-chain state.

**It also forces the invariant to be explicit.** Share-based accounting makes
"the pool's float equals the value of outstanding shares" a property that has to
hold on every operation, rather than an assumption that happens to be true when
nothing accrues. That is the invariant depositors are trusting.

## Consequences

**Good.**

- Routing settlement fees into the pool later is a change to what increases
  `total_deposited`, not a change to the accounting model.
- `total_shares` and `share_balance` make dilution visible. A future change that
  mints shares without a deposit is a visible act.
- The first-deposit case is pinned by a test, because it is the one case where
  the share price is not derived: `the_first_deposit_sets_the_share_price_at_one`.

**Accepted costs.**

- Integer division means share minting rounds down, so a depositor can lose a
  sub-unit amount of dust on each deposit. Bounded and in the pool's favour,
  which is the safe direction — the opposite would let a depositor extract value
  from the other depositors by depositing repeatedly.
- Rounding on withdrawal similarly cannot pay out more than the shares are worth.
- Two numbers to keep consistent instead of one, on every mutation. Every path
  that changes `total_deposited` must also decide what it does to
  `total_shares`.

## Verification

`the_first_deposit_sets_the_share_price_at_one`,
`additional_deposits_from_the_same_provider_accumulate_shares`,
`a_provider_can_redeem_shares_for_float`,
`withdrawing_more_shares_than_held_is_rejected`,
`withdrawals_cannot_dip_into_float_agents_are_holding`.
