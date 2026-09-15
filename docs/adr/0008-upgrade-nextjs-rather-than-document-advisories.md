# ADR 0008 — Upgrade the console to Next.js 16 and Tailwind v4

- **Status:** Accepted
- **Date:** 2026-09-14

## Context

The operator console was scaffolded on **Next.js 14**, which the project brief
named explicitly. `npm audit` then reported multiple advisories against it, and
`npm view next version` showed that **every published Next release below 16.3.5
carries advisories**. There was no 14.x patch to move to.

Two options:

1. Stay on Next 14 as briefed, document the advisories in the README as known
   issues, and note the upgrade as a roadmap item.
2. Upgrade to Next 16.

## Decision

Upgrade to **Next.js 16** with **React 19**, and to **Tailwind v4**, which the
upgrade forces.

## Why

**The console is privileged.** It can authorize an agent, revoke an attestation,
approve a float top-up and change a corridor's tier bands. Shipping it on a
framework version with publicly documented vulnerabilities is a different
proposition from shipping a marketing site on one. "Documented as a known issue"
is an acceptable answer for a static page; it is not an acceptable answer for a
console whose compromise moves money and compliance state.

**The upgrade was bounded, and the cost was known in advance.** The app is small,
its server/client split is deliberate (recorded in
[`admin-web/README.md`](../../admin-web/README.md)), and the upgrade touched
configuration rather than architecture. That is not true of every dependency
upgrade, and it was checked before committing rather than assumed.

**Tailwind v4 is a consequence, not a preference.** Next 16 makes **Turbopack**
the default builder, and Turbopack cannot resolve Tailwind v3's internal asset
paths. Staying on v3 meant fighting the builder; moving to v4 was the supported
pairing. `@tailwindcss/postcss` replaced the v3 PostCSS plugin, and the theme
moved from `tailwind.config.ts` into `@theme` blocks in `globals.css`.

## Consequences

**Good.**

- `npm audit` reports **0 vulnerabilities**. That is a checkable property, unlike
  a README paragraph.
- Turbopack gives noticeably faster dev builds, and Next 16's dynamic-by-default
  route handling matches this app: every page reads live operator data, so
  static generation was never wanted and now does not have to be opted out of.
- React 19's server components are the version the rest of the console's design
  assumes.

**Accepted costs.**

- **The brief said Next 14.** The deviation is recorded here and in the README's
  tech-stack notes with the reason, rather than being quietly upgraded past.
- Tailwind v4's configuration is CSS-native, so `tailwind.config.ts` was deleted
  and `@theme` in `globals.css` is now the source of truth. Anyone looking for
  the familiar config file will not find it.
- `engines.node >= 20` was raised, and Next 16 is stricter about the React
  version than 14 was.
- A framework major version is a larger review surface than a patch. The
  mitigation is that the app's own surface is small and fully typechecked, and
  the production build is exercised in CI.

## Verification

`npm audit` → 0 vulnerabilities. `tsc --noEmit`, `eslint`, and `next build` all
clean, with the console's own routes rendering as dynamic.
