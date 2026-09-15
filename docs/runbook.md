# Runbook

What to do when something in a RemitBridge deployment is wrong. Written for the
person on call, not for the person who built it.

Two rules apply to everything below.

1. **Pausing is safe; unpausing is the risky direction.** Every pause control in
   this system is asymmetric on purpose, and has been verified by test. Reach for
   a pause before you reach for anything else.
2. **Read before you write.** Every diagnosis below starts with a read function
   that is safe to call at any time, from any state. Nothing you do to gather
   information can make an incident worse.

---

## First: which layer is broken?

| Symptom | Start here |
| --- | --- |
| Recipients cannot collect cash anywhere | [Escrow: claims failing](#escrow-claims-failing) |
| One agent cannot collect cash | [Agent: cannot claim or draw](#agent-cannot-claim-or-draw) |
| Transfers refused at creation across corridors | [Compliance: everything refused](#compliance-everything-refused) |
| Transfers refused in one corridor only | [Compliance: one corridor](#compliance-one-corridor-refused) |
| Agents cannot draw float | [Pool: draws failing](#pool-draws-failing) |
| Console shows stale or empty data | [Indexer: lagging](#indexer-lagging) |
| Nothing is reachable | [Backend: down](#backend-down) |

---

## Backend down

```bash
curl -s localhost:4000/healthz   # process alive
curl -s localhost:4000/readyz    # dependencies reachable
```

`/readyz` reports the four contract ids the process is **actually** wired to.
Compare them against `scripts/deployed-addresses.json`. A redeploy that left one
service pointing at a stale contract id is the most common cause of "the chain
says one thing and the console says another", and `/readyz` is the fastest way to
see it.

If the process is up but `/readyz` reports Postgres unreachable, the API's
read paths will still serve `/healthz` and `/openapi.json`. Money-moving routes
will fail loudly. This is the intended behaviour: fail closed, visibly.

**Container deployments.** The entrypoint applies the schema before starting. If
it exits immediately, check the log for a missing `prisma/migrations/` directory
warning — the repository does not ship an initial migration (see
`docs/assumptions.md`), so deployments rely on `prisma db push`.

---

## Escrow: claims failing

Read first — none of these mutate anything:

```
get_transfer(transfer_id)          -> full record: status, amount, expiry, claim_hash
is_authorized(agent, region_id)    -> the registry's answer, not the escrow's
explain_transfer(sender, amount, corridor_id)
```

Then match the typed error to the cause. The escrow maps each failure to a
contract error code; `docs/contracts.md` has the full table.

| Error | Meaning | Action |
| --- | --- | --- |
| `TransferNotPending` | Someone claimed, refunded or cancelled it. Idempotency is working as designed. | Check `tr_claim` / `tr_refnd` / `tr_cncl` in the event log for the actor and time. |
| `InvalidClaimCode` | The code the agent holds does not hash to `claim_hash`. | The code is wrong, not the contract. Reissue the claim code through the sender. |
| `TransferExpired` | Past `expiry`. | `refund_expired` is permissionless — anyone can unwind it, and funds can only go to the sender. |
| `AgentNotAuthorized` | Registry says no. | See [Agent: cannot claim](#agent-cannot-claim-or-draw). |
| `SenderCannotClaim` | The sender tried to settle their own transfer. | Not a fault. Route it to an agent. |
| `Paused` | Escrow creation is paused. | Claims and refunds still work, so this cannot be blocking a claim. Check something else. |
| `ComplianceCallFailed` / `RegistryCallFailed` | A cross-contract call failed. | Treat as an incident, not a refusal. Existing transfers are **not** trapped by this; see below. |

### An unreachable dependency is reported as an incident

`check_transfer_allowed` and `is_authorized` failing are surfaced as distinct
incident errors rather than as ordinary refusals. This matters operationally: a
refusal tells a sender to go and get verified, an incident tells them the network
is unwell. Telling a sender to obtain KYC because a dependency is down is a
support queue full of people who were sent to do the wrong thing.

### Pausing the escrow

```
set_paused(true)
```

Verified property: **pausing stops creation and never traps existing
transfers.** Claims and refunds keep working while paused. This is not a
convention — it is asserted by `pause_stops_creation_but_never_traps_existing_transfers`.

Therefore: if you are unsure whether a change is safe, pause the escrow. It is
the lowest-risk control in the system.

### Rewiring the compliance hook

```
set_compliance_hook(new_hook)
set_agent_registry(new_registry)
```

These exist for incident response: a hook with a faulty tier configuration can be
replaced without redeploying the escrow or migrating its state. Treat a wiring
change as a significant event — it emits `esc_wire`, it changes which rules
apply to every subsequent transfer, and it should be announced.

### Rotating the operator key

```
set_admin(new_admin)
```

The admin key is cold. Rotate it through `set_admin` from the current admin.

Note that there is **no public read for the admin address** — it lives in
instance storage and is not exposed on any of the four interfaces. Confirmation
is therefore indirect: each `set_admin` emits an `esc_adm` / `admin` / `lp_admin`
event carrying the transition, and the previous key will be rejected with
`Unauthorized` on its next privileged call. Read the events. The same function
exists on all four contracts with the same semantics, so a rotation that updates
three of four leaves one contract whose admin nobody controls — check all four
in the event log, not just the one you ran.

---

## Agent: cannot claim or draw

```
is_authorized(agent, region_id)                  -> registry
agent_exposure(agent, region_id)                 -> pool: outstanding draw
required_bond_for(agent, region_id, additional)  -> pool: bond needed
```

`required_bond_for` is a pure read, so it is callable on the failing path — which
is the whole point. It tells you the number the agent needs to reach *before* it
retries, instead of leaving the agent to guess.

Then read the agent's lifecycle state:

| State | Can claim? | Can draw? | Fix |
| --- | --- | --- | --- |
| `Pending` | No | No | `authorize_agent` (admin) |
| `Authorized` | Yes | Yes | — |
| `Suspended` | No | No | `authorize_agent` again, usually after a bond top-up |
| `Revoked` | No | No | Terminal. The agent re-registers with a fresh bond, or is not reinstated. |

There is no separate `reactivate_agent`: `authorize_agent` accepts both `Pending`
and `Suspended` and is the only path back to `Authorized`. It re-checks the
region's minimum bond, whether the region is active, and the region's agent cap,
so re-authorising is not a rubber stamp — an agent suspended for a thin bond will
be refused until the bond is topped up.

`Suspended` is often automatic: a slash that drops the bond below the region
minimum suspends the agent rather than leaving it authorized-but-underbonded.
Check `slash` events before assuming someone suspended it by hand.

**A revoked agent keeps its remaining bond.** Withdrawal is available after
revocation; slashing is what takes it away. Do not confuse "revoked" with
"confiscated".

---

## Compliance: everything refused

```
compliance_stats()      -> issued, revoked, committed, enhanced
list_corridors()        -> which corridors have tier config at all
```

If every corridor refuses, suspect the global pause first:

```
set_paused(false)
```

Then suspect the escrow wiring. `commit_transfer` accepts calls only from the
registered escrow; if the escrow was redeployed and the hook's `set_escrow` was
not updated, every creation fails with `NotEscrow`. This is a **fail-closed**
design: an unregistered caller is refused rather than trusted.

### Compliance: one corridor refused

```
get_tier_thresholds(corridor_id)
explain_transfer(sender, amount, corridor_id)
```

`explain_transfer` never errors, including for an unknown corridor, so it is
always safe to call and always gives a reason tag. It exists so that nobody has
to re-implement the tiering rules off-chain to answer "why was this refused" —
an off-chain reimplementation would drift from the contract, and the drift would
be invisible until it approved something the chain then rejected.

The `reason` field carries a short `Symbol` tag rather than the error variant, so
a client can branch on it without decoding an error code:

| Tag | Meaning |
| --- | --- |
| `no_corr` | No tier config for this corridor. Call `set_tier_thresholds`. |
| `kyc_need` | Sender has no attestation; the amount is above `tier1_max`. |
| `kyc_exp` | Validity window closed. Re-verify. |
| `kyc_rev` | Sanctions hit, chargeback or fraud. **Do not** re-issue without review. |
| `tier_low` | Amount is above `tier2_max`, so `Enhanced` is required. |
| `daily_cap` | Rolling daily ceiling reached. `remaining_daily` gives the headroom. |
| `paused` | Contract-wide compliance pause. |
| `bad_amt` | Zero or negative amount — a caller bug, not a policy outcome. |

`set_tier_thresholds` validates structure on write and rejects inverted bands and
a `daily_limit` below `tier2_max`. A rejected update is a configuration error,
not a contract fault.

### Revoking an attestation

```
revoke_attestation(attester, subject, reason)
```

Revocation is idempotent and counted once. It takes effect immediately:
a revoked attestation blocks even an otherwise-unverified transfer.

**The attester key is not the admin key** — by design. The compliance service
runs hot and is the most exposed component, so a compromise of it must not grant
threshold changes, unpausing or agent authorisation. If the attester key is
compromised, use `set_operator(attester, false)` to cut it off; the admin key
does that, and nothing the attester can do reverses it.

---

## Pool: draws failing

```
get_pool_health(region_id)
pool_state(region_id)
required_bond_for(agent, region_id, amount)
agent_exposure(agent, region_id)
```

`InsufficientCollateral` and `UtilizationCapExceeded` are deliberately separate
errors, and the distinction is the entire diagnosis:

| Error | Who can fix it | Fix |
| --- | --- | --- |
| `InsufficientCollateral` | The **agent** | Top up the bond. No amount of regional float helps. |
| `UtilizationCapExceeded` | The **operator** | The region is out of float. Raise the cap, or attract deposits. |
| `InsufficientLiquidity` | The **operator** | The pool's undrawn balance is exhausted. |
| `RegionInactive` | The operator | `set_region_active(region, true)` |
| `AgentNotAuthorized` | The operator | See the agent lifecycle table above. |
| `RegistryCallFailed` | Investigate | A cross-contract read failed. Fail-closed by design. |

`required_bond_for` gives the shortfall directly, so the agent's app can prompt
for a top-up instead of presenting a bare failure.

### Pausing the pool

```
set_paused(true)
```

Verified property: **deposits, withdrawals and draws stop; repayments keep
working.** Agents can always unwind exposure during an incident, including while
the pool is paused. That is the difference between pausing and freezing.

### Pausing one region instead of the pool

```
set_region_active(region_id, false)
```

Deactivating a region stops new business in it without changing any agent's
status. Use this when one corridor is unwell and the others are fine. A
deactivated region still lets existing exposures be repaid, for the same reason
the pool pause does.

### Raising liquidity

A region is thin because depositors have not funded it. Two levers, in order of
preference:

1. **Attract deposits** — `deposit_liquidity` takes shares at the current share
   price, so early depositors are not diluted by later ones. Accounting has been
   share-based since day one specifically so that routing settlement fees here
   later is not a migration.
2. **Raise the utilization cap** — `set_utilization_cap`. This is the depositors'
   protection, so raising it is a decision about *their* risk, not the agents'.
   The cap exists so a sudden recall of agent float cannot strand withdrawals.

Lowering the collateral ratio is also available and is usually the wrong move:
it makes every agent in the region more thinly bonded, and the region's fraud
exposure is set by that ratio.

---

## Indexer lagging

```sql
-- One cursor per contract, not one global cursor: the four contracts are
-- polled independently, so a slow one cannot hold the others back.
SELECT "contractId", "lastLedger", "lastEventId" FROM "IndexerCursor";

-- What is still pending, per contract.
SELECT e."contractId", count(*) AS pending
FROM "ChainEvent" e
JOIN "IndexerCursor" c ON c."contractId" = e."contractId"
WHERE e."ledger" > c."lastLedger"
GROUP BY e."contractId";
```

The indexer stores **raw events first, then projects them, then advances the
cursor**. This ordering is the reason a crash mid-batch is safe: nothing is
projected from an event that was not stored, and the cursor never claims more
progress than the read model actually reflects.

**Recovery.** Rewind the cursor and restart. Projections are rebuildable from the
raw `ChainEvent` rows, so a bad projection is repaired by resetting state rather
than by replaying the chain:

```sql
UPDATE "IndexerCursor"
SET "lastLedger" = <ledger> - 10
WHERE "contractId" = '<the contract to replay>';
```

Rewind to slightly *before* the suspected point of divergence, and only the
affected contract. `ChainEvent` writes are idempotent on replay, so re-processing
a handful of ledgers costs nothing.

**If the console shows stale data but the indexer is current**, the problem is
the projection, not the chain. Use the raw `ChainEvent` rows in the audit
timeline as the source of truth — they are the events the contracts actually
emitted, not an interpretation of them.

**If an event is being skipped as undecodable**, that is a decoder gap, not an
indexer fault. The decoder refuses to guess at payload shapes and refuses to
coerce untyped values into amounts. The `topic coverage` test in
`backend/tests/decoder.test.ts` exists to make this class of omission a red
build; if you are seeing it in production, a contract event was added without
teaching the indexer about it.

---

## Deliberate non-remedies

Things that look like missing safety controls and are not:

- **No admin-triggered refund.** `refund_expired` is permissionless and can only
  pay the original sender. An operator-withheld refund is a refund an operator
  can withhold.
- **No "approve a claim manually" path.** A claim verifies the reveal against the
  committed hash. An override would mean the code no longer has to be right.
- **No slashing without an admin.** Slashing is gated because it confiscates
  real capital; the gate is why it must be a cold key.
- **No unpause that also rewires.** Pause/unpause and wiring are separate
  invocations so that resuming service cannot silently change which rules apply.
