# Event catalogue

Every contract emits a leading topic symbol plus identifiers, with the payload in
the event value. Soroban filters events by **topic**, not payload, so the layout
is topic-first by design: the indexer can subscribe to one contract and one topic
symbol and get exactly the events it needs.

```
(topics)  = ( topic_symbol, subject_1, subject_2 )
(value)   = payload tuple
```

- [Why the topic layout looks like this](#why-the-topic-layout-looks-like-this)
- [`RemitEscrow`](#remitescrow)
- [`AgentRegistry`](#agentregistry)
- [`ComplianceHook`](#compliancehook)
- [`LiquidityPool`](#liquiditypool)
- [Decoding policy](#decoding-policy)
- [Two events that deliberately do not exist](#two-events-that-deliberately-do-not-exist)

Backend topic constants live in `backend/src/config/constants.ts` as
`EVENT_TOPICS`; the decoder that maps them to internal kinds is
`backend/src/event-indexer/decoder.ts`.

---

## Why the topic layout looks like this

Two properties matter more than completeness:

1. **Topic-first.** `getEvents` supports topic filters and not payload filters.
   Putting the kind first means a consumer that only cares about claims reads
   `tr_claim` and nothing else.
2. **Everything needed to reconcile, nothing needed to deanonymise.** Amounts,
   transfer ids, addresses and the claim hash are all present. The claim code and
   the recipient's identity are not, and never were on-chain.

A third property is deliberate and visible in the payloads: identifiers appear
**twice**, in the topic tuple and again in the payload where it helps. Topics make
an event findable; payload fields make it self-contained once found, so a
reindexed event can be projected without joining against a second query.

---

## `RemitEscrow`

### `tr_create` — funds locked and a claim hash committed

| | |
| --- | --- |
| Topics | `tr_create`, `sender: Address`, `corridor_id: Symbol` |
| Value | `(id: u64, amount: i128, token: Address, claim_hash: BytesN<32>, expiry: u64)` |

`claim_hash` is emitted so a watcher can independently confirm, at claim time,
that the reveal an agent presented hashed to what the sender committed. That is
what makes the commit-reveal scheme verifiable by a third party rather than only
by the contract.

### `tr_claim` — settled to an agent

| | |
| --- | --- |
| Topics | `tr_claim`, `agent: Address`, `corridor_id: Symbol` |
| Value | `(id: u64, gross: i128, fee: i128, payout: i128)` |

`payout` is net of the platform fee. All three amounts are present rather than
just the payout, because an agent reconciling its cash drawer needs the gross it
received and the fee it paid to be separately auditable.

### `tr_refnd` — expired transfer returned to its sender

| | |
| --- | --- |
| Topics | `tr_refnd`, `sender: Address`, `corridor_id: Symbol` |
| Value | `(id: u64, amount: i128)` |

Emitted regardless of who triggered the refund, which is why the refund is
permissionless: the event records the sender, not the caller.

### `tr_cncl` — sender withdrew an unclaimed transfer

| | |
| --- | --- |
| Topics | `tr_cncl`, `sender: Address`, `corridor_id: Symbol` |
| Value | `(id: u64, amount: i128)` |

### `esc_cfg` — configuration changed

| | |
| --- | --- |
| Topics | `esc_cfg`, `tag: Symbol` |
| Value | `(fee_bps: u32, paused: bool, max_expiry_secs: u64)` |

One topic with a tag rather than four separate events: the console renders all of
them in the same configuration-audit timeline, and a consumer that needs the
detail reads the payload. `tag` carries which control changed.

### `esc_wire` — cross-contract address changed

| | |
| --- | --- |
| Topics | `esc_wire`, `tag: Symbol` |
| Value | `address: Address` |

Worth an explicit event because re-pointing the registry or compliance hook is
the escrow's sharpest operational control: it is both an upgrade path and an
incident-response action, and it should never be invisible in the log.

### `esc_adm` — operator key rotated

| | |
| --- | --- |
| Topics | `esc_adm`, `previous: Address` |
| Value | `next: Address` |

---

## `AgentRegistry`

### `agent_reg` — bond posted, entered as `Pending`

| | |
| --- | --- |
| Topics | `agent_reg`, `agent: Address`, `region_id: Symbol` |
| Value | `bond: i128` |

### `agent_st` — lifecycle state changed

| | |
| --- | --- |
| Topics | `agent_st`, `agent: Address`, `region_id: Symbol` |
| Value | `(from: AgentStatus, to: AgentStatus, reason: Symbol)` |

`reason` is the operator's own tag (`approved`, `fraud`, `underwater`, …) — a
symbol rather than free text, so the indexer can group by cause. `underwater` is
worth calling out: an agent can be auto-suspended when a slash leaves it unable to
cover its outstanding draw.

### `bond_up` / `bond_down` — collateral added or withdrawn

| | |
| --- | --- |
| `bond_up` topics | `bond_up`, `agent: Address` |
| `bond_up` value | `(amount: i128, new_bond: i128)` |
| `bond_down` topics | `bond_down`, `agent: Address` |
| `bond_down` value | `(amount: i128, new_bond: i128)` |

The resulting bond is in the payload so a read model is not required to maintain
its own running total just to answer "what is this agent's bond now".

### `slash` — bond confiscated

| | |
| --- | --- |
| Topics | `slash`, `agent: Address`, `reason: Symbol` |
| Value | `(requested: i128, recovered: i128)` |

Both amounts are emitted, and they are not always equal: a slash capped by the
remaining bond recovers less than requested. Emitting only `requested` would let a
reader believe more was taken than actually was.

### `region` — region created or reconfigured

| | |
| --- | --- |
| Topics | `region`, `region_id: Symbol` |
| Value | `(min_bond: i128, active: bool)` |

### `corridor` — corridor mapped to a region

| | |
| --- | --- |
| Topics | `corridor`, `corridor_id: Symbol` |
| Value | `region_id: Symbol` |

### `admin` — operator key rotated

| | |
| --- | --- |
| Topics | `admin`, `previous: Address` |
| Value | `next: Address` |

---

## `ComplianceHook`

### `kyc_pub` — attestation published or refreshed

| | |
| --- | --- |
| Topics | `kyc_pub`, `subject: Address` |
| Value | `(tier: KycTier, attestation_hash: BytesN<32>, provider_id: Symbol, expires_at: u64)` |

Note what is absent: no name, no document reference, no provider payload. Only the
subject's address, a tier, an opaque hash and an expiry. `provider_id` records
which provider issued it, so a migration from one provider to another is visible
in the event history rather than silent.

### `kyc_rev` — attestation revoked

| | |
| --- | --- |
| Topics | `kyc_rev`, `subject: Address` |
| Value | `reason: Symbol` |

Kept separate from `kyc_pub` rather than expressed as a status flag, so a
sanctions hit is unmissable in the log. Someone scanning the compliance feed for
a single symbol will find every revocation.

### `kyc_tier` — corridor tier rules changed

| | |
| --- | --- |
| Topics | `kyc_tier`, `corridor_id: Symbol` |
| Value | `(tier1_max: i128, tier2_max: i128, daily_limit: i128)` |

### `kyc_oper` — attester key granted or revoked

| | |
| --- | --- |
| Topics | `kyc_oper`, `operator: Address` |
| Value | `allowed: bool` |

### `kyc_paus` — compliance enforcement paused or resumed

| | |
| --- | --- |
| Topics | `kyc_paus` |
| Value | `paused: bool` |

No subject in the topic tuple: this is a contract-wide state, not an entity event.

### `kyc_escr` — the escrow allowed to commit volume was set or rotated

| | |
| --- | --- |
| Topics | `kyc_escr` |
| Value | `escrow: Address` |

### `kyc_comm` — transfer passed the gate and volume was committed

| | |
| --- | --- |
| Topics | `kyc_comm`, `sender: Address`, `corridor_id: Symbol` |
| Value | `(amount: i128, tier: KycTier, new_daily_total: i128)` |

The running total is in the payload so a sender-facing app can show "you have X
left today" from the event stream without a contract read.

---

## `LiquidityPool`

### `lp_region` — pool opened or reconfigured

| | |
| --- | --- |
| Topics | `lp_region`, `region_id: Symbol` |
| Value | `(utilization_cap_bps: u32, active: bool)` |

### `lp_dep` — liquidity provided

| | |
| --- | --- |
| Topics | `lp_dep`, `provider: Address`, `region_id: Symbol` |
| Value | `(amount: i128, shares: i128, total_deposited: i128)` |

Shares as well as amount: this is the event that lets an off-chain read model
reconstruct a depositor's share balance without re-deriving the share price.

### `lp_wdraw` — shares redeemed

| | |
| --- | --- |
| Topics | `lp_wdraw`, `provider: Address`, `region_id: Symbol` |
| Value | `(shares: i128, amount: i128, total_deposited: i128)` |

### `lp_draw` — agent drew float against its bond

| | |
| --- | --- |
| Topics | `lp_draw`, `agent: Address`, `region_id: Symbol` |
| Value | `(amount: i128, exposure: i128, utilization_bps: u32)` |

The agent's resulting exposure and the region's resulting utilization are both in
the payload. That is what the agent-liquidity service watches to decide when to
raise a `COLLATERAL_TIGHT` or `POOL_UTILIZATION_HIGH` alert — without them it
would need a follow-up read per event.

### `lp_repay` — agent returned float

| | |
| --- | --- |
| Topics | `lp_repay`, `agent: Address`, `region_id: Symbol` |
| Value | `(amount: i128, exposure: i128)` |

### `lp_cfg` — configuration changed

| | |
| --- | --- |
| Topics | `lp_cfg`, `tag: Symbol` |
| Value | `(collateral_ratio_bps: u32, paused: bool)` |

### `lp_wire` — registry used for bond checks changed

| | |
| --- | --- |
| Topics | `lp_wire` |
| Value | `registry: Address` |

### `lp_admin` — operator key rotated

| | |
| --- | --- |
| Topics | `lp_admin`, `previous: Address` |
| Value | `next: Address` |

---

## Decoding policy

`decodeEvent` refuses to guess, and that is a deliberate design choice rather than
an oversight:

- **Unknown topic → `UndecodableEventError`.** Not a warning. An unknown topic
  means the contract was upgraded without the indexer, and continuing would
  silently drop events from the read model that the API then reports as "no such
  transfer". Failing loudly turns a wrong answer into a fixable gap.
- **Malformed payload → `UndecodableEventError`.** A silently-defaulted
  `amount: 0` in a remittance ledger is far worse than an indexing gap.
- **Unknown *kind*, known topic → payload preserved verbatim.** Configuration
  events (`esc_cfg`, `lp_cfg`, `kyc_tier`, …) pass through as a normalised
  `{ value }` payload. Losing the shape of a config change is survivable; guessing
  at one is not.

Typed extraction applies to the events a projection depends on. For those, the
decoder enforces both arity (`asTuple`) and type (`asBigInt`), and `asBigInt`
accepts only `bigint`, an integral `number`, or a decimal string — it will not
coerce a boolean or a float into an amount.

### Ordering and the cursor

`ChainEvent` is unique on `(contractId, ledger, eventIndex)`, and `IndexerCursor`
advances only after both persistence and projection succeed. A crash at any point
means the same window is re-read on restart, and reprocessing is safe. This is the
property that makes the read model rebuildable: `Transfer` and the other
projections are derived from `ChainEvent`, not the other way round.

---

## Two events that deliberately do not exist

**`transfer_refused`** (compliance) and **`draw_rejected`** (pool) are absent, and
neither is an oversight.

A refusal returns a typed error, which reverts the invocation, and Soroban
discards *both* state writes and events from a reverted invocation. Logging
refusals on-chain would require committing a write on every rejected attempt —
handing anyone a cheap way to bloat the ledger with failed calls.

Refusals are recorded off-chain instead:

| Refusal | Recorded by | How the console explains it |
| --- | --- | --- |
| Compliance | backend, observing the typed `ComplianceError` | `explain_transfer` returns a `TransferDecision` with a stable `reason_tag` |
| Draw | backend, observing the typed `LiquidityError` | `required_bond_for` is a pure read, so it is callable *on* the failing path |

That last point is the important one: the information a user needs about a refusal
is available from a read, so no event is required to surface it. The same
reasoning is why `LiquidityPool` has no `rejected_draws` counter — see
[contracts.md](contracts.md#why-there-is-no-rejected_draws-counter).
