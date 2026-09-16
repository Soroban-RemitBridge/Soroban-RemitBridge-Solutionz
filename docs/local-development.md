# Local development

How to get every component running, what each check actually verifies, and the
failures that are confusing enough to be worth writing down.

The README's quick start is the short version. This is the same thing with the
reasons attached.

---

## Prerequisites

| Tool | Version | Needed for |
| --- | --- | --- |
| Node | 22+ (`.nvmrc`) | Backend, both frontends, deploy tooling |
| Rust | stable (`rust-toolchain.toml`) | Contracts |
| `wasm32v1-none` target | — | Building deployable contract Wasm |
| Docker | any recent | Postgres, and the full-stack compose file |
| `stellar` CLI | optional | Inspecting a deployed contract by hand |

```bash
rustup target add wasm32v1-none
nvm use            # or: node --version  # expect v22.x
```

Versions are pinned on purpose: `rust-toolchain.toml`, `.nvmrc`, `Cargo.lock` and
four `package-lock.json` files are all committed, so a dependency change is a
reviewable commit rather than silent drift.

---

## Contracts

```bash
cd contracts
cargo test --all-features             # 115 tests
cargo clippy --all-targets -- -D warnings
cargo fmt --all --check

# Deployable Wasm
cd ../scripts && npm install && npm run build:contracts
```

`clippy -D warnings` is not style policing here. In a `no_std` contract the lints
that matter are the ones about integer arithmetic and discarded results, and a
fund-handling bug has exactly that shape.

**Do not add a dependency between the two `cdylib` contract crates.** Shared
types and traits belong in `contracts/interfaces`, which is `rlib`-only. A
dependency between contract crates makes one contain the other's Wasm entry
points, and the artifact then cannot be deployed — with a green build. CI asserts
the property directly by reading each artifact's export table. See
[ADR 0002](adr/0002-extract-shared-contract-interfaces.md).

`contracts/**/test_snapshots/` is gitignored. Snapshots are a debugging aid, not a
review artifact.

---

## Database

```bash
docker compose up -d postgres
cd backend
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:migrate -- --name init    # generates prisma/migrations/
npm run prisma:seed
```

`prisma:generate` is not optional before typechecking. Without a generated client
every Prisma type degrades to `any` and the typecheck passes **for the wrong
reason** — which is why CI runs it as its own step, before typecheck.

The repository ships no `prisma/migrations/` directory, because generating one
needs a live database and an invented empty migration history would be worse than
the gap. The container entrypoint detects the absence and warns loudly.

---

## Backend

```bash
npm run dev        # http://localhost:4000, tsx watch
npm run indexer    # separate process: contract events → read model
```

The API and the indexer are separate processes on purpose. The indexer is the
only thing that writes projections, and running it inside the API would mean two
replicas racing to advance the same cursor.

| Check | Command | What it verifies |
| --- | --- | --- |
| Types | `npm run typecheck` | The code agrees with its own types |
| Lint | `npm run lint` | Type-aware rules: floating promises, untyped payloads, `no-misused-promises` |
| Tests | `npm test` | Behaviour, 93 tests |
| Build | `npm run build` | The production build compiles |
| Audit | `npm audit` | Clean |

The KYC and price-feed suites are worth knowing about because both are about
refusal. `KYC_PROVIDER=mock` is what CI runs; `KYC_PROVIDER=http` is the real
adapter, and its suite drives a stub vendor that returns a non-2xx, a body outside
the documented contract, an unknown outcome, a timeout, and a webhook signed with
the wrong key — each of which must refuse rather than approve. `PRICE_SOURCE=static`
is the default so a fresh clone does not depend on Horizon being reachable;
`PRICE_SOURCE=horizon` reads the Stellar DEX and its suite is pinned to a real
`horizon.stellar.org` response.

Whole stack in containers instead:

```bash
cp backend/.env.example .env       # compose reads the repo-root .env
docker compose up --build
```

`/readyz` reports which four contracts the process is *actually* wired to. It is
the first thing to check when the console and the chain appear to disagree.

---

## Operator console

```bash
cd admin-web
cp .env.example .env.local         # REMITBRIDGE_API_URL + the two auth variables
npm install

export OPERATOR_SESSION_SECRET="$(openssl rand -base64 48)"
export OPERATOR_ACCOUNTS="[{\"email\":\"you@example.com\",\"name\":\"Your Name\",\"passwordHash\":\"$(node scripts/operator-hash.mjs 'your password')\",\"roles\":[\"admin\"]}]"

npm run dev                        # http://localhost:3000/login
```

Both auth variables are required, and the console **fails closed** without them:
with no `OPERATOR_SESSION_SECRET` every request answers `500
CONSOLE_MISCONFIGURED` with an explanation, rather than treating "no secret" as
"no session required" and serving a console that looks configured. Generating a
hash by hand will not work either — `OPERATOR_ACCOUNTS` rejects anything that is
not a `scrypt$…` string, so a plaintext password pasted in is a boot error rather
than a working login. Roles are `viewer`, `operator` and `admin`.

`REMITBRIDGE_API_URL` is deliberately **not** a `NEXT_PUBLIC_` variable. The
browser never talks to the backend: route handlers read server-side and mutations
are proxied through `/api/backend/*`, so the backend address is not in any client
bundle, and the proxy is the one place the session is checked and the operator's
identity is written into a mutation's audit fields.

Pages fetch with `force-dynamic`, so `next build` succeeds with no backend
running — which is also the state a reviewer opening a preview build is in.

