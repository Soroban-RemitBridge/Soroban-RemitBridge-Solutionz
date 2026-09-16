# Security

The threat model this system was built against, the mechanisms that address it,
and — more usefully — the ones that do not, with the reason.

Referenced from the escrow's crate documentation. `docs/trust-and-compliance.md`
covers what is on-chain versus off-chain; this covers what an adversary can do.

---

## The commit-reveal core

### Why the code is not stored on-chain

The obvious design stores the claim code in the contract so any agent can check
it. That fails the moment you say it out loud: a ledger is world-readable, so
anyone who can read the ledger can read the code, and the intended recipient is
no longer the only person who can claim the transfer. Theft requires no exploit
— only a block explorer.

Storing `sha256(code)` inverts the requirement. A leaked ledger reveals that *a*
transfer exists, its amount, its corridor and its expiry. It does not reveal who
can claim it. The code exists in exactly two places off-chain: the sender's
screen, and the recipient's hand.

`RemitEscrow::create_transfer` takes `claim_hash: BytesN<32>`;
`claim_transfer` takes `reveal: BytesN<32>` and requires
`sha256(reveal) == claim_hash`. The escrow rustdocs carry the same rationale next
to the code that depends on it.

### What commit-reveal does *not* protect against

**A weak code.** The contract cannot distinguish `sha256("1234")` from
`sha256(160 random bits)`. A guessable code is brute-forceable offline straight
from the published hash — no oracle, no rate limit, no on-chain interaction
required. The commit is only as strong as the entropy of what it commits to.

This makes claim-code generation a **security-critical client requirement**
rather than a UI detail, and it is why it is specified here and implemented in
exactly one place, `mobile/src/lib/claim.ts`.

### The claim code specification

| Property | Value | Why |
| --- | --- | --- |
| Length | exactly 32 characters | `BytesN<32>`; the UTF-8 bytes of the code *are* the reveal |
| Alphabet | Crockford base32 — `0-9`, `A-Z` minus `I`, `L`, `O`, `U` | 32 symbols, so it is a power of two and the modulo is unbiased |
| Entropy | 32 × log₂(32) = **160 bits** | Not brute-forceable; far beyond any practical pre-image search |
| Source | `Crypto.getRandomBytesAsync` (native CSPRNG) | `Math.random` is not cryptographically secure and must never be used here |
| Display | grouped `ABCD-EFGH-…` | Read aloud across a counter; grouping is display-only and stripped before hashing |

**The 32-characters-from-32-symbols property is load-bearing, not cosmetic.**
It means no encoding layer sits between what the sender writes down and what the
contract receives. An encoding step is the most likely place for this flow to
break, and it would break silently: the code would hash to something the chain
never committed to, and the transfer would be unclaimable.

Crockford base32 is chosen for the same reason the transfer exists. `I`, `L`,
`O` and `U` are the characters people mis-transcribe and mis-hear. The alphabet
omits them, and `normaliseClaimCode` repairs only the two unambiguous slips
(`I`/`L` → `1`, `O` → `0`). It is deliberately conservative: mapping a wrong
character onto a *different valid* symbol would convert a typo the agent could
diagnose into a hash mismatch they cannot.

### Anyone holding the code can claim

This is the model, not a flaw. It is what lets a recipient with no wallet, no
bank account and no seed phrase collect cash by showing a code to a shopkeeper.
The sender UI states plainly that the code is equivalent to the money, because a
user who does not understand this will share it over an insecure channel.

### Replay is closed by construction, not by a check

`claim_transfer` flips the record to `Claimed` under the same invocation that
pays out, so a second attempt fails with `TransferNotPending`. There is no
separate "already claimed?" check that could be raced. Verified by
`claiming_twice_pays_once`.

---

## Known races, and why they are documented rather than closed

### Sender cancels while the agent is counting out cash

The sequence: sender hands over the code, the agent verifies it, and the sender
calls `cancel_transfer` in the window before the agent's `claim_transfer`
lands. The agent is then left handing over cash for a transfer that no longer
exists.

There is no way to close this on-chain without an unacceptable cost. Either:

- the agent must pre-announce its intent to claim, which means publishing
  evidence of holding the code — the thing commit-reveal exists to prevent; or
- the sender's funds must be locked for the full expiry window with no
  cancellation path at all, which removes a legitimate protection for a sender
  whose recipient never shows up.

It is closed **procedurally** instead: the agent app re-reads the transfer status
immediately before releasing cash, exactly as a card terminal re-authorises at
the counter. The residual window is the latency of one RPC read.

This is a deliberate acceptance, and it is the kind of thing that should be in
the reader's hands rather than discovered later.

### Refund and claim race with each other

`refund_expired` and `claim_transfer` can be submitted for the same transfer at
the same ledger. Both are closed with respect to each other: whichever lands
first flips the status, and the second sees a non-`Pending` record and refuses.
Funds move once. Verified by
`refunds_and_claims_race_cleanly_and_only_one_wins` and
`a_refunded_transfer_cannot_then_be_claimed`.

### A revoked agent mid-flight

If an agent is revoked after a sender creates a transfer in its corridor, the
claim fails at the registry check. This is intended — revocation is a sanctions
or fraud response, and it must take effect immediately rather than at the end of
some grace period. The sender's funds are still recoverable: the transfer remains
`Pending` until expiry, then `refund_expired` returns them. Verified by
`revoking_an_agent_mid_flight_blocks_the_claim`.

---

## Key custody

Three keys, three jobs, three blast radii.

