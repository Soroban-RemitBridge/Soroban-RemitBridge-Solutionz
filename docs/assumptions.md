# Assumptions and prior decisions

Every design in this repository was made in the absence of some information. This
document records those absences explicitly, so a contributor proposing a change
can tell the difference between "the author did not think of this" and "this was
chosen, and here is what it traded away".

It is deliberately not a list of things that are *wrong*. It is a list of things
that are *load-bearing*.

---

## Scope assumptions

### The operator is licensed; we are not

RemitBridge is infrastructure. It is not a money transmitter and does not claim
to be one. The entity running it holds the corridor licences, files the reports
and carries the regulatory relationship; the software provides the custody
mechanics, the agent network and the tiered-verification primitives.

**Consequence.** Nothing in the contracts enforces jurisdiction. There is no
corridor allowlist keyed to a licence, no geofencing, no reporting deadline
tracking. Adding those without knowing the operator's regime would be guessing at
a legal question, and a guess baked into an immutable ledger is worse than an
obvious gap. Regulatory review stays in the README's roadmap, not in the code.

### Recipients do not have wallets, and this is the product

The single most consequential product decision here is that **the recipient is
not a chain user**. They hold a claim code, show it to a person, and receive
cash. No seed phrase, no wallet install, no address.

**Consequence.** The claim code *is* the bearer instrument. Anyone holding it can
claim the transfer. This is not a limitation to be engineered away later — it is
the mechanism that makes the last mile work at all. The sender UI says so in
plain words, and the escrow's rustdocs do too.

If a future version adds wallet-based claiming, it must do so as an *additional*
path, never as a replacement. Replacing it would silently delete the users the
project exists to serve.

### A corridor is a `Symbol`, not a jurisdiction object

`corridor_id` and `region_id` are on-chain `Symbol`s. Human-readable names,
regulatory classifications and settlement-asset details live off-chain in the
`Region` and `Corridor` tables.

**Consequence.** Renaming a corridor off-chain is free; the on-chain identifier
must never be reused for a different corridor, because historical events would be
retroactively reinterpreted. That rule is stated in `docs/data-model.md` and is a
migration hazard, not a code hazard — nothing can enforce it at runtime.

---

## Contract assumptions

### The claim code is high-entropy and never reused

`create_transfer` stores `sha256(reveal)` and `claim_transfer` compares a supplied
`reveal` against it. Nothing on-chain bounds how many reveals an attacker may try,
so the security of the commit rests entirely on the code's entropy.

The mobile app generates 32 characters from a 32-symbol alphabet — 160 bits, and
exactly 32 bytes, so the code's UTF-8 bytes *are* the `BytesN<32>` reveal. A
future client that generated a shorter, human-chosen or server-assigned code
would weaken this to the point of breakage without changing a line of Rust.

**Consequence.** Any change to claim-code generation is a security change and
needs the same review as a change to the escrow. The comment on `lib/claim.ts`
says this next to the generator rather than here, because that is where someone
would actually be editing.

### `expiry` is the only time bound, and it is absolute

Transfers carry an absolute `expiry` (in ledger time). There is no grace period,
no operator-extendable deadline and no partial refund.

**Consequence.** A sender picks the window at creation, and the window is what
they get. An agent holding a claim code on the wrong side of expiry has no
recourse on-chain; that is a business problem (agent SLA, bond slashing) rather
than a contract problem. The refund path is deliberately permissionless, so an
expired transfer can always be unwound without operator cooperation — an
operator-triggered refund is a refund an operator can withhold.

### Bond capital is the anti-fraud deposit, and it is capped

An agent's bond is the only thing standing between the network and a
claim-and-vanish. It is also the ceiling on how much float the agent can draw,
via the pool's `collateral_ratio_bps` (150%).

**Consequence.** Bond economics and liquidity economics are the same dial. Raising
the collateral ratio makes agents safer to the network *and* makes the region
thinner. That coupling is intentional — it is stated here so that tuning one of
them is understood to move the other.

### One settlement token per pool

`PoolConfig` holds a single `token`. Bond-sufficiency comparison is therefore
like-for-like: registry bond units and pool draw units are the same asset.

**Consequence.** Multi-asset regions need either one pool per asset or an oracle
to compare across them. The roadmap lists this as a known limitation rather than
pretending the single-token assumption is free.

### The gate is readable for free, enforceable in one write

`check_transfer_allowed` performs no writes, so it is safe to call from read-only
simulation and from a sender app preflighting an amount. `explain_transfer` is
the same rule with the reasons attached. `commit_transfer` is the write path, and
it evaluates as well as records.

