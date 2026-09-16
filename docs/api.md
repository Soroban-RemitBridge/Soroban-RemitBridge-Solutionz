# HTTP API

The backend's REST surface, its wire conventions, and its error contract.

The machine-readable document is served at **`GET /openapi.json`** and is the
source of truth for schemas. This page is the map: what exists, what it does, and
the conventions that are easy to get wrong.

---

## Conventions

**Base path.** Every application route is mounted under `/api/v1`. The three
operational routes are not:

| Route | Purpose |
| --- | --- |
| `GET /healthz` | The process is alive. Does not touch dependencies. |
| `GET /readyz` | Dependencies are reachable **and** reports which four contract addresses the process is actually wired to. |
| `GET /openapi.json` | The OpenAPI document. |

`/readyz` is the first thing to check when the console and the chain disagree —
see the [runbook](runbook.md).

**Money is a string.** Every amount, fee, rate and balance on the wire is a
decimal string, never a JSON number. `JSON.parse` produces a double before any
validation runs, so an amount sent as a number has already lost precision by the
time the schema sees it. See [ADR 0003](adr/0003-integer-money-end-to-end.md).

**Timestamps are ISO 8601 UTC strings.** Expiries derived from ledger time are
also exposed as ledger sequence or seconds where that is the authority, because a
ledger timestamp is not a wall clock.

**Request ids.** Every response carries `x-request-id`. An inbound `x-request-id`
of 8–64 word characters is honoured; anything else is replaced with a generated
one. The same value appears in every log line for the request, so quoting it is
the fastest way to get to the relevant logs.

**Rate limiting.** `/api/v1` is limited to 300 requests per minute per client, and
responses carry `x-ratelimit-remaining`. Exceeding it returns `429` with
`retry-after`.

**This limiter is in-process and therefore per-replica.** Behind three replicas
the effective budget is three times the configured value. It is sized to stop a
single client hammering a quote endpoint, not to be a security control.

**Timeouts.** A request that has not produced headers within 30 seconds is
terminated with `504`.

---

## Error contract

Every failure — validation, policy, dependency, internal — returns the same
shape:

```json
{
  "error": {
    "code": "MACHINE_READABLE_CODE",
    "message": "Human-readable, and safe to show a user.",
    "details": { "...": "optional, code-specific" },
    "requestId": "0f8c…"
  }
}
```

That uniformity is deliberate: a client can branch on `code` without inspecting
`message`, and no failure path has a shape the client has not seen.

| Status | `code` | Cause |
| --- | --- | --- |
| 400 | `MALFORMED_BODY` | Body is not valid JSON for its declared content type |
| 400 | `VALIDATION_FAILED` | Body parsed, but a field is missing or wrong. `details.issues` lists them |
| 404 | `NOT_FOUND` | No such route, transfer, agent or quote |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 1 MB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Content type the parser does not handle |
| 429 | `RATE_LIMITED` | Limit exceeded; `retry-after` is set |
| 504 | `TIMEOUT` | No response headers within 30 seconds |
| 5xx | `INTERNAL` | **Opaque by design** — see below |

**Malformed bodies are 4xx, not 5xx.** Before this was handled they fell through
to the generic handler and were reported as 500s, which is wrong twice: it tells
the client to retry something that will never succeed, and it buries real
server-side faults in a stream of client-input noise.

**Internal errors return an opaque body.** The parser's own message is not
forwarded, and neither is a stack trace. A stack trace from a service that holds
KYC documents and signing keys routinely contains a query whose parameters are a
name and a date of birth, and a 500 response is the single most likely place for
that to escape. The full error goes to the log with the request id — enough to
debug, not enough to leak.

---

## Transfers

Read from the Postgres read model that the event indexer maintains; the chain is
the authority, the read model is the queryable projection of it.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/transfers` | Sender-facing history. Filters: `senderId`, `corridorId`, `status`, `limit` (1–200, default 50). Ordered newest first. |
| `GET` | `/transfers/:id/status` | One transfer's lifecycle state. The recipient app and the agent app both poll this. |
| `GET` | `/transfers/:id/receipt` | Settlement detail for a claimed transfer: gross, fee, payout, settling agent, time. |
| `POST` | `/transfers/preflight` | **Pure check, no writes.** Returns the KYC tier this amount needs in this corridor and the remaining daily headroom. |

`preflight` is the endpoint the sender app calls before asking a sender to commit
to anything, and it is why the compliance gate's check is a separate pure
function on-chain ([ADR 0006](adr/0006-split-compliance-check-from-commit.md)).
It never errors for an unknown corridor — an unknown corridor is an answer, not a
failure.

**Reads never touch the chain on the request path.** A sender asking "where is my
money" must not get a 503 because an RPC node is having a bad minute, so these
routes read the indexed projection. The list response therefore carries an
`indexer: { lastLedger, updatedAt }` field, so a client can tell **"no results"
apart from "the indexer has not caught up yet"** — without it, a lagging indexer
reads as a lost transfer, which is the single worst thing this API could imply.

Creating a transfer is **not** an HTTP endpoint. The sender's wallet signs
`create_transfer` directly against the escrow, so the backend never custodies a
sender's key and a compromised backend cannot move a sender's funds.

---

## Quotes

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/quotes` | Produces a signed, time-boxed quote for a corridor and amount. |
| `GET` | `/quotes/:id` | Retrieves a stored quote. |
| `POST` | `/quotes/verify` | Verifies a quote's signature and its validity window. |

