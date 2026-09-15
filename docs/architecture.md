# Architecture

RemitBridge is four Soroban contracts, a Node service, and two clients. This
document explains what each piece owns, what crosses which boundary, and why the
seams are where they are.

- [The shape of the system](#the-shape-of-the-system)
- [Contract layer](#contract-layer)
- [Why `contracts/interfaces` exists](#why-contractsinterfaces-exists)
- [Backend](#backend)
- [Clients](#clients)
- [End-to-end flows](#end-to-end-flows)
- [Where the boundaries are](#where-the-boundaries-are)
- [Data flow through the indexer](#data-flow-through-the-indexer)
- [Deployment topology](#deployment-topology)

---

## The shape of the system

```
                    ┌──────────────────────────────────────────┐
   browser ────────▶│ admin-web (Next.js server components)    │
                    │  reads + proxies mutations, server-side   │
                    └───────────────┬──────────────────────────┘
                                    │
   phone ─────────────────────────┐ │
   (sender / recipient / agent)   │ │
                                  ▼ ▼
                    ┌──────────────────────────────────────────┐
                    │ backend (Express, strict TypeScript)      │
                    │  kyc · liquidity · quoting · transfers    │
                    └───┬───────────────┬──────────────────┬───┘
                        │               │                  │
                  ┌─────▼─────┐   ┌─────▼──────┐    ┌──────▼──────┐
                  │ Postgres  │   │ Soroban RPC│    │ KYC provider│
                  │ read model│   │ simulate → │    │ (plugged,   │
                  │ + PII     │   │ submit     │    │  mocked)    │
                  └─────▲─────┘   └─────┬──────┘    └─────────────┘
                        │               │
                 ┌──────┴──────┐        │
                 │ event-index │        │
                 └──────▲──────┘        │
                        │               ▼
                        │      ┌──────────────────────────────────┐
                        └──────│ Stellar / Soroban                 │
                               │  RemitEscrow ──▶ AgentRegistry    │
                               │       │  └────▶ ComplianceHook    │
                               │       └────────▶ LiquidityPool     │
                               └──────────────────────────────────┘
```

Two rules shape everything else:

1. **The chain is the system of record for money.** Postgres is a *projection* of
   chain state plus the PII the chain must not hold. Nothing in the backend is
   authoritative over a balance.
2. **Reads never block on the chain.** Every sender-facing read comes from the
   indexer's projection, and the response says how stale it might be.

---

## Contract layer

| Contract | Owns | Called by |
| --- | --- | --- |
| `RemitEscrow` | Transfer custody and the commit-reveal state machine | Sender, agent, anyone (refund), backend, mobile |
| `AgentRegistry` | Bonds, authorization, regions, corridor mapping, slashing | Operator, escrow (read), pool (read) |
| `ComplianceHook` | Tier bands, attestation hashes, rolling daily volume | Operator, attester, escrow |
| `LiquidityPool` | Regional float, shares, draws against bonds | Liquidity providers, agents, operator |

### Cross-contract call graph

```
RemitEscrow.create_transfer
  └─▶ ComplianceHook.check_transfer_allowed(sender, amount, corridor)
  └─▶ ComplianceHook.commit_transfer(sender, amount, corridor)   [after funds move]

RemitEscrow.claim_transfer
  └─▶ AgentRegistry.is_authorized_for_corridor(agent, corridor)

LiquidityPool.draw_liquidity
  └─▶ AgentRegistry.is_authorized(agent, region)
  └─▶ AgentRegistry.get_bond(agent)
```

Nothing calls the escrow or the pool: they are entry points, not services. That
asymmetry is the reason `interfaces/src/escrow.rs` and
`interfaces/src/liquidity.rs` carry no `#[contractclient]` attribute and the
other two do.

### Checks-effects-interactions

`create_transfer` runs in a deliberate order — validate cheap inputs, ask the
compliance gate, move funds, commit daily volume, then persist. If the gate
refuses, no token was touched. The two compliance calls are split rather than
fused into one because the *check* must be a pure function (so the sender app can
simulate it read-only) while the *commit* mutates the rolling daily bucket. Both
happen inside one transaction, so a failure in either reverts the whole thing.

`claim_transfer` flips the record to `Claimed` in the same invocation that pays
out, which is what makes it idempotent: a second call fails with
`TransferNotPending` rather than paying twice. There is no window in which a
transfer is both pending and paid.

### Pausing is asymmetric on purpose

Every contract can be paused, and no pause traps funds:

| Contract | Pausing blocks | Pausing still allows |
| --- | --- | --- |
| `RemitEscrow` | New transfers | **Claims and refunds** |
| `LiquidityPool` | Deposits, withdrawals, draws | **Repayments** |
| `ComplianceHook` | All checks | Reads, so the console can explain the outage |
| `AgentRegistry` | — (no contract-wide pause) | Everything; regions are switched off individually |

A pause is an incident-response tool, not a custody tool. If pausing could stop
claims or refunds, the operator key would become the most valuable key in the
system, which is exactly what the design avoids.

---

## Why `contracts/interfaces` exists

The contract crates originally depended on each other for their types: the escrow
imported `AgentRegistry`'s `AgentStatus`, the pool imported the registry's
`RegionConfig`. That works in Rust and is standard practice — and it produces an
undeployable artifact.

Soroban exports every `#[contractimpl]` function in a compiled crate as a Wasm
entry point. When the escrow crate linked the registry crate, the escrow's Wasm
exported the registry's entire ABI as well. Two consequences:

- The artifact is rejected or misbehaves on install, because entry points collide.
- The failure surfaces **at deploy time**, on a network, after the artifact has
  already been built and trusted by CI.

The fix is a third crate, `contracts/interfaces`, marked `rlib`-only and
containing nothing but the shared `#[contracttype]` structs, `#[contracterror]`
enums, traits and `#[contractclient]` declarations. The three `cdylib` crates
depend on it and not on each other. The traits are implemented by both sides, so
a signature change in `AgentRegistryInterface` is a compile error in the escrow
rather than a runtime surprise.

CI now asserts the property directly: `.github/workflows/contracts.yml` reads
each built artifact's export table and fails if an artifact exports a function it
does not own.

---

## Backend

Four services in one process, each in its own directory with its own router.

### `kyc-orchestration`

Exposes `IdVerificationProvider` — a provider-shaped interface (`submit`,
`poll`, `verifyWebhookSignature`, `parseWebhook`, capability flags) — and ships a
deterministic mock implementing every branch: approve, refer, reject, and
provider error. The service maps the provider's verdict onto a tier, computes
`sha256` of the signed payload, and publishes **only that hash** to the
`ComplianceHook` via a Soroban transaction.

The mock is deliberately not a rubber stamp. A mock that always approves never
exercises the paths that matter in a compliance product, so the test suite drives
each outcome explicitly.

### `agent-liquidity`

Reads agent exposure from the projection, classifies float health into
`FLOAT_LOW`, `COLLATERAL_TIGHT` and `POOL_UTILIZATION_HIGH`, and raises alerts.
Top-ups are **proposed, decided and executed as three separate operations**: a
human approves, a machine executes, and the audit log records both. Collapsing
them would let an automated sweep move float that nobody approved.

### `quoting-service`

Produces signed, timestamped, single-use quotes. `PriceSource` is pluggable; the
bundled implementation is static config and labels every quote it produces
`oracleSource: "static-config"`, because a rate with no provenance is
indistinguishable from a stale one. Quotes are signed with an ed25519 key so a
client can prove after the fact that the rate it was shown is the rate the
network quoted — and `POST /quotes/verify` lets someone who does not hold the key
check that claim.

### `event-indexer`

Separate process, its own entry point. Polls Soroban RPC, decodes, stores raw,
projects, and only then advances its cursor. See
[Data flow through the indexer](#data-flow-through-the-indexer).

### Wire format for money

`bigint` internally, **strings on the wire**, `Decimal(39,0)` in Postgres, `i128`
on-chain. A JSON number is parsed as a double before any validation runs, so
amounts never appear as JSON numbers anywhere in the system. See
[assumptions.md](assumptions.md#4-amounts-are-strings-on-the-wire).

---

## Clients

**`admin-web`** is a Next.js app whose pages are server components. They read the
backend from the Node process, and browser mutations go through an app-server
proxy route. The backend address never reaches a client bundle, and no API
credential is ever shipped to a browser.

**`mobile`** is an Expo app with three flows: sender, recipient, agent. It talks
to the backend over REST and holds the only two places a claim code exists — the
sender's screen and the agent's scan. The recipient never needs a wallet, which
is the entire point of the agent network.

Wallet access goes through a `WalletAdapter` interface; the shipped
implementation is a local keypair adapter, and Freighter/xBull/Wallets Kit
implement the same interface without touching call sites.

---

## End-to-end flows

### Create

```
sender app          backend                   chain
    │                  │                        │
    ├─ POST /quotes ──▶ │                        │
    │ ◀── signed quote ─┤                        │
    ├─ POST /kyc/preflight ▶                     │
    │ ◀── requiredTier ──┤                       │
    │                  ├─ (if needed) publish attestation hash ──▶ ComplianceHook
    │ generate code    │                        │
    │ sha256(code)     │                        │
    ├─────────────── create_transfer ──────────────────────────▶ RemitEscrow
    │                  │                        ├─ check_transfer_allowed ▶ ComplianceHook
    │                  │                        ├─ transfer tokens in
    │                  │                        └─ commit_transfer ▶ ComplianceHook
    │ ◀──────── transfer_id, expiry ────────────────────────────┤
```

### Claim

```
recipient          agent app              chain              indexer
   │                  │                    │                   │
   ├─ shows code ────▶ │                    │                   │
   │                  ├─ sha256(code) == stored hash? (local)   │
   │                  ├──── claim_transfer ─▶ RemitEscrow       │
   │                  │                    ├─ is_authorized ──▶ AgentRegistry
   │                  │                    └─ pay settlement address
   │ ◀── cash ────────┤                    │                   │
   │                  │                    └─ tr_claim event ──▶ Transfer.CLAIMED
```

The agent's local `sha256` check before submitting is a UX affordance, not
security: it saves a failed transaction and tells the agent immediately that the
code is wrong. The contract re-verifies regardless.

### Refund

```
anyone ── refund_expired(transfer_id) ──▶ RemitEscrow
                                            ├─ require expired
                                            ├─ require still Pending
                                            └─ pay the *recorded sender*
```

Permissionless by design. The sender may be unreachable, and a refund that
required operator action would be a refund an operator could withhold — while the
destination is fixed on-chain, so a third-party caller cannot redirect it.

---

## Where the boundaries are

| Boundary | What crosses it | Why it is here |
| --- | --- | --- |
| App → backend | REST/JSON, amounts as strings | Same language on both sides; strict schemas catch drift |
| Backend → chain | Signed Soroban transactions | The backend never holds a user's key; it submits what the user authorized |
| Backend → Postgres | PII, provider references, projections | Retention and access control are enforceable here and nowhere on a ledger |
| Chain → backend | Contract events only | The chain's outbound interface is one-way and public |
| App → browser | Nothing but rendered HTML | No backend address, no credential, no key in any client bundle |
| Sender → recipient | A 32-character code, out of band | The user picks the channel; the system is not in the path |

**Nothing writes to the chain except through a transaction whose authorization
was granted by the key that owns the funds or the role.** The backend constructs
transactions and simulates them; it does not submit on behalf of an address whose
secret it does not have. In the mobile sender flow the signature is produced by
the wallet adapter.

---

## Data flow through the indexer

```
RPC getEvents ─▶ RawContractEvent ─▶ decodeEvent ─▶ ChainEvent row (raw + decoded)
                                          │
                                          ├─ unknown topic  ─▶ UndecodableEventError
                                          └─ bad payload    ─▶ UndecodableEventError
                                                    │
                                    project ────────┘
                                       │
                                       ├─ Transfer upsert
                                       ├─ Agent / Region / Corridor upsert
                                       ├─ AgentExposure
                                       └─ LiquidityPoolSnapshot
                                                    │
                                          advance IndexerCursor
```

The ordering is the important part. Raw events are persisted **before**
projection, and the cursor advances **after** both. A crash at any point means the
same window is re-read on restart; because `ChainEvent` is unique on
`(contractId, ledger, eventIndex)` and projections are upserts, re-processing is
safe. That property is what makes the projection rebuildable from scratch —
`ChainEvent` is not a cache of the `Transfer` table, it is the source the
`Transfer` table is derived from.

`decodeEvent` refuses to guess. An unknown topic or an unexpected payload shape
raises `UndecodableEventError` rather than writing a partially-populated row,
because a silently-defaulted `amount: 0` in a remittance ledger is far worse than
an indexing gap someone has to fix. An unknown topic specifically means the
contract was upgraded without the indexer, and continuing would drop events the
API then reports as "no such transfer".

See [events.md](events.md) for the full topic catalogue.

---

## Deployment topology

```
contracts      → Stellar Testnet         scripts/  (deploy → initialize → wire → verify)
backend + db   → Railway / Render / Fly   docker compose, or backend/Dockerfile
admin-web      → Vercel                   admin-web/vercel.json
mobile         → EAS Build                mobile/eas.json
```

All four contract instances deploy **before** any is initialized. A failure
mid-way then leaves four unused instances rather than live contracts pointing at
zero addresses, which is the difference between a retry and an incident.

`deployed-addresses.json` is written by the deploy script, gitignored, and refuses
to overwrite an existing file.

See [deployment.md](deployment.md) and [runbook.md](runbook.md).