**Consequence.** The escrow makes one call, not two: the amount charged to the
day's ceiling is the amount the gate approved, and there is no path that commits
volume without enforcing. It is also cheaper — a second cross-contract
invocation, a second read of the thresholds and a second read of the bucket were
all removed from every transfer. It remains true that bypassing the hook would
bypass the daily ceiling entirely, which is why commitments are accepted only
from the registered escrow address and revert for any other caller.

### There is no `rejected_draws` counter

A refused draw returns a typed error, which reverts the invocation, and Soroban
discards state writes from reverted invocations. A counter incremented on the
failure path could therefore only ever read zero.

**Consequence.** Refusals are counted off-chain, where the backend observes the
typed error. The dashboard gets its collateral-versus-utilisation breakdown from
`required_bond_for`, which is a pure read and is therefore callable on the
failing path.

---

## Backend assumptions

### Money is `bigint` everywhere, and strings on the wire

`i128` on-chain, `bigint` in Node, `Decimal(39,0)` in Postgres, strings in JSON.
`applyBps` rounds down in the payer's favour.

**Consequence.** Any new endpoint that serialises an amount must serialise a
string. A JSON number is parsed as a double by both `JSON.parse` and every
browser before any validation runs, so an amount that arrives as a number has
already lost precision by the time the schema sees it. `no float` is a rule, not
a convention, and it is enforced by making the types disagree.

### There are two KYC providers, and the mock is one of them

`IdVerificationProvider` is shaped like a production provider — submit, poll,
webhook, structured verdicts — and it has two implementations.
`MockIdVerificationProvider` is deterministic and holds no external state.
`HttpIdVerificationProvider` (`KYC_PROVIDER=http`) makes real network calls against
a vendor's REST API, verifies webhook signatures with HMAC-SHA256, and refuses on
anything it cannot understand.

**Consequence.** The mock is still the one CI runs, and it exists to exercise
*branches*: approval, rejection, manual review, provider timeout, malformed
webhook. A mock that always approved would leave every interesting path untested,
which in a compliance product is precisely the wrong half to leave untested. The
HTTP adapter is the answer to "so what runs in production": it fails closed — a
non-2xx, a body outside the contract, an unknown outcome, a timeout or an
unsigned webhook all refuse rather than approve — and it never falls back to the
mock, because quietly downgrading a compliance check is how unverified transfers
ship under a production-looking config. `sumsub` and `onfido` remain valid values
for `KYC_PROVIDER` only so an existing config still validates; they resolve to a
named error rather than to a guess. Point the `http` adapter at the vendor.

### Only attestation *hashes* cross the on-chain boundary

The backend computes `sha256` of its canonical attestation payload and publishes
only that, plus tier, region, provider and expiry.

**Consequence.** The payload is the system of record for the underlying documents
and must be retained and access-controlled to the same standard as the documents
themselves. "No PII on-chain" shifts the obligation to the database; it does not
remove it. `docs/data-model.md` marks which tables carry PII for exactly this
reason.

### Quotes are HMAC-signed by the service that issued them

`signQuote` uses `createHmac('sha256', secret)` rather than an Ed25519
signature, because at this scope the verifier and the issuer are the same
service and an HMAC is a symmetric operation with the same integrity guarantee
for a single verifier.

**Consequence.** A third party — an agent verifying a quote, a court reviewing
one — cannot verify a quote without holding the signing secret. The signature
carries an `algorithm` field and the raw bytes go through one function, so
upgrading to `Keypair.sign` is a change to one call site plus a version bump in
the algorithm label. Until then, treat quote verification as an internal
control, not as evidence a counterparty can check independently.

### The price source is selected by configuration, and the placeholder announces itself

`PRICE_SOURCE=horizon` reads the Stellar DEX through Horizon's
`/paths/strict-send`, which returns the *executable* rate for a probe size
following whatever path the market uses. `PRICE_SOURCE=static`
(`StaticPriceSource`) labels every tick `static-config`, the label is stored on
the `Quote` row it produces and returned to the console. `PRICE_SOURCE` defaults to `static`,
because defaulting to a live network read would make a fresh clone's behaviour
depend on whether Horizon happens to be reachable.

