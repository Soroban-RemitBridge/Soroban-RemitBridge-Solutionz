import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDeployEnv } from './env.js';
import { createContext, readContract, scv } from './stellar.js';

/**
 * Verify a deployment by reading it back from the network.
 *
 * Independent of `deploy-contracts.ts` on purpose. That script verifies the
 * wiring of the deployment *it* just made, in the same process, from the same
 * variables it used to make it — which is useful, but it cannot answer the
 * question a reviewer actually has, which is "does the thing on-chain agree
 * with what the addresses file claims?". This reads a deployment's state out of
 * the RPC using nothing but `deployed-addresses.json`, the way the backend and
 * the indexer will.
 *
 * It checks three kinds of claim, in increasing strength:
 *
 *   1. Every contract responds to a read at all (a wrong id or a contract that
 *      was never deployed fails here).
 *   2. The configuration the deploy script applied is present — two regions,
 *      two corridors with tier bands, and the escrow's own fee settings.
 *   3. The cross-references point at *these* contracts. `escrow_config` must
 *      name the registry and hook in the same file; a deployment where the
 *      escrow points at a previous run's hook looks completely healthy until a
 *      compliance check silently consults the wrong contract.
 *
 * Reads nothing that costs a fee: every call is a simulation.
 *
 * Usage:
 *   npm run verify                # reads ../deployed-addresses.json
 *   npm run verify -- --file path # a different addresses file
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_ADDRESSES = resolve(REPO_ROOT, 'deployed-addresses.json');

interface Addresses {
  network: string;
  token: string;
  admin: string;
  /** Receives settlement fees. A distinct key from the admin in a real deployment. */
  treasury: string;
  contracts: {
    agentRegistry: string;
    complianceHook: string;
    liquidityPool: string;
    remitEscrow: string;
  };
  configuration: { feeBps: number; regions: string[]; corridors: string[] };
}

/** One assertion, so the output says what was checked rather than that it passed. */
interface Check {
  readonly subject: string;
  readonly claim: string;
}

const failures: string[] = [];
const checks: Check[] = [];

function record(subject: string, claim: string, ok: boolean): void {
  checks.push({ subject, claim: `${claim} ${ok ? '✓' : '✗'}` });
  if (!ok) failures.push(`${subject}: ${claim}`);
}

function sameSet(actual: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(actual)) return false;
  const got = [...actual].map(String).sort();
  const want = [...expected].sort();
  return got.length === want.length && got.every((value, index) => value === want[index]);
}

async function main(): Promise<void> {
  const fileArgIndex = process.argv.indexOf('--file');
  const path =
    fileArgIndex === -1
      ? DEFAULT_ADDRESSES
      : resolve(process.cwd(), process.argv[fileArgIndex + 1] ?? '');

  if (!existsSync(path)) {
    throw new Error(
      `No addresses file at ${path}. Deploy first (\`npm run deploy\`), or pass --file.`,
    );
  }

  const addresses = JSON.parse(readFileSync(path, 'utf8')) as Addresses;
  const env = parseDeployEnv();
  const context = createContext({
    rpcUrl: env.SOROBAN_RPC_URL,
    adminSecret: env.ADMIN_SECRET_KEY,
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE,
    // Never true: this script only simulates, and `readContract` is not
    // gated on it. Passing `false` keeps the intent explicit.
    dryRun: false,
  });

  const { agentRegistry, complianceHook, liquidityPool, remitEscrow } = addresses.contracts;
  console.log(`Verifying ${addresses.network} deployment from ${path}\n`);

  // 1. Does each contract answer?
  const regions = await readContract(context, agentRegistry, 'list_regions', []);
  record('agent-registry', 'responds to list_regions', Array.isArray(regions) && regions.length > 0);
  record(
    'agent-registry',
    `has the configured regions (${addresses.configuration.regions.join(', ')})`,
    sameSet(regions, addresses.configuration.regions),
  );

  const corridors = await readContract(context, complianceHook, 'list_corridors', []);
  record(
    'compliance-hook',
    `has the configured corridors (${addresses.configuration.corridors.join(', ')})`,
    sameSet(corridors, addresses.configuration.corridors),
  );

  // 2. Is the configuration present, and is it the configuration in this file?
  for (const corridor of addresses.configuration.corridors) {
    const thresholds = await readContract(context, complianceHook, 'get_tier_thresholds', [
      scv.symbol(corridor),
    ]);
    record(
      'compliance-hook',
      `has tier bands for ${corridor}`,
      thresholds !== null && thresholds !== undefined,
    );
  }

  const poolConfig = await readContract(context, liquidityPool, 'pool_config', []);
  record('liquidity-pool', 'is initialized (pool_config returns a value)', poolConfig != null);

  const escrowConfig = (await readContract(context, remitEscrow, 'escrow_config', [])) as {
    agent_registry?: string;
    compliance_hook?: string;
    treasury?: string;
    fee_bps?: number;
  } | null;
  record('remit-escrow', 'is initialized (escrow_config returns a value)', escrowConfig != null);

  // 3. The claim a partial deployment gets wrong: the cross-references.
  //    Rust structs cross the ABI as maps, so the field names arrive snake_case.
  record(
    'remit-escrow',
    'points at the registry in this file',
    escrowConfig?.agent_registry === agentRegistry,
  );
  record(
    'remit-escrow',
    'points at the compliance hook in this file',
    escrowConfig?.compliance_hook === complianceHook,
  );
  record(
    'remit-escrow',
    `charges the configured ${addresses.configuration.feeBps} bps`,
    escrowConfig?.fee_bps === addresses.configuration.feeBps,
  );
  record(
    'remit-escrow',
    'pays fees to the treasury in this file',
    // Compared against the recorded treasury, not against the admin. Those two
    // are distinct keys in a real deployment, and comparing to the admin made
    // this check pass only while the deployment happened to use one key for
    // both roles.
    escrowConfig?.treasury === addresses.treasury,
  );

  const stats = await readContract(context, remitEscrow, 'escrow_stats', []);
  record('remit-escrow', 'reports stats (a fresh deployment has none)', stats != null);

  // The token is a Stellar Asset Contract, so this is its own ABI rather than
  // this project's.
  const decimals = await readContract(context, addresses.token, 'decimals', []);
  record('token (SAC)', 'is live and answers decimals()', decimals !== undefined);

  for (const check of checks) {
    console.log(`  ${check.subject.padEnd(16)} ${check.claim}`);
  }

  console.log();
  if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed:\n`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`All ${checks.length} checks passed.`);
}

await main();
