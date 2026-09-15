# Security policy

## What this repository is

RemitBridge is a **reference implementation** — an open-source agent-network and
escrow design for last-mile remittance cash-out on Stellar. It is not a deployed
service, it holds no customer funds, and there is no production deployment to
compromise.

That shapes the policy below, and it is stated first because a reader deserves to
know whether they are reporting against live infrastructure or against a
codebase.

---

## Reporting a vulnerability

**Do not open a public issue for a security report.** Use GitHub's private
vulnerability reporting on this repository (Security → Report a vulnerability).

A useful report names four things:

1. **The actor.** Who is doing this — a sender, an authorized agent, a revoked
   agent, the operator, an anonymous party with ledger access, someone with
   database read access.
2. **The preconditions.** What state the system has to be in, and what the actor
   already holds (a claim code, a valid transaction, a compromised key).
3. **The outcome.** Funds moved, funds trapped, PII disclosed, a compliance rule
   bypassed, an audit record falsified.
4. **The sequence.** Concrete steps, or a failing test.

A report that names a category is hard to act on; one that names a sequence can
usually be turned into a test.

There is no bounty programme. There is an interest in getting the design right,
and reports will be acknowledged and credited unless you prefer otherwise.

---

## In scope

| Area | Examples of findings worth reporting |
| --- | --- |
| Escrow | Making a transfer unclaimable, claiming without the code, claiming twice, refunding to the wrong address, a race between claim and refund |
| Registry | Slashing without admin authority, bypassing the bond check, an agent settling in a region it is not authorized for |
| Compliance gate | Passing the per-transfer tier without meeting it, bypassing the cumulative daily ceiling, an attester key escalating beyond publishing |
| Liquidity pool | Drawing more than the bond covers, escaping the utilization cap through repeated draws, draining a depositor's share |
| Backend | PII disclosure, a path where a claim code is logged or stored, a quote forgeable without the signing secret, an unauthenticated privileged action |
| Clients | A claim code with insufficient entropy, a code whose bytes do not hash to what the contract verifies, a secret in a client bundle |

## Known limitations, stated in advance

These are documented design positions, not undisclosed findings. Reporting them
is fine, but they will be answered with a pointer rather than a patch:

- **Anyone holding a claim code can claim the transfer.** This is the mechanism
  that makes a wallet-free recipient possible. See
  [ADR 0001](docs/adr/0001-commit-reveal-claim-codes.md).
- **The commit's strength is the code's entropy.** The contracts cannot tell a
  weak code from a strong one, so this is enforced only in the client.
- **A sender can cancel while an agent counts out cash.** Closed procedurally by
  re-reading status before releasing cash; there is no on-chain fix that does not
  either leak the code or hold funds hostage. See
  [`docs/security.md`](docs/security.md).
- **`refund_expired` is permissionless**, so any caller can refund the instant a
  transfer expires. Intended.
- **The KYC provider is a mock.** No real identity verification is performed.
- **The operator console has no authentication.** It is marked `noindex` and must
  sit behind network-level access control. This is the first item on the roadmap.
- **Rate limiting is in-process**, so it is per-replica rather than global.
- **Quote signatures are HMACs**, verified by the issuing service. A third party
  cannot verify a quote independently.
- **The price source is static** and labels itself as such in every quote.
- **No deployment exists**, so nothing here has been exercised against a live
  network or adversarial validator.

## Key material

No secret is committed anywhere in this repository, and CI generates a throwaway
keypair per run rather than using a stored one. If you find committed key
material, that is a finding and a serious one.

Three keys exist in a real deployment, with deliberately different authority:

| Key | Custody | Blast radius if compromised |
| --- | --- | --- |
| Operator (admin) | Cold | Severe: thresholds, pause, agent authorization, slashing |
| Attester | Hot, in the KYC service | Publish and revoke attestations only |
| Quote signer | Hot, in the quoting service | Sign quotes only; cannot move funds |

The separation is the design's main structural defence; see
[ADR 0005](docs/adr/0005-separate-attester-and-admin-keys.md).
