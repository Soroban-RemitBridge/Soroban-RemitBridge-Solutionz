/**
 * Test environment.
 *
 * Several units under test — the liquidity service, the KYC provider factory —
 * import `config/env` transitively, and that module parses the environment once
 * at import time and fails fast when something is missing. That fail-fast
 * behaviour is exactly what a deploy needs, so rather than weaken it the tests
 * supply a complete environment here.
 *
 * The values are obviously fake but have the right *shape*: contract addresses
 * start with `C`, secret keys with `S`, public keys with `G`. The schema is
 * therefore genuinely exercised rather than bypassed. Nothing connects to the
 * URL below.
 */

const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://remitbridge:remitbridge@localhost:5432/remitbridge_test?schema=public',
  SOROBAN_RPC_URL: 'http://127.0.0.1:8000/soroban/rpc',
  STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  CONTRACT_ESCROW: 'CTESTESCROW0000000000000000000000000000000000000000000',
  CONTRACT_AGENT_REGISTRY: 'CTESTREGISTRY00000000000000000000000000000000000000000',
  CONTRACT_COMPLIANCE_HOOK: 'CTESTCOMPLIANCE0000000000000000000000000000000000000000',
  CONTRACT_LIQUIDITY_POOL: 'CTESTPOOL000000000000000000000000000000000000000000000',
  ATTESTER_SECRET_KEY: 'STESTATTESTER000000000000000000000000000000000000000000',
  OPERATOR_SECRET_KEY: 'STESTOPERATOR000000000000000000000000000000000000000000',
  TREASURY_PUBLIC_KEY: 'GTESTTREASURY00000000000000000000000000000000000000000',
  QUOTE_SIGNING_SECRET_KEY: 'STESTQUOTESIGNER000000000000000000000000000000000000000',
};

for (const [key, value] of Object.entries(TEST_ENV)) {
  // The `??=` matters: an explicit variable from the shell (a real DATABASE_URL
  // for an integration run, say) must win over the placeholder.
  process.env[key] ??= value;
}
