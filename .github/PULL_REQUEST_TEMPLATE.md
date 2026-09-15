## What this changes

<!-- One paragraph. The diff shows the rest. -->

Closes #

## Why this way

<!--
The reasoning, and the alternatives you rejected. If a trade-off was involved,
name the side that got worse — a reviewer will find it anyway, and finding it
unmentioned is worse than finding it explained.

If this is expensive to reverse, an ADR in `docs/adr/` is the right place for it
and this section should link to it.
-->

## Risk

<!--
Tick anything that applies. These are the categories a reviewer will look at
first, so saying "no" here is useful information.
-->

- [ ] Moves, locks or releases funds
- [ ] Adds or changes a privileged (admin/attester) call
- [ ] Puts a new field on-chain
- [ ] Changes how PII is stored, read or logged
- [ ] Changes a compliance rule or a tier boundary
- [ ] Adds a dependency, or changes a lockfile
- [ ] Changes CI or the deploy tooling
- [ ] None of the above

## How it was verified

<!--
Be specific, and be honest about the gaps. "Typecheck and tests pass" is weak
evidence; "I started the container and called the endpoint, here is the output"
is strong. An unverified claim that is stated as unverified is fine — an
unverified claim presented as verified is not.
-->

- [ ] `make check` (typecheck + lint + tests, all components)
- [ ] Contract tests cover the failure paths, not only the happy path
- [ ] Exercised against a running stack (state what you called)
- [ ] Deploy `--dry-run` walked
- [ ] Not verified end to end — explain what is left

## Checklist

- [ ] Conventional commit messages, with the body explaining *why*
- [ ] New environment variables added to the component's `.env.example` and to CI
- [ ] No secrets, keys or `.env` files committed
- [ ] Docs updated if behaviour, wiring or limits changed
