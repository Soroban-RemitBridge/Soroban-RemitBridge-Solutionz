# Data model

The database has two jobs and it is worth keeping them apart:

1. **Hold what the chain must not.** Names, provider references, travel-rule
   payloads. A ledger is append-only and world-readable, so this is the only place
   retention rules and access control can actually be enforced.
2. **Hold a projection of what the chain already knows.** Transfer state, agent
   bonds, pool snapshots — derived from `ChainEvent`, rebuildable from it.

See `backend/prisma/schema.prisma` for the authoritative definition.

- [Money is `Decimal(39,0)`](#money-is-decimal390)
- [PII tables](#pii-tables)
- [Configuration tables](#configuration-tables)
- [Agent tables](#agent-tables)
- [Projection tables](#projection-tables)
- [Audit](#audit)
- [Rebuildability](#rebuildability)
- [What is missing](#what-is-missing)

---

## Money is `Decimal(39,0)`

Every amount column is `Decimal @db.Decimal(39, 0)` — not `BigInt`, not
`numeric`, not a string.

Soroban amounts are `i128`, whose range is roughly ±1.7 × 10³⁸. Postgres
`BIGINT` tops out at 9.2 × 10¹⁸, so a single large transfer would be **silently
truncated** — the worst possible failure mode in a remittance ledger, because it
succeeds. `Decimal(39, 0)` holds the full range and preserves every digit.

The same reasoning runs through the whole system:

| Layer | Type | Why |
| --- | --- | --- |
| Contract | `i128` | Soroban's native integer |
| Backend | `bigint` | Exact, arbitrary precision |
| Postgres | `Decimal(39,0)` | Full `i128` range, unlike `BIGINT` |
| HTTP | decimal **strings** | A JSON number is parsed as a double before validation runs |
| Mobile | regex-formatted strings | `Number` would round a stroop total |

Prisma maps `Decimal` to a decimal type, so `transfer.amount.toString()` is the
exact integer with no path through a float.

---

## PII tables

### `User`

The sender's identity, plus optionally their Stellar address. `stellarAddress` is
nullable, and **recipients deliberately do not have one** — that is the entire
point of the agent network.

`email` and `phoneE164` are unique but nullable: a sender may enrol with neither
and identify by address alone.

### `KycAttestation`

```
id              uuid
userId          → User
tier            NONE | STANDARD | ENHANCED
providerId      which provider issued the verdict
attestationHash sha256 of the signed payload   ← the only value that reaches the chain
regionId        which region the check was performed for
status          PENDING | ACTIVE | EXPIRED | REVOKED
issuedAt / expiresAt / revokedAt
revokeReason
publishTxHash / revokeTxHash
providerRef     opaque provider reference
```

`attestationHash` is `@unique`, which makes a duplicate publish a database-level
error rather than a contract-level race.

`providerRef` is an opaque pointer rather than a copy of the provider's record:
an auditor can be *routed* to the source record without that record being
replicated into this database, where it would fall under a different retention
rule than the one it was collected under.

Indexed on `(userId, status)` for the "does this sender have a live attestation"
check, and on `expiresAt` for the expiry sweep.

---

## Configuration tables

### `Region`

`id` is the Soroban `Symbol` (`NG_LAG`), not a surrogate key — the chain and the
database identify a region the same way. `minBond` mirrors the registry's
configuration; `maxAgents = 0` means uncapped, matching the contract's own
convention.

### `Corridor`

`id` is `NGN_LAG`. Holds `tier1Max`, `tier2Max`, `dailyLimit` and `spreadBps`.

The tier bands are **mirrored** from the compliance hook, and the mirror is worth
justifying: the sender app needs to explain the requirement without a chain
round-trip, and a round-trip on every keystroke is not viable. The comment in the
schema is explicit that the contract remains the authority and that a mismatch is
reconciled by `syncCorridorConfig`. A mirror with a named reconciliation path is
honest; a mirror without one is a second source of truth waiting to diverge.

---

## Agent tables

### `Agent`

```
stellarAddress     unique — the key that signs claims
settlementAddress  where funds are actually released
legalName / tradingName
regionId           → Region
status             PENDING | AUTHORIZED | SUSPENDED | REVOKED
bondAmount         mirrors the on-chain bond
bondTxHash
slashCount         reconciliation counter
registeredAt / authorizedAt / suspendedAt / revokedAt
```

`settlementAddress` is separate from `stellarAddress` so an operator can rotate
keys without moving the on-chain record — the chain stores one address, and it is
the settlement one.

`slashCount` is a *reconciliation* counter, not an authority: it is derived from
`slash` events. A rise that the operator did not expect should trigger manual
review, which is exactly what a counter that can disagree with the chain is useful
for.

### `AgentExposure`

Float currently drawn per `(agent, region)`, unique on that pair. A small table
rather than a derived query because the liquidity service reads it on every sweep
and the aggregate is already maintained by `lp_draw` / `lp_repay` events.

### `AgentFloatAlert`

`kind` is `FLOAT_LOW`, `COLLATERAL_TIGHT` or `POOL_UTILIZATION_HIGH`, each
carrying the `thresholdBps` that fired and the `observedBps` that tripped it. Both
are stored rather than just the kind: "which threshold was this measured against"
is the first question when an alert looks wrong, and it is unanswerable after the
config changes if it was not recorded at the time.

### `LiquidityTopUpRequest`

`PENDING → APPROVED|REJECTED → EXECUTED|FAILED`, with `requestedBy`, `approvedBy`,
`decisionNote`, `txHash` and `failureReason` all retained.

The four states are the point: approval and execution are separate human and
machine steps, and the row has to show both — `requestedBy` is the operator who
proposed it and `approvedBy` the operator who decided, both written from the
session by the console rather than accepted from the request body. Collapsing the
steps would let an automated sweep move float that nobody approved, with no field
distinguishing it from an approved move.

---

## Projection tables

### `Transfer`

`id` is a `BigInt` primary key sourced from the chain, not a generated uuid. The
chain's transfer id is the only identifier that is meaningful in both systems, and
inventing a second one would require a mapping table that can drift.

Also holds `claimHash`, `createTxHash`, `settleTxHash` and the timestamps. Note
`events ChainEvent[]` — a transfer's on-chain timeline is queryable without a
second service call, which is what backs `GET /transfers/:id/status`.

Indexes match the four ways transfers are read: `(status, expiry)` for the
refundable sweep, `(corridorId, createdAt)` for corridor volume,
`(agentId, createdAt)` for the agent's history, `(senderId, createdAt)` for the
sender's.

### `ChainEvent`

The raw event log, and the source the other projections are derived from.

```
contractId, topic, ledger, eventIndex, txHash
payload      decoded JSON, for querying
rawXdr       original base64, when INDEXER_STORE_RAW_XDR is on
transferId   → Transfer, when the event concerns one
occurredAt, ingestedAt
```

`@unique([contractId, ledger, eventIndex])` is what makes reprocessing safe: the
indexer can re-read a window after a crash without duplicating rows, which is the
property that lets the cursor advance only after both persistence and projection
succeed.

`rawXdr` is retained optionally because it is the only artefact that lets a
*decoding* bug be diagnosed after the fact. Once a payload has been mis-decoded
and the row written, the original is the only evidence of what arrived.

### `IndexerCursor`

One row per contract: `lastLedger`, `lastEventId`. Uniquely keyed on `contractId`
because a shared cursor would let a slow contract hold up a fast one.

`GET /transfers` returns the cursor alongside the results, so a client can tell
"no results" apart from "the indexer has not caught up yet". Without it, a lagging
indexer looks exactly like a lost transfer.

### `LiquidityPoolSnapshot`

Point-in-time capture per region: `totalDeposited`, `totalDrawn`, `available`,
`utilizationBps`, `capturedAt`. Appended rather than upserted, because pool
history is what the dashboard's trend needs, and because a snapshot's value is
that it records what was true *then*.

### `Quote`

`midRate` and `clientRate` are rational **strings** (`"1532.4412"` NGN per USD),
never floats, so no floating-point rounding is baked into a financial record.
`signature` and `signingKey` are stored so a quote can be verified later even if
the signing key has since been rotated.

---

## Audit

`AuditLog` is the intended append-only store for who did what: `before` and
`after` are both `Json`, so a reviewer can see *what changed* rather than only
that something did, and `actorId` with `actorType` is the attribution.

It has **no writer yet**, and that is stated rather than implied: the model exists
in `prisma/schema.prisma`, and nothing in `backend/src` inserts a row into it.
What does exist is attribution on the rows an action produces: a float top-up
carries `requestedBy` and `approvedBy`, and the console's proxy **deletes both
fields from the request body and rewrites them from the verified session**, so
they name the operator who acted rather than whoever the browser claimed to be.
That is real per-person attribution, in the record it applies to.

**The remaining gap** is coverage: an action that writes no such row records no
actor at all, and there is no chronological view a reviewer can read across
actions. A single append-only write per state-changing action, with the session's
operator as `actorId`, is roadmap item 1's companion.

---

## Rebuildability

```
RPC ─▶ ChainEvent (raw, unique on contract+ledger+index) ─▶ projections ─▶ cursor advances
```

`Transfer`, `Agent`, `AgentExposure` and `LiquidityPoolSnapshot` are all derived
from `ChainEvent`. Dropping them and replaying the log reproduces the same state.
That is the property that makes a schema change survivable: a new column can be
backfilled by replay rather than by guesswork, and a projection bug is correctable
rather than permanent.

The tables that are **not** rebuildable are exactly the PII ones, and that
asymmetry is the point — no amount of chain data can reconstruct a passport
number, which is why compromisable copies of one are kept in as few places as
possible.

---

## What is missing

- **No `prisma/migrations/` directory.** Generating the initial migration needs a
  live database, and an invented empty migration history would be worse than
  admitting the gap. `backend/docker-migrate.sh` detects the absence and warns.
- **No row-level security.** Access control is at the application boundary. For a
  single-tenant operator deployment that is defensible; for a shared one it is
  not, and it is on the roadmap.
- **No retention or deletion job.** `expiresAt` and `revokedAt` exist so that one
  can be written, but nothing currently acts on them. See
  [runbook.md](runbook.md#data-retention).