| Key | Held by | Can | Cannot |
| --- | --- | --- | --- |
| **Admin** | Operator, cold storage | Set thresholds, fee (capped at 500 bps), pause/unpause, authorize/suspend/revoke agents, slash bonds, re-point wiring | Move a pending transfer's funds, exceed the fee cap, unpause into a claim |
| **Attester** | KYC service, hot | Publish and revoke attestations | Reconfigure thresholds, unpause, authorize agents, move funds |
| **Quote signer** | Quoting service, hot | Sign quotes | Move funds |

**The attester key is deliberately not the admin key.** The KYC service runs hot
and is the most externally exposed component in the system — it takes document
uploads and webhooks from a third party. A compromise of it must not grant the
ability to reconfigure compliance, unpause the network, or authorize an agent.
`set_operator(attester, false)` cuts it off, and only the admin key can do that.

**The fee is capped on-chain** (`MAX_FEE_BPS = 500`). A compromised or mistaken
operator key cannot turn an escrow that already holds user funds into a
fee-extraction mechanism. Verified by `fee_above_the_on_chain_cap_is_rejected`.

**No secret is required for a recipient to be paid**, and none reaches a browser:
the operator console reads the API server-side and proxies mutations, so the
backend's address is not in any client bundle.

### What a compromised admin key can do

Honestly stated: an admin key compromise is severe. It can pause the network,
reconfigure every corridor's tier bands, authorize a hostile agent and slash
honest agents' bonds. It **cannot** move a pending transfer's funds, because the
claim code is the only thing that unlocks a transfer and the admin never sees it.
That separation is the design's main structural defence, and it is why the admin
key is expected to be cold.

### What a compromised attester key can do

Publish a fraudulent high-tier attestation for an attacker-controlled address,
and revoke honest senders' attestations. It cannot move funds, lower a threshold,
or un-pause. The remedy is `set_operator(..., false)` plus a review of the
`kyc_pub` event history for the compromise window.

---

## Automated contract-level guards

These are enforced by the contracts themselves, and each has a test:

| Guard | Test |
| --- | --- |
| Fee cannot exceed 500 bps | `fee_above_the_on_chain_cap_is_rejected` |
| Admin-only on every privileged call | `admin_only_functions_reject_a_non_admin_signer` |
| A sender cannot claim their own transfer | `a_sender_cannot_claim_their_own_transfer` |
| An unbonded agent cannot claim, even with the right code | `an_unbonded_agent_cannot_claim_even_with_the_right_code` |
| Authorization is scoped to the agent's own region | `authorization_is_scoped_to_the_agents_own_region` |
| A pending (unapproved) agent cannot claim | `a_pending_but_unapproved_agent_cannot_claim` |
| Expiry cannot be set in the past or beyond the ceiling | `expired_and_overlong_expiries_are_rejected` |
| Structuring small transfers still hits the daily ceiling | `structuring_many_small_transfers_still_hits_the_daily_ceiling` |
| A stranger cannot commit volume against a sender's limit | `a_stranger_cannot_commit_volume_against_a_senders_limit` |
| Repeated small draws cannot escape the collateral ratio | `repeated_small_draws_cannot_escape_the_collateral_ratio` |
| Only listed attesters may publish | `only_listed_attesters_may_publish` |
| A revoked attestation blocks even an unverified transfer | `a_revoked_attestation_blocks_even_an_otherwise_unverified_transfer` |
| Rotating the operator key hands over control | `rotation_hands_over_the_operator_key` |

Failure is always fail-closed. An unreachable registry refuses a claim
(`an_unreachable_registry_fails_the_claim_closed`) and an unreachable compliance
hook is reported as an incident rather than a refusal
(`an_unreachable_compliance_hook_is_reported_as_an_incident_not_a_refusal`).

---

## Off-chain surface

| Area | Position |
| --- | --- |
| Secrets in logs | `logger.ts` redacts every key in `SECRET_ENV_KEYS`, because the realistic leak is someone logging the whole config while debugging |
| Config validation | Parsed and validated at import time with a named error per missing variable; a missing contract address is a boot failure, not an `undefined` three layers down |
| PII | Never on-chain. `docs/data-model.md` marks which tables carry it and are subject to retention and access control |
| Amounts | `bigint` in Node, strings on the wire, `Decimal(39,0)` in Postgres. A JSON number is a double before validation runs |
| Event decoding | Refuses to guess at payload shapes and refuses to coerce untyped values into amounts. A decoding gap is a red build, not a silent skip |
| Rate limiting | In-process and therefore per-replica. Documented as the limitation it is; a shared limiter is on the roadmap. The console's login throttle has the same shape |
| Console auth | Scrypt password hashes in `OPERATOR_ACCOUNTS`, HMAC-signed `httpOnly` session cookie, every request gated by an Edge `proxy.ts` |
| Console authorisation | Five permissions (`liquidity:propose/decide/execute/sweep`, `kyc:revoke`) checked server-side in the mutation route handler. A mutation path with no policy is **refused**, not forwarded |
| Console audit attribution | `requestedBy` / `approvedBy` are deleted from the request body and rewritten from the verified session, so a browser cannot attribute an action to someone else |
| Console limitations | Operators are configuration (onboarding is a deploy), no SSO or MFA, and a session cannot be revoked before it expires — there is no session store, so rotating `OPERATOR_SESSION_SECRET` is the only lever. Still `noindex`, and still belongs behind network-level access control as a second layer |

---

## Reporting a vulnerability

This is a reference implementation, not a deployed service. If you are reviewing
it and find a flaw, open an issue describing the adversary and the outcome. A
report that names a concrete sequence — actor, preconditions, result — is worth
more than one that names a category.
