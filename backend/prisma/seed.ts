import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

import { prisma } from '../src/db/client.js';
import { logger } from '../src/lib/logger.js';

/**
 * Seed the read model with the network configuration.
 *
 * This reads the *same* file the deployment script deploys from, and that is the
 * point rather than a convenience. The tier bands an operator console explains to
 * a sender, the bands the backend preflights against, and the bands the
 * compliance hook enforces must be the same numbers; two hand-maintained copies
 * drift, and the drift is invisible until a customer is told "no ID needed" and
 * then refused at the counter.
 *
 * The contract remains the authority. This is the read model, and
 * `syncCorridorConfig` reconciles it — but starting from the deployment config
 * means the common case needs no reconciliation at all.
 *
 * Idempotent: safe to run repeatedly.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../..');

const regionSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  countryCode: z.string(),
  currency: z.string(),
  minBond: z.string(),
  maxAgents: z.number(),
  utilizationCapBps: z.number(),
});

const corridorSchema = z.object({
  id: z.string(),
  regionId: z.string(),
  sourceCurrency: z.string(),
  destCurrency: z.string(),
  tier1Max: z.string(),
  tier2Max: z.string(),
  dailyLimit: z.string(),
  spreadBps: z.number(),
});

const configSchema = z.object({
  regions: z.array(regionSchema),
  corridors: z.array(corridorSchema),
});

function loadConfig(): z.infer<typeof configSchema> {
  const configured = process.env['DEPLOY_CONFIG'] ?? 'scripts/config/testnet.json';
  const candidates = [configured, 'scripts/config/testnet.example.json'];

  for (const candidate of candidates) {
    const path = resolve(REPO_ROOT, candidate);
    try {
      const parsed = configSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (parsed.success) {
        logger.info({ path: candidate }, 'seeding from deployment config');
        return parsed.data;
      }
      throw new Error(
        `Deployment config at ${path} is invalid: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
    } catch (cause) {
      // A missing real config is expected on a fresh clone; the example is a
      // legitimate fallback because it describes the same network.
      if (candidate !== candidates[candidates.length - 1]) continue;
      throw new Error(`Could not load a deployment config. Tried ${candidates.join(', ')}. ${String(cause)}`);
    }
  }

  throw new Error('unreachable: no config candidate succeeded');
}

async function main(): Promise<void> {
  const config = loadConfig();

  for (const region of config.regions) {
    // `upsert` rather than `create`: re-running the seed after an operator edits
    // a bond minimum must update the row, not fail on the unique id.
    await prisma.region.upsert({
      where: { id: region.id },
      create: {
        id: region.id,
        displayName: region.displayName,
        countryCode: region.countryCode,
        currency: region.currency,
        minBond: region.minBond,
        maxAgents: region.maxAgents,
        active: true,
      },
      update: {
        displayName: region.displayName,
        countryCode: region.countryCode,
        currency: region.currency,
        minBond: region.minBond,
        maxAgents: region.maxAgents,
      },
    });
  }

  for (const corridor of config.corridors) {
    await prisma.corridor.upsert({
      where: { id: corridor.id },
      create: {
        id: corridor.id,
        sourceCurrency: corridor.sourceCurrency,
        destCurrency: corridor.destCurrency,
        regionId: corridor.regionId,
        tier1Max: corridor.tier1Max,
        tier2Max: corridor.tier2Max,
        dailyLimit: corridor.dailyLimit,
        spreadBps: corridor.spreadBps,
        active: true,
      },
      update: {
        sourceCurrency: corridor.sourceCurrency,
        destCurrency: corridor.destCurrency,
        regionId: corridor.regionId,
        tier1Max: corridor.tier1Max,
        tier2Max: corridor.tier2Max,
        dailyLimit: corridor.dailyLimit,
        spreadBps: corridor.spreadBps,
      },
    });
  }

  logger.info(
    { regions: config.regions.length, corridors: config.corridors.length },
    'seed complete',
  );

  // Deliberately no agents, users or transfers. Those arrive through the normal
  // flows — a fixture agent with a fabricated bond would show up in an operator's
  // exposure view as real, and the whole point of this read model is that it
  // reflects the chain.
  logger.info('no agents, users or transfers were created: run the indexer to project them');
}

main()
  .catch((error: unknown) => {
    logger.error({ error: error instanceof Error ? error.message : String(error) }, 'seed failed');
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
