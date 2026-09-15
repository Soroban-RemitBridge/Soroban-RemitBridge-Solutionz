# ADR 0002 — Extract shared contract interfaces into an `rlib`-only crate

- **Status:** Accepted
- **Date:** 2026-09-14

## Context

`RemitEscrow` calls `AgentRegistry` and `ComplianceHook`; `LiquidityPool` calls
`AgentRegistry`. The obvious way to get the types and the generated clients is a
direct Cargo dependency between the contract crates.

That was the initial arrangement, and it produced a Wasm artifact that **cannot
be deployed**: the escrow's `.wasm` exported the registry's entry points as well
as its own. Soroban Wasm entry points are top-level exports of the module, so
two contracts' ABI in one artifact collide. The failure is not a compile error
and not a test failure — it appears at deploy time, after the build has reported
success.

## Decision

Introduce `contracts/interfaces` — a **`rlib`-only** crate holding the shared
traits (`EscrowInterface`, `AgentRegistryInterface`, `ComplianceHookInterface`,
`LiquidityPoolInterface`), their `contracttype` structs, their `contracterror`
enums, and the `#[contractclient]`-generated clients.

The four contract crates depend on `interfaces` and **never on each other**. The
registry remains a `dev-dependency` of the escrow so its test suite can deploy a
real registry instance, which keeps the cross-contract integration tests honest
without linking the two `cdylib`s.

## Why this works

An `rlib` has no Wasm entry points to leak. A `cdylib` linking an `rlib` exports
only what its own `#[contractimpl]` blocks define, so each artifact's ABI is
exactly one contract's.

## Consequences

**Good.**

- Each `.wasm` exports only its own ABI, which CI now **asserts directly** by
  reading each artifact's export table rather than trusting the arrangement.
  See `.github/workflows/contracts.yml`.
- The traits are the single source of truth, so the backend and the console
  decode the same structs the contracts write.
- A cross-contract signature change is one edit in one crate, and every caller
  fails to compile — which is the correct blast radius for that change.

**Accepted costs.**

- One more crate in the workspace, and types live one hop away from the contract
  that uses them.
- The `#[contractclient]` client is generated from the trait rather than the
  implementation, so the trait is load-bearing for the call ABI and must stay
  signature-identical to the `#[contractimpl]` block. A mismatch is caught at
  deploy or on first cross-contract call, not at compile time.

## Verification

`contracts.yml` reads the export table of each built artifact and fails if a
contract's Wasm exports a foreign entry point. The property was also confirmed
manually during the refactor.
