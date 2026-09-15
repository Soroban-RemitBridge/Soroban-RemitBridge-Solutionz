# ADR 0005 — Separate the attester key from the admin key

- **Status:** Accepted
- **Date:** 2026-09-14

## Context

The compliance hook needs two very different kinds of privileged operation:

1. **Configuration** — set tier thresholds per corridor, register the escrow,
   grant/revoke attester rights, pause the whole contract.
2. **Routine attestation** — publish and revoke a verification result every time
   a user completes KYC.

The simplest arrangement is one key that does both.

## Decision

Two keys, with distinct authority.

| Key | Custody | Can | Cannot |
| --- | --- | --- | --- |
| **Admin** | Operator, cold | Thresholds, attester allowlist, escrow registration, pause, agent authorization, slashing | Read any KYC record |
| **Attester** | KYC service, **hot** | Publish and revoke attestations | Change thresholds, pause, authorize agents, move funds |

`set_operator(operator, allowed: bool)` is the admin-gated grant/revoke of attester
rights.

## Why

The KYC orchestration service is the most externally exposed component in the
system. It accepts document uploads and third-party webhooks, and it therefore
runs hot — it must hold a key that can sign, and that key is reachable from a
process that parses untrusted input.

Collapsing the two keys means a compromise of that process also grants the
ability to:

- lower every corridor's tier thresholds to zero,
- unpause a network that was paused because of an incident,
- authorize an attacker-controlled agent, which then becomes able to claim
  transfers,
- and slash honest agents' bonds.

That is the difference between an incident that requires re-issuing attestations
and an incident that requires redeploying the escrow.

**The same argument applies to the quote signer**, which also runs hot and is
restricted to signing and nothing else.

## Consequences

**Good.**

- The blast radius of the most exposed process is bounded by construction, not by
  policy.
- `set_operator(attester, false)` is a one-transaction cut-off, and only the cold
  admin key can perform it. An attacker cannot reverse their own revocation.
- The event log distinguishes the two actors, so "who published this attestation"
  and "who changed this threshold" are different questions with different
  answers.

**Accepted costs.**

- Two more secrets to manage and rotate, and a rotation that updates only one of
  them leaves an inconsistency.
- The attester key cannot self-service a threshold change, so a legitimate tier
  adjustment needs the cold key to be brought online. That friction is the
  intended cost of the separation, and it is why threshold changes are expected
  to be rare.
- `publish_attestation` takes the attester address as an explicit parameter rather
  than inferring it, so the contract checks it against the allowlist *and* calls
  `require_auth` on it. Slightly more verbose at the call site; it makes the
  authorization tree self-documenting in the transaction.

## Verification

`only_the_admin_can_reconfigure_the_gate` asserts, without blanket auth mocking,
that a non-admin signer cannot reach `set_operator`, `set_tier_thresholds`,
`set_escrow` or `set_paused`, and that none of them wrote state on the way to
being refused.

`revoking_an_attester_closes_both_writes` covers the direction that is easy to
miss: revoking a key must remove its ability to *revoke* as well as to publish.
An allowlist consulted on publish but not on revoke would leave a compromised key
able to withdraw the evidence of its own misuse.

Also `only_listed_attesters_may_publish` and
`admin_only_functions_reject_a_non_admin_signer` (registry).
