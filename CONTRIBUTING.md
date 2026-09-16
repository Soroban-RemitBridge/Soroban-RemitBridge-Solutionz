# Contributing

This is a fund-handling, compliance-adjacent system. The expectations below are
sized for that: the bar is not "does it work", it is "would you be comfortable
explaining this decision to someone whose money is in it".

---

## Before you start

1. Read [`docs/assumptions.md`](docs/assumptions.md). It records the decisions
   this codebase has already made and why, so you can tell the difference between
   a gap and a choice before proposing a change to one.
2. Read the [ADRs](docs/adr/README.md) if you are touching anything structural.
   Each one states the cost that was accepted, which is usually the objection a
   reviewer would otherwise raise.
3. `make check` should be green **before** you change anything. If it is not, that
   is the first thing to report.

## Getting set up

```bash
make install          # Node deps for every component
make wasm-target      # rustup target add wasm32v1-none
make check            # typecheck + lint + test, everything
```

Per-component detail, and the failures worth recognising, are in
[`docs/local-development.md`](docs/local-development.md).

---

## What a change needs

| Area | Requirement |
| --- | --- |
| Contract behaviour | Tests for the **failure** paths. A fund-handling contract is judged by what it refuses to do. |
| Contract errors | A typed `#[contracterror]` variant, not a panic. The backend maps variants to HTTP responses, so a panic is an unmapped 500. |
| Privileged calls | Admin-gated, with a test that signs as the wrong key and asserts the state did not change. |
| Money | `bigint` / `i128` / `Decimal(39,0)`, strings on the wire. Never a `number`. |
| PII | Never on-chain. If a new field is not a hash, a counter or an identifier, it does not belong in a `#[contracttype]`. |
| API responses | Validated with a schema at the consumer boundary, and the schema is the list of what may be rendered. |
| New dependency | Justify it in the commit. `npm audit` is a blocking gate, so a dependency with an advisory is a conversation. |
| New env var | Added to the component's `.env.example`, and to CI's placeholder block if it is required at boot. |
| A user-visible change | An entry under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) — added, changed, fixed or security, and one sentence on the effect rather than the mechanics. |
| A change to a deployed contract | The contract's cost report before and after (`cargo test -p remit-escrow cost_report_hot_paths -- --nocapture`), because a fee regression is invisible otherwise. |

## Commit conventions

Conventional commits, scoped by component:

```
fix(compliance-hook): reject an inverted tier band pair
feat(backend): expose preflight so a sender learns the tier before committing
docs(adr): record why refunds are permissionless
test(mobile): cover the claim code protocol
```

**The body explains *why*, not *what*.** The diff already shows what changed. A
body that restates it is noise; a body that records the reasoning is the reason
this history is worth reading in order. If a change has a trade-off, name it
explicitly — including the part that got worse.

If a decision is expensive to reverse, add an ADR rather than a longer commit
message.

## Pull requests

The template asks for four things, and the fourth is the one reviewers care about
most: what you verified, and what you did not. "Typecheck and tests pass" is
weaker evidence than "I ran the container and called the endpoint", and stating
the gap is better than letting a reviewer assume coverage that is not there.

Keep pull requests scoped to one idea. A PR that fixes a bug and renames a module
is one PR nobody can review well.

## Reviewing

Two questions, in order:

1. **Can this lose or trap money?** Refusals, races, expiry handling, pause
   semantics, arithmetic rounding.
2. **Does it move the trust boundary?** New privileged call, new on-chain field,
   new place PII is read, new dependency with network access.

Beyond that: a refusal that still wrote state is a bug, a silent fallback is a bug,
and "it cannot happen" is only an answer if there is a test asserting it.

## Reporting a vulnerability

Do not open a public issue. See [`SECURITY.md`](SECURITY.md).

## Licence

Contributions are accepted under Apache-2.0. See [`LICENSE`](LICENSE).