**Consequence.** Two things are deliberately *not* solved. First, the DEX rate is
for `PROBE_AMOUNT` (100 units of the source currency), not a mid-market quote for
any size — a larger transfer gets a worse rate, which is true of the market
rather than of this code, and the probe is a constant rather than a per-request
parameter because letting a caller choose the probe would let a caller choose a
favourable print and settle a larger transfer at it. Second, Horizon prices
*assets*, not currencies, so a corridor whose destination currency has no entry
in `SDEX_ASSETS` cannot be priced and the source raises a named 503 naming the
missing currency — rather than inventing a rate. A static quote is never a real
market rate, and the label exists so nobody mistakes one for a feed.

### Rate limiting is in-process

The limiter holds counters in memory and is therefore per-replica.

**Consequence.** Behind three replicas, the effective limit is three times the
configured value. This is documented at the middleware rather than papered over;
a shared Redis limiter is the fix, and it is on the roadmap.

---

## Frontend assumptions

### The browser never talks to the backend directly

The console's route handlers read the API server-side and proxy mutations through
`/api/backend/*`. The `REMITBRIDGE_API_URL` value is not a `NEXT_PUBLIC_`
variable, so it does not exist in any client bundle.

**Consequence.** Mutations cost a round trip through the Next server, and the
console cannot be pointed at a different backend per browser session. In exchange
there is exactly one place the operator's session is verified and one place the
backend's address could ever be disclosed — and it is not disclosed to anyone who
opens devtools.

### Operator accounts are configuration, not an identity provider

The console authenticates (scrypt password hashes in `OPERATOR_ACCOUNTS`, an
HMAC-signed session cookie, an Edge `proxy.ts` gate) and authorises (five
permissions checked in the mutation route handler, with an unknown path refused
rather than forwarded). There is still no user table and no SSO.

**Consequence.** Onboarding or removing an operator is a deploy, and a session is
valid for its whole TTL because there is no store to revoke it from — rotating
`OPERATOR_SESSION_SECRET` ends every session at once, and that is the only lever.
That is why the TTL defaults to one shift. What this did fix is the part that
mattered for money: a credential is now required at all, and the record an action
produces carries the signed-in operator's own address, overwritten from the
session rather than taken from the request body. It is still marked `noindex` and
still belongs behind network-level access control as a second layer; the
difference is that the second layer is no longer the only one.

What attribution does *not* yet have is a single place to read it: `AuditLog` is
defined in the schema with no writer, so an action's actor is recoverable from
the row it changed, and actions that change no such row record no actor at all.

### Frontend correctness is mostly about refusal

The console's job is largely deciding what *not* to show: an unavailable backend
must not render as an empty list, and a failed mutation must not render as a
success. Those paths are covered by the type layer and the
`ErrorState`/`EmptyState` split.

**Consequence.** The console shipped with no component tests. That was a real
gap and it is recorded as one rather than described as a deliberate minimalism.
The pure modules that can be tested without a browser — formatting, money
display, response validation — now have unit suites, which is where the
high-value assertions live anyway.

---

## Operational assumptions

### No initial Prisma migration is committed

Generating `prisma/migrations/0001_init` requires a live database.
`prisma migrate dev` against a live database produces a migration whose SQL is
generated from the schema, and an invented, hand-written empty migration history
would be worse than admitting the gap: it would make `migrate deploy` look
available while having nothing to apply.

**Consequence.** Deployments run `prisma db push` through the container entrypoint
today. The entrypoint detects the absence of a migrations directory and warns
loudly. Generating and reviewing the initial migration is a roadmap item.

### The toolchain is pinned, and upgrading is deliberate

`rust-toolchain.toml`, `.nvmrc`, `Cargo.lock` and four `package-lock.json` files
are all committed.

**Consequence.** Reproducible builds, and a dependency bump that changes a
lockfile is a reviewable commit rather than an invisible drift. `Next.js 16` and
`Tailwind v4` were chosen together because Turbopack cannot resolve Tailwind v3's
internal asset paths; they move as a pair.

---

## What would falsify these

Cheap experiments that would tell you an assumption above is wrong:

| Assumption | What would show it |
| --- | --- |
| Claim codes are high-entropy | A client that generates codes from a smaller alphabet, or reuses one across transfers |
| Bond economics are a real deterrent | A corridor where expected fraud proceeds exceed the bond for a realistic claim volume |
| The mock exercises the real branches | A production provider whose verdict shape does not fit `VerificationOutcome` |
| No PII on-chain | A single field in any `#[contracttype]` struct that is not a hash, a counter or an identifier |
| The console proxies everything | A `NEXT_PUBLIC_` prefix on the API URL, or a `fetch` in a `'use client'` module |
