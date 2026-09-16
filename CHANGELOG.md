# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions before 0.1.0 were not released and are not reconstructed here: this
changelog starts when the project first had a deployment to talk about.

## [Unreleased]

### Added

- **Operator console authentication.** Signed session cookies, per-action role
  checks (`viewer`, `operator`, `admin`) enforced in the request path and not only
  in the UI, and audit attribution rewritten from the session so a record names who
  acted rather than who typed. Operators are configuration (`OPERATOR_ACCOUNTS`,
  scrypt hashes); an unconfigured console refuses every request rather than
  degrading into an open one.
- **A real HTTP KYC provider** (`KYC_PROVIDER=http`) behind the existing
  `IdVerificationProvider`, with HMAC-verified webhooks, failing closed on a
  non-2xx, a body outside the documented contract, an unknown outcome, a timeout or
  an unsigned webhook. `KYC_PROVIDER=sumsub|onfido` names the missing adapter
  instead of silently selecting the mock.
- **A live price source** (`PRICE_SOURCE=horizon`) that prices a corridor from the
  Stellar DEX through `/paths/strict-send`, in bigint arithmetic, refusing by name
  when a currency has no configured asset rather than inventing a rate.
- **`deployments/testnet.json`** — a committed record of a real testnet deployment:
  addresses, public keys, Wasm hashes, configuration and proof transactions.
- **`npm run smoke-test`** — settles one real transfer end to end against a
  deployed network and checks the money actually moved.
- **`npm run verify`** — reads a deployment's state back over RPC (13 checks)
  instead of repeating what the deploy script believed it sent.
- **A cost report** (`cargo test -p remit-escrow cost_report_hot_paths`) measuring
  instructions, memory, ledger entries, bytes, events and modelled rent for every
  entry point that moves money.
- Console end-to-end coverage in a real browser (56 tests), and unit coverage for
  the session format, the role table and contract argument encoding.

### Changed

- `commit_transfer` on the compliance hook now **enforces** the gate as well as
  recording volume, so a check and a commitment cannot disagree and a transfer pays
  one cross-contract call instead of two.
- A day's volume bucket is reserved for three days rather than thirty, and reads no
  longer extend it: a bucket the key dates to a single day has no use for a month
  of rent.
- On `create_transfer`, measured: instructions −11.8%, memory −9.3%, modelled rent
  −9.9%.

### Fixed

- **`publish_attestation` trapped on a real network.** A `#[contracttype]` enum
  crosses the ABI as a one-element vector of the case name, not as a bare symbol;
  the wrong form fails inside the contract with an error naming neither the argument
  nor the caller. Found only by sending it to a deployed contract, and now pinned by
  a test.
- **A transfer expiry set to exactly `max_expiry_secs` was rejected**, because the
  escrow compares against the ledger clock, which is ahead of the client's.
- **A test token could not be minted to its own issuer**, and `token:create` never
  loaded `.env`, so it generated a fresh key and stranded the supply under a key
  nothing else had.
- **Two deployment checks passed only because every role shared one key**: the
  verification script compared the escrow's treasury against the admin, and the
  smoke test's fee assertion read an account that was both treasury and token
  issuer, where a received payment lowers the reported balance. Both are now run
  against a deployment with separate admin, attester and treasury keys.
- **`make test` never ran the Node suites.** It changed directory into `contracts`
  and stayed there, so every later `cd` failed.
- The console's Edge bundle pulled `node:crypto` in through the role vocabulary,
  which stopped it building; the fix was a seam, not a build flag.

### Security

- The console is `noindex` by metadata and by an `x-robots-tag` header, and is
  asserted per route.
- A request whose path matches no policy is refused rather than forwarded, and
  `requestedBy`/`approvedBy` are removed from request bodies and rewritten from the
  session.

[Unreleased]: https://github.com/Soroban-RemitBridge/Soroban-RemitBridge-Solutionz/commits/main
