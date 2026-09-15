# ADR 0003 — Integer money end to end, strings on the wire

- **Status:** Accepted
- **Date:** 2026-09-14

## Context

A remittance amount crosses five representations: a Solidity-free Soroban
contract (`i128`), a Node service, a Postgres column, a JSON response, and a
React Native screen. Each boundary is a place where a value can silently change.

The convenient representation at every boundary is a floating-point number.
JavaScript has exactly one number type, so `amount` as a JSON number is the path
of least resistance from contract to screen.

## Decision

| Layer | Representation |
| --- | --- |
| Soroban contract | `i128` |
| Backend runtime | `bigint` |
| Postgres | `Decimal(39,0)` |
| JSON wire | **`string`** |
| Mobile display | string, formatted by regex |

Rounding goes through one helper, `applyBps`, which rounds **down in the payer's
favour**.

## Why

**`Decimal(39,0)` and not `BIGINT`.** A `BIGINT` holds 63 bits. `i128` holds 127.
Stroops are 7 decimal places, so a `BIGINT` in stroops maxes out around 92
billion whole units — reachable in a settlement asset with a low unit value.
Truncating a large transfer is a data-loss bug with no error attached.

**Strings on the wire, not numbers.** `JSON.parse` produces a double before any
validation runs. A 19-digit integer arrives at the schema already rounded, and no
amount of Zod will recover it. Serialising as a string is the only way to make
the wire lossless, and it forces every consumer to acknowledge that the value is
not a float.

**`bigint` in Node.** Same argument: `Number` is a double. `bigint` makes the
loss impossible rather than unlikely.

**Rounding one way, in one place.** A quote and its settlement must not disagree.
Two independent roundings of the same figure — one in the quoting service, one in
the escrow — will eventually differ by one unit, and the visible symptom is a
customer seeing a different payout than the app promised. `applyBps` rounds down
so the platform never collects a rounding windfall at the sender's expense.

**The mobile app formats by regex.** `formatStroops` splits the decimal string
rather than dividing by `1e7`, for the same reason as everything above.

## Consequences

**Good.**

- A precision loss is a type error, not a production incident. `bigint` does not
  accept a `number` without an explicit conversion.
- The database cannot silently truncate.
- The wire format is unambiguous about intent.

**Accepted costs.**

- Every serialisation boundary needs an explicit `toString` / `BigInt` call, and
  the Prisma client returns `Decimal` objects that must be converted at the edge.
- Consumers that expect a number must be updated — which is the point, but it is
  friction.
- Any new endpoint that serialises an amount as a number is a regression. There
  is no lint for this; it is reviewed.

## Verification

`backend/tests/money.test.ts` covers arithmetic beyond `2^53`, the rounding
direction, and the string wire format.
