import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDeployConfig, parseDeployEnv, type DeployConfig } from './env.js';
import {
  call,
  createContext,
  deployContract,
  readContract,
  scv,
  struct,
  uploadWasm,
  type DeployContext,
} from './stellar.js';

/**
 * Deploy and wire all four contracts.
 *
 * The order is not arbitrary:
 *
 *   1. **Upload and deploy all four first, initialize second.** Any failure
 *      before a contract is initialized leaves nothing behind but an unused
 *      instance — recoverable by deploying again. A failure *after* a partial
 *      initialization would leave live contracts pointing at zero addresses.
 *   2. **The registry and the hook are initialized before the escrow.** The
 *      escrow's `initialize` takes both as arguments and cannot be corrected
 *      afterwards without the admin key, so those two must exist first.
 *   3. **Wiring happens last, and is verified.** `set_escrow` on the hook, the
 *      region/corridor configuration, and the pool regions are all separate
 *      calls; each is read back before the script reports success.
 *
 * The script is idempotent in the sense that matters: it refuses to overwrite an
 * existing `deployed-addresses.json` unless `--force` is passed, because a
 * stray run against the wrong RPC endpoint should not silently repoint a
 * working backend.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const CONTRACTS = [
  { name: 'agent-registry', artifact: 'agent_registry.wasm' },
  { name: 'compliance-hook', artifact: 'compliance_hook.wasm' },
  { name: 'liquidity-pool', artifact: 'liquidity_pool.wasm' },
  { name: 'remit-escrow', artifact: 'remit_escrow.wasm' },
] as const;

const ARTIFACT_DIR = resolve(REPO_ROOT, 'contracts/target/wasm32-unknown-unknown/release');

interface DeployedAddresses {
  network: string;
  networkPassphrase: string;
  deployedAt: string;
  deployer: string;
  admin: string;
  treasury: string;
  attester: string;
  token: string;
  contracts: {
    agentRegistry: string;
    complianceHook: string;
    liquidityPool: string;
    remitEscrow: string;
  };
  configuration: {
    feeBps: number;
    maxExpirySecs: number;
    collateralRatioBps: number;
    defaultUtilizationCapBps: number;
    regions: string[];
    corridors: string[];
  };
}

function parseArgs(argv: string[]): { dryRun: boolean; force: boolean } {
  return {
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force'),
  };
}

function loadArtifact(fileName: string): Buffer {
  const path = resolve(ARTIFACT_DIR, fileName);
  try {
    return readFileSync(path);
  } catch (cause) {
    throw new Error(
      `Missing Wasm artifact at ${path}. Run \`npm run build:contracts\` first. (${String(cause)})`,
    );
  }
}

function assertSafeTarget(context: DeployContext, network: string, force: boolean): void {
  if (network === 'mainnet' && !force) {
    throw new Error(
      'Refusing to deploy to mainnet without --force. Check the RPC URL and the admin key first: an immutable contract deployed to a mistyped endpoint is not recoverable.',
    );
  }
  context.log(`Target network: ${network}`);
  context.log(`Admin account:  ${context.admin.publicKey()}`);
  context.log(`RPC endpoint:   ${context.server.serverURL.toString()}`);
}

async function main(): Promise<void> {
  const { dryRun, force } = parseArgs(process.argv.slice(2));
  const env = parseDeployEnv();
  const config: DeployConfig = loadDeployConfig(env.DEPLOY_CONFIG, REPO_ROOT);

  const context = createContext({
    rpcUrl: env.SOROBAN_RPC_URL,
    adminSecret: env.ADMIN_SECRET_KEY,
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE,
    dryRun,
  });

  assertSafeTarget(context, env.STELLAR_NETWORK, force);

  const addressesPath = resolve(REPO_ROOT, 'deployed-addresses.json');

  /* ---------------------------------------------------------------- upload */

  context.log('\n[1/5] Uploading Wasm and deploying instances…');

  // Local rather than module state: a redeploy in the same process must not be
  // able to reuse a previous run's addresses. That would be the worst possible
  // failure here — a backend repointed at a contract from an earlier deploy.
  const instances = new Map<string, string>();
  const admin = context.admin.publicKey();

  for (const contract of CONTRACTS) {
    const wasm = loadArtifact(contract.artifact);
    const hash = await uploadWasm(context, contract.name, wasm);

    const contractId = await deployContract(context, contract.name, hash);
    instances.set(contract.name, contractId);
    context.log(`  ${contract.name} → ${contractId}`);
  }

  const agentRegistry = instances.get('agent-registry');
  const complianceHook = instances.get('compliance-hook');
  const liquidityPool = instances.get('liquidity-pool');
  const remitEscrow = instances.get('remit-escrow');

  if (
    agentRegistry === undefined ||
    complianceHook === undefined ||
    liquidityPool === undefined ||
    remitEscrow === undefined
  ) {
    throw new Error('One or more contracts did not deploy; refusing to continue.');
  }

  /* ------------------------------------------------------------ initialize */

  context.log('\n[2/5] Initializing…');

  await call(
    context,
    agentRegistry,
    'initialize',
    [scv.address(admin), scv.address(env.TOKEN_CONTRACT), scv.address(env.TREASURY_PUBLIC_KEY)],
    'agent-registry.initialize',
  );

  await call(
    context,
    complianceHook,
    'initialize',
    [scv.address(admin)],
    'compliance-hook.initialize',
  );

  await call(
    context,
    liquidityPool,
    'initialize',
    [
      scv.address(admin),
      scv.address(agentRegistry),
      scv.address(env.TOKEN_CONTRACT),
      scv.u32(config.liquidityPool.collateralRatioBps),
      scv.u32(config.liquidityPool.defaultUtilizationCapBps),
    ],
    'liquidity-pool.initialize',
  );

  await call(
    context,
    remitEscrow,
    'initialize',
    [
      scv.address(admin),
      scv.address(agentRegistry),
      scv.address(complianceHook),
      scv.address(env.TREASURY_PUBLIC_KEY),
      scv.u32(config.escrow.feeBps),
      scv.u64(config.escrow.maxExpirySecs),
    ],
    'remit-escrow.initialize',
  );

  /* --------------------------------------------------------------- wire up */

  context.log('\n[3/5] Wiring cross-contract permissions…');

  // The hook only counts volume for the one escrow it knows about; without this
  // the tier check treats every transfer as coming from nowhere and the daily
  // limit is never enforced.
  await call(context, complianceHook, 'set_escrow', [scv.address(remitEscrow)], 'compliance-hook.set_escrow');
  await call(
    context,
    complianceHook,
    'set_operator',
    [scv.address(env.ATTESTER_PUBLIC_KEY), scv.bool(true)],
    'compliance-hook.set_operator(attester)',
  );

  /* ----------------------------------------------------------- configure */

  context.log('\n[4/5] Configuring regions, corridors and tier bands…');

  for (const region of config.regions) {
    await call(
      context,
      agentRegistry,
      'set_min_bond',
      [scv.symbol(region.id), scv.i128(region.minBond)],
      `agent-registry.set_min_bond(${region.id})`,
    );
    await call(
      context,
      liquidityPool,
      'open_region',
      [scv.symbol(region.id), scv.u32(region.utilizationCapBps)],
      `liquidity-pool.open_region(${region.id})`,
    );
  }

  for (const corridor of config.corridors) {
    // Mapping a corridor to a region is what makes `is_authorized_for_corridor`
    // meaningful; an unmapped corridor would authorize nobody.
    await call(
      context,
      agentRegistry,
      'map_corridor',
      [scv.symbol(corridor.id), scv.symbol(corridor.regionId)],
      `agent-registry.map_corridor(${corridor.id})`,
    );
  }

  for (const tier of config.complianceTiers) {
    // `set_tier_thresholds` takes the whole `TierThresholds` struct, not the
    // four fields separately — the contract has no positional overload.
    await call(
      context,
      complianceHook,
      'set_tier_thresholds',
      [
        struct({
          corridor_id: scv.symbol(tier.corridorId),
          tier1_max: scv.i128(tier.tier1Max),
          tier2_max: scv.i128(tier.tier2Max),
          daily_limit: scv.i128(tier.enhancedDailyLimit),
        }),
      ],
      `compliance-hook.set_tier_thresholds(${tier.corridorId})`,
    );
  }

  /* -------------------------------------------------------------- verify */

  context.log('\n[5/5] Verifying…');

  if (!dryRun) {
    // Read the wiring back rather than trusting the calls above. Every one of
    // these is a place where a wrong argument produces a live contract that
    // silently refuses to work, which is much harder to diagnose later than a
    // failure here.
    const escrowConfig = (await readContract(context, remitEscrow, 'escrow_config', [])) as
      | Record<string, unknown>
      | undefined;

    if (escrowConfig?.['agent_registry'] !== agentRegistry) {
      throw new Error('Escrow is not pointed at the registry that was just deployed.');
    }
    if (escrowConfig?.['compliance_hook'] !== complianceHook) {
      throw new Error('Escrow is not pointed at the compliance hook that was just deployed.');
    }
    if (escrowConfig?.['fee_bps'] !== config.escrow.feeBps) {
      throw new Error(
        `Escrow fee is ${String(escrowConfig?.['fee_bps'])}, expected ${config.escrow.feeBps}.`,
      );
    }

    for (const region of config.regions) {
      const registered = await readContract(context, agentRegistry, 'get_region', [
        scv.symbol(region.id),
      ]);
      if (registered === undefined || registered === null) {
        throw new Error(`Region ${region.id} was not registered on the registry.`);
      }
    }

    const poolRegions = await readContract(context, liquidityPool, 'list_pool_regions', []);
    const openRegions = new Set(Array.isArray(poolRegions) ? poolRegions.map(String) : []);
    for (const region of config.regions) {
      if (!openRegions.has(region.id)) {
        throw new Error(`Region ${region.id} has no pool: agents there could not draw float.`);
      }
    }

    // The tier bands are the ones a compliance decision actually rests on, so
    // they are compared field by field rather than merely checked for presence.
    for (const tier of config.complianceTiers) {
      const stored = (await readContract(context, complianceHook, 'get_tier_thresholds', [
        scv.symbol(tier.corridorId),
      ])) as Record<string, unknown> | undefined;

      if (stored === undefined || stored === null) {
        throw new Error(`No tier thresholds were stored for corridor ${tier.corridorId}.`);
      }
      if (String(stored['tier1_max']) !== tier.tier1Max) {
        throw new Error(
          `Corridor ${tier.corridorId}: tier1_max stored as ${String(stored['tier1_max'])}, expected ${tier.tier1Max}.`,
        );
      }
      if (String(stored['daily_limit']) !== tier.enhancedDailyLimit) {
        throw new Error(
          `Corridor ${tier.corridorId}: daily_limit stored as ${String(stored['daily_limit'])}, expected ${tier.enhancedDailyLimit}.`,
        );
      }
    }

    context.log(
      `  verified escrow wiring, ${config.regions.length} regions, ${config.complianceTiers.length} corridor tier configs`,
    );
  } else {
    context.log('  [dry-run] verification skipped (nothing was submitted)');
  }

  /* --------------------------------------------------------------- output */

  const output: DeployedAddresses = {
    network: env.STELLAR_NETWORK,
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE,
    deployedAt: new Date().toISOString(),
    deployer: admin,
    admin,
    treasury: env.TREASURY_PUBLIC_KEY,
    attester: env.ATTESTER_PUBLIC_KEY,
    token: env.TOKEN_CONTRACT,
    contracts: {
      agentRegistry,
      complianceHook,
      liquidityPool,
      remitEscrow,
    },
    configuration: {
      feeBps: config.escrow.feeBps,
      maxExpirySecs: config.escrow.maxExpirySecs,
      collateralRatioBps: config.liquidityPool.collateralRatioBps,
      defaultUtilizationCapBps: config.liquidityPool.defaultUtilizationCapBps,
      regions: config.regions.map((region) => region.id),
      corridors: config.corridors.map((corridor) => corridor.id),
    },
  };

  if (dryRun) {
    context.log('\nDry run complete. Nothing was submitted and no file was written.');
    context.log(JSON.stringify(output, null, 2));
    return;
  }

  writeFileSync(addressesPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  context.log(`\nWrote ${addressesPath}`);
  context.log('\nNext steps:');
  context.log('  1. Copy the four contract ids into backend/.env and admin-web/.env.local.');
  context.log('  2. Seed the read model:  cd backend && npm run prisma:seed');
  context.log('  3. Start the indexer:    cd backend && npm run indexer');
}

main().catch((error: unknown) => {
  process.stderr.write(`\nDeployment failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