```bash
npm run typecheck
npm run lint
npm test                           # response boundary, sessions, roles: 71 tests
npm run test:e2e                   # real browser over a production build, 56 tests
```

The console's tests are mostly about what it *refuses* to render: an amount
arriving as a JSON number, an undeclared field, an unrecognised status, a pool
snapshot without its staleness flag. Each must fail schema validation and surface
as unavailable rather than as an empty table — a state the type layer cannot
check, because the bad value arrives at runtime.

`test:e2e` builds the console, serves it on port 3100, and starts a stub backend
on 4010 for it to read (`e2e/stub-backend.mjs`). Three consequences worth knowing:
it needs Chromium once (`npx playwright install --with-deps chromium`), it tests
the built artifact rather than `next dev` because the build is what ships, and
`playwright.config.ts` supplies the two auth variables itself — accounts whose
hashes come from the real generator script, so the suite signs in through the real
form rather than past it.

The stub reads from `e2e/fixtures.mjs` and can be told to answer as a down,
malformed or empty backend through `POST /__control`, which is how the suite
proves a failed read and an empty result cannot look the same. A `setup` project
signs in once and caches the cookie for every spec except `auth.spec.ts`, which
runs deliberately without it — that is where the refusal, the redirect, the
off-site `next` guard and the role checks are asserted.

---

## Mobile

```bash
cd mobile
cp .env.example .env
npm install
npm start                          # then i / a, or scan with Expo Go
```

`EXPO_PUBLIC_API_URL` must point at a running backend. **On a physical device
`localhost` is the phone**, not your machine — use your machine's LAN address.

```bash
npm run typecheck
npm run lint
npm test                           # claim code + money formatting, 33 tests
```

`expo-crypto` is native-only, so `vitest.config.ts` aliases it to a
`node:crypto`-backed double. That is what lets the claim-code protocol be tested
at all, and the double hashes for real so the assertions mean something.

---

## Deploy tooling

```bash
cd scripts
cp .env.example .env
cp config/testnet.example.json config/testnet.json

npm run deploy:dry-run             # validates args and encoding, submits nothing
npm run deploy                     # uploads, deploys, initializes, wires, verifies
```

Always dry-run first. The dry run loads the real Wasm, derives valid placeholder
addresses and performs genuine argument encoding, so it exercises the
cross-contract wiring — the part most likely to be wrong — for free.

`DEPLOY_CONFIG` is resolved **relative to the repository root**, so its value is
`scripts/config/testnet.json`, not `config/testnet.json`. Passing the shorter
path is the most common first mistake and produces a "could not read deployment
config" error naming a path outside `scripts/`.

---

## Everything at once

```bash
make help          # list targets
make check         # typecheck + lint + test, every component
make contracts     # fmt + clippy + test
make test          # the test suites only
```

`make check` is what CI mirrors, so a green local run is a reliable predictor.

---

## Failures worth recognising

| Symptom | Cause |
| --- | --- |
| Typecheck passes but runtime types are wrong | Prisma client not generated. `npm run prisma:generate`. |
| Contract Wasm will not deploy though the build succeeded | A contract crate depends on another contract crate. Move the shared types into `contracts/interfaces`. |
| A cross-contract call fails with a decoding error naming nothing | An `ScVal` encoded with the wrong type — a `String` where the contract declares a `Symbol`, or a struct built without symbol keys. See `struct()` in `backend/src/soroban/contracts.ts`. |
| Deploy dry run cannot find its config | `DEPLOY_CONFIG` is relative to the repository root. |
| Mobile app reaches nothing on a physical device | `localhost` is the phone. Use the LAN address. |
| Console shows an empty table instead of an error | The response failed schema validation, which renders as unavailable rather than empty — check the backend actually returned what the console reads. |
| Console answers every route with `500 CONSOLE_MISCONFIGURED` | `OPERATOR_SESSION_SECRET` is unset or shorter than 32 characters. This is the gate failing closed, not an outage. |
| `OPERATOR_ACCOUNTS` is rejected at startup | The password hash is not a `scrypt$…` string (plaintext is refused), the JSON is malformed, an email is duplicated, or a role is not one of `viewer` / `operator` / `admin`. |
| A signed-in operator is bounced to `/login` on every navigation | The session secret differs between the process that issued the cookie and the one verifying it — common after a restart with a freshly generated secret. |
| A quote fails with a 503 naming a currency | `PRICE_SOURCE=horizon` and that currency has no entry in `SDEX_ASSETS`. Horizon prices assets, not currencies. |
| Stale data everywhere, chain is fine | The indexer is behind. Rewind its cursor for that one contract; projections rebuild from raw `ChainEvent` rows. See the [runbook](runbook.md). |

---

## CI

Four workflows, split by component so a failure names its own cause:

| Workflow | What it runs |
| --- | --- |
| `contracts.yml` | `fmt`, `clippy -D warnings`, `test`, Wasm build, artifact size, **export-table assertion** |
| `backend.yml` | `prisma generate`, typecheck, lint, test, build, schema applies, `npm audit` |
| `frontends.yml` | Both frontends: typecheck, lint, test, build (console), audit. Plus a separate job for the console's Playwright suite, with the browser installed via `--with-deps` |
| `scripts.yml` | Contract build, typecheck, **full `--dry-run`** with a keypair generated per run |

No key material is stored anywhere in CI, not even a generated testnet key: the
deploy workflow creates a keypair per run because a committed key is a key that
gets reused.