A quote carries `midRate`, `spreadBps`, `clientRate`, `fee`, `total`,
`oracleSource` and `validUntil`, plus a `signature`, an `algorithm` and the
`signingKey` that produced it. The algorithm is **labelled**, so a verifier can
refuse a signature it does not understand rather than mis-verify it — see
[ADR 0003](adr/0003-integer-money-end-to-end.md) for the money format and
`docs/assumptions.md` for why the signature is an HMAC and therefore an internal
control rather than something a third party can check.

`validUntil` is short — 45 seconds by default, configurable between 5 and 600.
The backend cannot read the rate between quoting and settling, so the window is
how long it is willing to carry that risk. **A stale quote is refused rather than
discounted**: a rate tick older than 60 seconds fails the quote instead of being
served with a staleness note.

`oracleSource` names the feed, and it names the venue rather than the class: the
DEX source reports `horizon-sdex:USDC:G…->XLM`, so a rate carries the pair that
produced it. The static source labels itself `static-config`, and that label
reaches the console and the audit log, so a placeholder rate can never be
mistaken for a market one. `PRICE_SOURCE` selects between them; when the DEX has
no configured asset for a corridor's currency, the quote fails with a 503 naming
the missing currency rather than falling back to the placeholder.

---

## Corridors and compliance

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/corridors` | Every configured corridor. |
| `GET` | `/corridors/:id/compliance-tiers` | The corridor's tier bands and daily ceiling. |

Tier bands are read from the compliance hook rather than duplicated in Postgres,
so the console renders the rules the chain is actually enforcing. If the backend
kept its own copy, a threshold change would be visible in one place and effective
in another.

---

## KYC

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/kyc/preflight` | What tier a sender has now, and what this amount would need. |
| `POST` | `/kyc/verifications` | Submit a verification to the configured provider. |
| `POST` | `/kyc/webhooks/:providerId` | Provider callback. The provider id is in the path so a misrouted webhook fails visibly. |
| `POST` | `/kyc/revocations` | Revoke an attestation (sanctions hit, chargeback, fraud). |
| `GET` | `/kyc/attestations` | Attestation status for a subject. Returns tier, provider, expiry and revocation state — **never the underlying documents**. |
| `GET` | `/kyc/config` | Which provider is configured and which tiers are in force. |

**Only the attestation hash goes on-chain.** Everything else stays in Postgres,
where retention rules and access control apply. See
[`docs/trust-and-compliance.md`](trust-and-compliance.md) — including the part
that matters most, which is that a hash is not a substitute for keeping the
payload access-controlled.

The provider is pluggable behind `IdVerificationProvider`, and two
implementations ship. `KYC_PROVIDER=mock` is deterministic, holds no external
state, and exercises every branch — approval, rejection, manual review, provider
timeout, malformed webhook — because a mock that always approves would leave
every path that matters untested. `KYC_PROVIDER=http` is the real adapter: it
calls a vendor's REST API (`KYC_PROVIDER_BASE_URL`) and verifies webhook
signatures, refusing on a non-2xx, a body outside the contract, an unknown
outcome, a timeout, or an unsigned webhook. Its request/response contract is
documented at the top of `backend/src/kyc-orchestration/http-provider.ts`, which
is the thing a vendor adapter has to satisfy.

---

## Agent liquidity

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/agents` | Agent roster with float and bond position. |
| `GET` | `/agents/:id` | One agent: region, status, bond, exposure, recent alerts. |
| `POST` | `/agents/liquidity/sweep` | Pull contract events and re-evaluate float thresholds. |
| `GET` | `/agents/liquidity/alerts` | Agents below their configured float ratio. |
| `POST` | `/agents/liquidity/top-ups` | Request a float top-up. |
| `GET` | `/agents/liquidity/top-ups` | Top-up requests and their state. |
| `POST` | `/agents/liquidity/top-ups/:id/decision` | Approve or reject. |
| `POST` | `/agents/liquidity/top-ups/:id/execute` | Draw against the pool for an approved request. |
| `GET` | `/liquidity/regions/:regionId` | Pool health for a region: deposited, drawn, available, utilisation, cap. |

Top-ups are **two steps on purpose**. Approval records an operator decision;
execution submits the draw. Collapsing them would mean a single click both
approves and moves money, and there would be no record of who decided what.

Implication for clients: **no optimistic UI on these routes.** A top-up is
approved only after the backend agrees, which is stated in the console's design
notes as well.

---

## Consuming this

The operator console does not call this API from the browser. Its Next.js route
handlers read server-side and proxy mutations through `/api/backend/*`, so the
backend's address never appears in a client bundle and there is exactly one place
where a future auth token will be attached. See
[`admin-web/README.md`](../admin-web/README.md).
