# Contract reference

Four contracts, all in `contracts/`. Every one is `no_std`, returns `Result`
rather than panicking on a predictable failure, and uses a `#[contracterror]` enum
so callers can branch on the exact cause.

| Crate | Type | Cross-contract calls |
| --- | --- | --- |
| `interfaces` | `rlib` only | none (types and traits only) |
| `agent-registry` | `cdylib` + `rlib` | none |
| `compliance-hook` | `cdylib` + `rlib` | none |
| `remit-escrow` | `cdylib` + `rlib` | → registry, → compliance hook |
| `liquidity-pool` | `cdylib` + `rlib` | → registry |

- [`RemitEscrow`](#remitescrow)
- [`AgentRegistry`](#agentregistry)
- [`ComplianceHook`](#compliancehook)
- [`LiquidityPool`](#liquiditypool)
- [Wiring](#wiring)
- [Error code tables](#error-code-tables)

---

## `RemitEscrow`

Custody and the commit-reveal state machine. Holds other people's money, so it is
the crate where the ordering of operations matters most.

### State

```
instance:   EscrowConfig { agent_registry, compliance_hook, treasury,
                           fee_bps, paused, max_expiry_secs }
persistent: Transfer { id, sender, amount, token, claim_hash, corridor_id,
                       expiry, status, created_at, settled_at, claimed_by }
persistent: SenderTransfers(sender) -> Vec<u64>
persistent: TransferCount
instance:   EscrowStats
```

### Lifecycle

| Function | Auth | Effect |
| --- | --- | --- |
| `initialize(admin, agent_registry, compliance_hook, treasury, fee_bps, max_expiry_secs)` | — | One-time setup. `fee_bps ≤ MAX_FEE_BPS` (500 = 5%) |
| `set_admin(new_admin)` | admin | Rotate the operator key |
| `set_fee_bps(fee_bps)` | admin | Bounded by `MAX_FEE_BPS` |
| `set_treasury(treasury)` | admin | Redirect fees |
| `set_agent_registry(addr)` | admin | Upgrade path **and** incident-response control |
| `set_compliance_hook(addr)` | admin | Same |
| `set_max_expiry(secs)` | admin | Bound on how far ahead a transfer may be dated |
| `set_paused(bool)` | admin | Blocks **creation only** |

`MAX_FEE_BPS` is a compile-time constant rather than a convention because a
compromised or mistaken operator key must not be able to turn the escrow into a
fee-extraction mechanism against funds it already holds.

`max_expiry_secs` exists so a sender cannot lock funds for an effectively
infinite window and strand them. Without it, "unclaimed forever" and "expired
tomorrow" are both possible and only one is recoverable.

### Sender

```rust
fn create_transfer(
    env: Env,
    sender: Address,        // require_auth
    amount: i128,           // must be > 0
    token: Address,
    claim_hash: BytesN<32>, // sha256(claim_code) — never the code
    corridor_id: Symbol,
    expiry: u64,            // now < expiry <= now + max_expiry_secs
) -> Result<u64, EscrowError>
```

Order of operations, and why:

1. **Validate cheap inputs.** A zero amount or a past expiry fails before
   anything is touched.
2. **`check_transfer_allowed`.** Before funds move, so a compliance refusal costs
   nothing.
3. **Transfer tokens in.** Only after the gate approves.
4. **`commit_transfer`.** Records the amount against the sender's rolling daily
   bucket, inside the same transaction.
5. **Persist and emit.**

The contract cannot tell a `sha256` of a low-entropy code from a good one. It
sees 32 bytes either way. Code generation is therefore the *client's*
responsibility, and the mobile app generates 32 characters from a CSPRNG over a
32-symbol alphabet so the code's UTF-8 bytes *are* the `BytesN<32>` reveal. See
[security.md](security.md#1-the-claim-code-is-the-money).

```rust
fn cancel_transfer(env: Env, sender: Address, transfer_id: u64) -> Result<(), EscrowError>
```

Sender-only, `Pending`-only. The escape hatch for "I sent it to the wrong person
and they have not claimed it yet".

### Agent

```rust
fn claim_transfer(
    env: Env,
    agent: Address,        // require_auth
    transfer_id: u64,
    reveal: BytesN<32>,
) -> Result<ClaimReceipt, EscrowError>
```

Verified in order: transfer exists → still `Pending` → not expired →
`sha256(reveal) == claim_hash` → `is_authorized_for_corridor(agent, corridor)` →
sender is not the claimant. Then funds move, the record flips, and the event is
emitted.

Idempotency is structural rather than a guard: the status change and the payment
happen in one invocation, so a replay hits `TransferNotPending`. There is no
state in which a transfer is both pending and paid.

`SenderCannotClaim` exists because a sender claiming their own transfer would be a
way to pay themselves a fee-adjusted payout out of their own escrow — a fee
rounding attack, not a feature.

### Anyone

```rust
fn refund_expired(env: Env, transfer_id: u64) -> Result<(), EscrowError>
```

Permissionless. No `require_auth` at all. Two invariants make that safe: the
destination is the **recorded sender**, and the transfer must be expired and
still pending. A third party can only accelerate a refund the sender was already
entitled to.

### Read model

`get_transfer`, `transfer_count`, `list_sender_transfers`, `escrow_config`,
`escrow_stats`, and `quote_claim` — the last returns gross/fee/payout so an agent
can show the customer a payout figure *before* committing to hand over cash.

### Events

`tr_create`, `tr_claim`, `tr_refnd`, `tr_cncl`, `esc_cfg`, `esc_wire`,
`esc_adm`. See [events.md](events.md).

---

## `AgentRegistry`

Who is allowed to move money, and what they have at risk.

### State

```
instance:   admin, bond_token, treasury
persistent: Agent { address, region_id, bond_token, bond, status,
                    slash_count, registered_at, updated_at }
persistent: RegionConfig { region_id, min_bond, max_agents, active }
persistent: RegionAgents(region_id) -> Vec<Address>
persistent: CorridorRegion(corridor_id) -> region_id
instance:   RegistryStats
```

### Lifecycle

`initialize(admin, bond_token, treasury)`, `set_admin`, `set_treasury`, all
admin-gated.

`BondTokenMismatch` exists so a bond cannot be posted in a different asset than
the configured one. `bond_token` is stored per agent as well as contract-wide:
when the operator rotates the bond token for *new* agents, existing bonds keep
their original denomination rather than being silently revalued.

### Regions and corridors

| Function | Effect |
| --- | --- |
| `add_region(region_id, min_bond, max_agents)` | Create. `max_agents = 0` means uncapped |
| `set_min_bond(region_id, min_bond)` | Future registrations only; never retroactively evicts |
| `set_region_active(region_id, active)` | Switches settlement off for the region |
| `map_corridor(corridor_id, region_id)` | Ties an escrow corridor to a region |

`add_region` and `set_min_bond` are separate functions rather than one upsert, and
the deploy script had to be corrected for it: `set_min_bond` on an unknown region
returns `UnknownRegion` rather than creating one. That distinction is deliberate —
a typo in a region symbol should fail loudly, not conjure a region with a default
minimum bond.

### Agent lifecycle

```
register_agent(agent, region_id, bond_amount)  → Pending
        │  top_up_bond / withdraw_bond allowed
        ▼
authorize_agent(agent)                         → Authorized  (may settle)
        │  withdraw_bond blocked from here
        ├──────────────▶ suspend_agent(agent, reason) → Suspended
        └──────────────▶ revoke_agent(agent, reason)  → Revoked
                                  │
                          re-register_agent allowed from Revoked only
```

- Posting a bond yields `Pending`, not `Authorized`. A bond alone never grants the
  right to settle a transfer; operator review does.
- `withdraw_bond` is blocked in `Authorized` (`BondLockedWhileAuthorized`), because
  the bond is the only thing standing between a payer and an agent that has
  already handed over cash.
- `Revoked` is terminal except for re-registration, and re-registration requires a
  fresh qualifying bond. A revoked agent cannot re-enter on the strength of its
  old record.

### Slashing

```rust
fn slash_agent(env, agent, amount, reason) -> Result<i128, AgentRegistryError>
```

Admin-gated. Confiscates bond for confirmed fraud or no-show and pays it to the
**treasury**, not to the caller's account, and emits a `slash` event. Both
properties matter: redirecting to treasury means the operator does not personally
profit from a slash, and the event means the slash is auditable whether or not
anyone trusts the operator's own records.

Returns the amount actually recovered, which may be less than requested if the
bond was already partly consumed — the caller gets the truth rather than an
assumption. Exceeding the bond entirely is `SlashExceedsBond`.

### Reads

`is_authorized(agent, region)`, `is_authorized_for_corridor(agent, corridor)` —
the one the escrow calls, so the corridor→region mapping lives in exactly one
place — `get_agent`, `get_bond`, `get_region`, `list_regions`,
`list_region_agents`, `region_agent_count`, `registry_stats`.

### Events

`agent_reg`, `agent_st`, `bond_up`, `bond_down`, `slash`, `region`, `corridor`,
`admin`.

---

## `ComplianceHook`

The gate. It is a separate contract from the escrow specifically so the escrow
does not have to be redeployed to change a threshold, and so a compliance failure
can be reasoned about without reading custody code.

### State

```
instance:   admin, escrow, paused
persistent: Operators(addr) -> bool          (attesters)
persistent: TierThresholds(corridor_id)
persistent: Attestation(subject)
persistent: DailyVolume(sender, corridor, day) -> i128
instance:   ComplianceStats
```

### The tier model

| Amount | Required tier | What it means |
| --- | --- | --- |
| `≤ tier1_max` | `None` | No attestation |
| `≤ tier2_max` | `Standard` | Government-ID-grade verification, held off-chain |
| `> tier2_max` | `Enhanced` | Standard plus source of funds and screening |

Bands are per-transfer, because the sender-facing question is "does this transfer
need ID?". The cumulative control is `daily_limit`, which is enforced separately
across transfers.

`TierThresholds::is_valid` rejects the configurations that would silently weaken
the gate: negative bands, an inverted `tier1_max`/`tier2_max` pair, a non-positive
daily limit, and a daily limit that cannot accommodate even one top-tier transfer
(the last is a usability bug — it makes a corridor impossible rather than strict).

`KycTier` ordering goes through an explicit `rank()` rather than a derived `Ord`,
so the on-chain `u32` tag and the business ordering cannot drift.

### Attestations, and what is *not* in them

```rust
publish_attestation(attester, subject, tier, attestation_hash, region_id,
                    provider_id, expires_at)
revoke_attestation(attester, subject, reason)
```

`attestation_hash` is `sha256` of the backend's signed payload. The document that
proves who the sender is — passport scan, proof of address, screening output —
never touches the ledger. `provider_id` is recorded so a migration from one
provider to another is visible in the event history rather than silent.

`attester` is passed explicitly rather than inferred, so the contract can check it
against the operator allowlist *and* `require_auth` it, making the authorization
tree visible in the transaction itself.

### The gate

```rust
fn check_transfer_allowed(env, sender, amount, corridor_id) -> Result<bool, ComplianceError>
fn explain_transfer(env, sender, amount, corridor_id)  -> TransferDecision
fn commit_transfer(env, sender, amount, corridor_id)   -> Result<i128, ComplianceError>
```

`check_transfer_allowed` is **pure** — no writes — which is what lets the sender
app simulate it read-only to preflight an amount. `explain_transfer` is its
non-failing companion for UIs, returning a `TransferDecision` with the required
tier, the held tier, a reason tag and remaining daily headroom. It exists so the
console can render *why* a transfer needs more verification without
re-implementing the tiering rules off-chain and drifting from the contract.

`commit_transfer` is split from the check so the escrow can do reserve → commit
inside one atomic transaction. `NotEscrow` guards it: only the registered escrow
may commit volume, so nobody can exhaust another sender's daily bucket by calling
the hook directly.

Every refusal is a distinct typed error, because the sender-facing app turns them
into different journeys — `AttestationMissing` opens verification,
`DailyLimitExceeded` suggests splitting, `TierTooLow` routes to enhanced due
diligence, and `TransfersPaused` is an outage the sender cannot fix.

### Events

`kyc_pub`, `kyc_rev`, `kyc_tier`, `kyc_oper`, `kyc_paus`, `kyc_escr`,
`kyc_comm`. No payload carries PII; see [events.md](events.md).

---

## `LiquidityPool`

Per-region float that agents draw against their bond, so a kiosk does not have to
fund its own cash position from scratch.

### State

```
instance:   PoolConfig { agent_registry, token, collateral_ratio_bps,
                         default_utilization_cap_bps, paused }
persistent: PoolState(region_id) { total_deposited, total_drawn, total_shares,
                                   depositor_count, utilization_cap_bps,
                                   active, updated_at }
persistent: Shares(provider, region_id) -> i128
persistent: Exposure(agent, region_id)  -> i128
instance:   LiquidityStats
```

### Share-based accounting from day one

Share price is 1:1 today and the pool pays no yield, so share accounting looks
like unnecessary machinery. It is not: when settlement fees are routed here, the
share price rises for existing depositors without a migration. A naive
"balance == deposit" model would have to be replaced, and at the moment of
replacement the first depositors' claims become ambiguous.

### Deposits and withdrawals

```rust
deposit_liquidity(provider, region_id, amount) -> Result<i128, LiquidityError>  // shares
withdraw_liquidity(provider, region_id, shares) -> Result<i128, LiquidityError> // amount
```

Withdrawal is limited to the undrawn balance, which is the entire reason the
utilization cap exists: it guarantees a reserve stays available so a sudden recall
of agent float cannot strand a depositor's exit.

### Draws

```rust
draw_liquidity(agent, region_id, amount) -> Result<i128, LiquidityError>
repay_liquidity(agent, region_id, amount) -> Result<i128, LiquidityError>
```

A draw is checked in this order: pool exists and is active → agent is authorized
in that region → pool holds the float → the draw stays inside the utilization cap
→ the agent's **registry bond** still covers total exposure at
`collateral_ratio_bps` (150%).

The bond read is a cross-contract call to `AgentRegistry.get_bond`. That is the
point of the whole arrangement: the number the agent plans against is the number
the chain enforces. There is no off-chain collateral figure anyone can be wrong
about.

`InsufficientCollateral` and `UtilizationCapExceeded` are separate on purpose. The
first tells an agent to top up its bond; the second means the region as a whole is
out of float and bonding more will not help. Collapsing them sends agents to the
wrong remedy.

### Why there is no `rejected_draws` counter

A refused draw returns a typed error, which reverts the invocation, and Soroban
discards state writes from reverted invocations. A counter incremented on that
path could only ever read zero. Refusals are counted off-chain by the backend,
which observes the typed error, and the dashboard gets its
collateral-versus-utilization breakdown from `required_bond_for`, which is a pure
read and therefore callable *on* the failing path.

### Reads

`get_pool_health(region_id)` (the `PoolStats` view), `pool_state`, `list_pool_regions`,
`agent_exposure`, `share_balance`, `required_bond_for(agent, region, additional)`,
`pool_config`, `liquidity_stats`.

`required_bond_for` is what lets the agent app prompt for a bond top-up *before* a
draw fails, instead of surfacing a transaction error to someone standing at a
counter with a customer waiting.

### Pausing

Blocks deposits, withdrawals and draws. **Repayments keep working**, so an agent
can always unwind exposure during an incident. A pause that blocked repayment
would trap agents in debt for the duration of an unrelated outage.

### Events

`lp_region`, `lp_dep`, `lp_wdraw`, `lp_draw`, `lp_repay`, `lp_cfg`, `lp_wire`,
`lp_admin`.

---

## Wiring

| Contract | Needs | Set by |
| --- | --- | --- |
| `AgentRegistry` | `bond_token`, `treasury` | `initialize` |
| `ComplianceHook` | `escrow` | `set_escrow` |
| `RemitEscrow` | `agent_registry`, `compliance_hook`, `treasury` | `initialize` |
| `LiquidityPool` | `agent_registry`, `token` | `initialize` |

`scripts/src/deploy-contracts.ts` performs this in a fixed order: build → upload
Wasm → deploy all four → initialize all four → wire → configure regions and
corridors → verify every read-back. The order is deliberate — deploying all four
before initializing any means a mid-way failure leaves unused instances rather
than live contracts pointing at zero addresses.

---

## Error code tables

The backend mirrors these in `backend/src/config/constants.ts`, because it must be
able to name a failure from a returned transaction result without an RPC
round-trip — for example while replaying history during a reindex. `scripts/`
verifies the mirror against the built contract specs and fails on drift.

| `EscrowError` | `AgentRegistryError` | `ComplianceError` | `LiquidityError` |
| --- | --- | --- | --- |
| 1 `NotInitialized` | 1 `NotInitialized` | 1 `NotInitialized` | 1 `NotInitialized` |
| 2 `AlreadyInitialized` | 2 `AlreadyInitialized` | 2 `AlreadyInitialized` | 2 `AlreadyInitialized` |
| 3 `Unauthorized` | 3 `Unauthorized` | 3 `Unauthorized` | 3 `Unauthorized` |
| 4 `Paused` | 4 `InvalidAmount` | 4 `NotAnAttester` | 4 `Paused` |
| 5 `InvalidAmount` | 5 `UnknownRegion` | 5 `NotEscrow` | 5 `InvalidAmount` |
| 6 `InvalidExpiry` | 6 `RegionInactive` | 6 `InvalidAmount` | 6 `UnknownRegion` |
| 7 `ExpiryTooFar` | 7 `RegionFull` | 7 `UnknownCorridor` | 7 `RegionInactive` |
| 8 `TransferNotFound` | 8 `BondBelowMinimum` | 8 `InvalidThresholds` | 8 `RegionAlreadyOpen` |
| 9 `TransferNotPending` | 9 `AgentAlreadyRegistered` | 9 `TransfersPaused` | 9 `AgentNotAuthorized` |
| 10 `TransferExpired` | 10 `AgentNotRegistered` | 10 `AttestationMissing` | 10 `InsufficientCollateral` |
| 11 `TransferNotExpired` | 11 `InsufficientBond` | 11 `AttestationExpired` | 11 `UtilizationCapExceeded` |
| 12 `InvalidClaimCode` | 12 `BondLockedWhileAuthorized` | 12 `AttestationRevoked` | 12 `InsufficientLiquidity` |
| 13 `AgentNotAuthorized` | 13 `InvalidStatusTransition` | 13 `TierTooLow` | 13 `InsufficientShares` |
| 14 `ComplianceRefused` | 14 `BondTokenMismatch` | 14 `DailyLimitExceeded` | 14 `RepaymentExceedsExposure` |
| 15 `ComplianceCallFailed` | 15 `RegionAlreadyExists` | 15 `InvalidExpiry` | 15 `ZeroShares` |
| 16 `RegistryCallFailed` | 16 `SlashExceedsBond` | 16 `Overflow` | 16 `InvalidConfig` |
| 17 `FeeTooHigh` | 17 `UnknownCorridor` | 17 `EscrowNotSet` | 17 `RegistryCallFailed` |
| 18 `InvalidConfig` | 18 `InvalidAdmin` | | 18 `Overflow` |
| 19 `Overflow` | 19 `Overflow` | | |
| 20 `SenderCannotClaim` | | | |

Note the operational distinction between `ComplianceRefused` (a policy outcome the
sender can act on) and `ComplianceCallFailed` (the gate could not be reached,
which is an incident). The backend maps them to different HTTP statuses for the
same reason — see [api.md](api.md#errors).
