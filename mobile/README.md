# RemitBridge — mobile app

React Native (Expo, expo-router) app with the three flows the network actually
runs on.

| Flow | Who uses it | What it needs from them |
| --- | --- | --- |
| **Sender** | Someone sending money across a corridor | A funded Stellar account to sign the escrow deposit |
| **Recipient** | The person collecting cash | **Nothing.** No wallet, no account, no seed phrase |
| **Agent** | A shop or kiosk paying out | An authorized agent account and a posted bond |

## The commit-reveal half that lives on the device

The escrow stores `sha256(reveal)` and never the reveal, and its `reveal`
parameter is `BytesN<32>`. The code design follows directly from that:

- The claim code is **exactly 32 characters** from a **32-symbol alphabet**, so
  its UTF-8 bytes are exactly 32 bytes and *are* the reveal. No encoding layer
  sits between what a customer writes down and what the contract receives, which
  removes the most likely place for this flow to break.
- The alphabet is **Crockford base32** — no `I`, `L`, `O` or `U`. Those are the
  characters people misread, and codes get read aloud across a counter.
- Entropy is **160 bits** (32 × 5), sourced from `expo-crypto`'s native CSPRNG,
  not `Math.random`.
- `normaliseClaimCode` repairs the two unambiguous slips (`I`/`L` → `1`,
  `O` → `0`) and rejects anything else rather than guessing.

`src/lib/claim.ts` is the whole of it and is worth reading before touching the
sender or agent flows.

## Wallet seam

`src/wallet/adapter.ts` defines `WalletAdapter` — `getPublicKey`,
`signTransaction(xdr, networkPassphrase)`, `isAvailable`. Two shapes fit behind
it:

- **Browser/extension wallets** (Freighter, xBull, Stellar Wallets Kit) sign in
  the wallet app, reached over WalletConnect or a deep link.
- **A key on the device**, which is what `LocalKeypairWallet` does. It stores the
  secret in the platform keychain and **refuses to sign on mainnet** — shipping a
  local key to production is a custody decision, and it should take someone
  writing code on purpose rather than inheriting a default.

Recipients never touch this seam at all, which is the point.

## Local development

```bash
cp .env.example .env
npm install
npm start          # then press i / a, or scan the QR with Expo Go
```

`EXPO_PUBLIC_API_URL` must point at a running backend. On a physical device
`localhost` is the phone, not your machine — use the machine's LAN address.

## Checks

```bash
npm run typecheck   # tsc --noEmit, strict
npm run lint        # eslint, zero warnings tolerated
npm test            # vitest: the claim code and money formatting
```

### What the suite covers, and how

`expo-crypto` is a native module, so `vitest.config.ts` aliases it to
`tests/expo-crypto.double.ts`, which implements both functions with
`node:crypto`. The double is deliberate rather than convenient: the property
under test is that **the code's actual UTF-8 bytes hash to what the chain will
verify against**, and a stub returning a fixed digest would assert that the code
calls a function rather than that the result is correct.

The assertions worth knowing about:

- **32 bytes, over 200 generated codes.** The escrow's `reveal` is `BytesN<32>`,
  so this is the property the whole design rests on — and it is a property of the
  generator, not of one output.
- **The hash is over the code bytes, and explicitly not over the grouped,
  human-facing form.** An implementation that formatted before hashing would
  produce codes that are unclaimable forever, and the contract cannot detect it.
- **The omitted characters are never generated** (`I`, `L`, `O`, `U`), and the
  generator is not returning a constant.
- **A digest is never returned for an input that cannot be honoured.** A lenient
  implementation would hand back a plausible hash for a code no reveal could
  satisfy.
- **Money formatting does not go via `Number`**, asserted past `2^53` stroops and
  on the sub-unit rounding direction.

## Builds

Expo Application Services handles both platforms without a local toolchain:

```bash
npx eas build --profile preview --platform android   # installable APK, good for reviewers
npx eas build --profile production --platform all
```

A hosted **preview** build is the most useful artefact for review: it is
installable without an app-store submission and exercises the real
sender → agent → recipient path against testnet.

## React Native notes

`src/polyfills.ts` installs `Buffer` and a secure `getRandomValues` before
anything from `@stellar/stellar-sdk` loads. It is imported first in
`src/app/_layout.tsx`, and that ordering is load-bearing: without the CSPRNG
polyfill, claim codes would fall back to a non-cryptographic source and become
guessable.
