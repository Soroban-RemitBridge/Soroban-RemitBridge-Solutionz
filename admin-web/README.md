# RemitBridge — operator console

Anchor-operator dashboard for the RemitBridge agent network. It covers the four
things an operator is accountable for:

| Page | What it answers |
| --- | --- |
| **Overview** | Which contracts is this deployment wired to, and what is waiting on a human? |
| **Agents** | Who is in the network, what bond do they hold, and how much float can they still draw? |
| **Liquidity** | Is any region short of cash, and which top-ups need approving? |
| **Compliance** | Which attestation references are live, and which transfers are past expiry without a refund? |
| **Corridors** | What does each corridor require of a sender, in tier bands and limits? |

## What it deliberately does not do

- **No keys.** Agent authorisation, slashing and tier thresholds are admin-gated
  on-chain and signed by the operator key held by the backend. This app is a
  control surface, not a signer.
- **No claim codes.** The escrow stores `sha256(reveal)`; the reveal belongs to
  the sender and the agent handling the payout. There is nowhere in this console
  to look one up, by design.
- **No personal data.** Attestations are shown as references and tiers. Names,
  documents and travel-rule payloads stay in the backend database.
- **No optimistic updates.** A top-up shows as approved only after the backend
  agrees. Displaying it earlier would be a lie attached to a settlement
  transaction.

## Trust boundary

Every read goes server-side from the Next.js server to the backend. Browser
mutations go through this app's own `/api/backend/*` proxy, so:

- the backend address never reaches a client bundle,
- the backend needs no CORS allowance,
- there is exactly one place browser-originated state changes leave the app.

The path is joined onto the configured base rather than taken from the request,
so the proxy cannot be used to reach arbitrary hosts.

## Local development

```bash
cp .env.example .env.local     # point REMITBRIDGE_API_URL at a running backend
npm install
npm run dev                    # http://localhost:3000
```

The backend must be reachable for any panel to have data. When it is not, each
panel says so explicitly and shows nothing — an unknown figure is never rendered
as `0`, because on a liquidity screen those two readings lead to opposite
decisions.

## Checks

```bash
npm run typecheck   # tsc --noEmit, strict
npm run lint        # eslint, zero warnings tolerated
npm run build       # next build
```

## Environment

| Variable | Purpose |
| --- | --- |
| `REMITBRIDGE_API_URL` | Backend base URL. **Server-only** — do not prefix with `NEXT_PUBLIC_`. |
| `NEXT_PUBLIC_ENVIRONMENT_LABEL` | Label shown in the header. Cosmetic, but an operator should always be able to see which deployment they are acting on. |

## Deployment

Deploys to Vercel as a standard Next.js app:

```bash
vercel --prod
```

Set `REMITBRIDGE_API_URL` in the project's environment variables. The headers in
`next.config.mjs` mark the whole app `noindex` — it should never be crawled, and
it is not an authorisation boundary either. Operator authentication is on the
roadmap in the repository root README; until it lands, put this behind a
network-level or platform-level access control.
