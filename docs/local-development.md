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
| `wasm32-unknown-unknown` target | — | Building deployable contract Wasm |
| Docker | any recent | Postgres, and the full-stack compose file |
| `stellar` CLI | optional | Inspecting a deployed contract by hand |

```bash
rustup target add wasm32-unknown-unknown
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
| Tests | `npm test` | Behaviour, 50 tests |
| Build | `npm run build` | The production build compiles |
| Audit | `npm audit` | Clean |

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
cp .env.example .env.local         # REMITBRIDGE_API_URL=http://localhost:4000
npm install
npm run dev                        # http://localhost:3000
```

`REMITBRIDGE_API_URL` is deliberately **not** a `NEXT_PUBLIC_` variable. The
browser never talks to the backend: route handlers read server-side and mutations
are proxied through `/api/backend/*`, so the backend address is not in any client
bundle and there is exactly one place a future auth token will be attached.

Pages fetch with `force-dynamic`, so `next build` succeeds with no backend
running — which is also the state a reviewer opening a preview build is in.

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
| Stale data everywhere, chain is fine | The indexer is behind. Rewind its cursor for that one contract; projections rebuild from raw `ChainEvent` rows. See the [runbook](runbook.md). |

---

## CI

Four workflows, split by component so a failure names its own cause:

| Workflow | What it runs |
| --- | --- |
| `contracts.yml` | `fmt`, `clippy -D warnings`, `test`, Wasm build, artifact size, **export-table assertion** |
| `backend.yml` | `prisma generate`, typecheck, lint, test, build, schema applies, `npm audit` |
| `frontends.yml` | Both frontends: typecheck, lint, build (console) / test (mobile), audit |
| `scripts.yml` | Contract build, typecheck, **full `--dry-run`** with a keypair generated per run |

No key material is stored anywhere in CI, not even a generated testnet key: the
deploy workflow creates a keypair per run because a committed key is a key that
gets reused.
