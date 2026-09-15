import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { StrKey } from '@stellar/stellar-sdk';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

/**
 * StrKey validation.
 *
 * The `startsWith('C')` checks below are replaced by real decoding because a
 * mistyped address that merely starts with the right letter passes a prefix test
 * and then fails much later — after Wasm has been uploaded and fees have been
 * paid. Validating here means a bad address costs nothing.
 */
const contractAddress = z
  .string()
  .refine((value) => StrKey.isValidContract(value), 'not a valid contract (C...) address');

const publicKey = z
  .string()
  .refine((value) => StrKey.isValidEd25519PublicKey(value), 'not a valid public (G...) key');

const secretKey = z
  .string()
  .refine((value) => StrKey.isValidEd25519SecretSeed(value), 'not a valid secret (S...) key');

/**
 * Deployment configuration.
 *
 * Parsed once and validated, for the same reason the backend does it: a
 * deployment that half-succeeds is far worse than one that refuses to start.
 * Half-succeeding here means four contracts on-chain with cross-references
 * pointing at the wrong instances, and there is no "undo" for an immutable
 * contract.
 */

const envSchema = z.object({
  STELLAR_NETWORK: z.enum(['testnet', 'futurenet', 'mainnet', 'local']).default('testnet'),
  SOROBAN_RPC_URL: z.string().url(),
  STELLAR_NETWORK_PASSPHRASE: z.string().min(1),

  /** The anchor operator key. Becomes the admin of all four contracts. */
  ADMIN_SECRET_KEY: secretKey,
  /** Receives settlement fees and slashed bond funds. */
  TREASURY_PUBLIC_KEY: publicKey,
  /**
   * The hot key the KYC service uses to publish attestations. Separate from the
   * admin key on purpose: the compliance service is the most exposed component,
   * so it must not be able to reconfigure thresholds or unpause the network.
   */
  ATTESTER_PUBLIC_KEY: publicKey,
  /**
   * The Stellar Asset Contract used for bonds and float. For testnet this is
   * usually a SAC wrapping a test asset, created before the deploy.
   */
  TOKEN_CONTRACT: contractAddress,

  /** Path to the deployment configuration, relative to the repository root. */
  DEPLOY_CONFIG: z.string().default('scripts/config/testnet.json'),
});

export type DeployEnv = z.infer<typeof envSchema>;

export function parseDeployEnv(source: NodeJS.ProcessEnv = process.env): DeployEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid deployment configuration:\n${details}`);
  }
  return result.data;
}

/* -------------------------------------------------------------------------- */
/* Deployment config file                                                     */
/* -------------------------------------------------------------------------- */

const regionSchema = z.object({
  id: z.string().min(2).max(12),
  displayName: z.string().min(2),
  countryCode: z.string().length(2),
  currency: z.string().min(3).max(4),
  minBond: z.string().regex(/^\d+$/, 'expected an integer number of stroops'),
  maxAgents: z.number().int().nonnegative(),
  utilizationCapBps: z.number().int().min(0).max(10_000),
});

const corridorSchema = z.object({
  id: z.string().min(2).max(12),
  regionId: z.string().min(2).max(12),
  sourceCurrency: z.string().min(3).max(4),
  destCurrency: z.string().min(3).max(4),
  tier1Max: z.string().regex(/^\d+$/),
  tier2Max: z.string().regex(/^\d+$/),
  dailyLimit: z.string().regex(/^\d+$/),
  spreadBps: z.number().int().min(0).max(2_000),
});

const tierSchema = z.object({
  corridorId: z.string().min(2).max(12),
  tier1Max: z.string().regex(/^\d+$/),
  tier2Max: z.string().regex(/^\d+$/),
  enhancedDailyLimit: z.string().regex(/^\d+$/),
});

const configSchema = z.object({
  regions: z.array(regionSchema).min(1),
  corridors: z.array(corridorSchema).min(1),
  complianceTiers: z.array(tierSchema).min(1),
  escrow: z.object({
    feeBps: z.number().int().min(0).max(10_000),
    maxExpirySecs: z.number().int().positive(),
  }),
  liquidityPool: z.object({
    collateralRatioBps: z.number().int().min(10_000).max(100_000),
    defaultUtilizationCapBps: z.number().int().min(0).max(10_000),
  }),
});

export type DeployConfig = z.infer<typeof configSchema>;
export type RegionConfig = z.infer<typeof regionSchema>;
export type CorridorConfig = z.infer<typeof corridorSchema>;

/**
 * Read and validate the deployment configuration.
 *
 * Cross-field checks happen here rather than in the schema because they are
 * about *consistency between records*, which Zod expresses poorly and a human
 * reads better as an explicit list of named failures.
 */
export function loadDeployConfig(path: string, repoRoot: string): DeployConfig {
  const absolute = resolve(repoRoot, path);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
  } catch (cause) {
    throw new Error(
      `Could not read deployment config at ${absolute}. Copy scripts/config/testnet.example.json to scripts/config/testnet.json first. (${String(cause)})`,
    );
  }

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid deployment config at ${absolute}:\n${details}`);
  }

  const config = parsed.data;
  const problems: string[] = [];

  const regionIds = new Set(config.regions.map((region) => region.id));
  for (const corridor of config.corridors) {
    if (!regionIds.has(corridor.regionId)) {
      problems.push(`corridor ${corridor.id} names unknown region ${corridor.regionId}`);
    }
    if (BigInt(corridor.tier1Max) > BigInt(corridor.tier2Max)) {
      problems.push(`corridor ${corridor.id} has tier1Max above tier2Max`);
    }
    if (BigInt(corridor.tier2Max) > BigInt(corridor.dailyLimit)) {
      problems.push(`corridor ${corridor.id} has tier2Max above dailyLimit`);
    }
  }

  const corridorIds = new Set(config.corridors.map((corridor) => corridor.id));
  for (const tier of config.complianceTiers) {
    if (!corridorIds.has(tier.corridorId)) {
      problems.push(`compliance tier config names unknown corridor ${tier.corridorId}`);
    }
  }

  // A corridor with no tier config would deploy with the hook's defaults, which
  // is exactly the kind of silent divergence the two-file arrangement exists to
  // prevent.
  for (const corridor of config.corridors) {
    if (!config.complianceTiers.some((tier) => tier.corridorId === corridor.id)) {
      problems.push(`corridor ${corridor.id} has no compliance tier configuration`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Deployment config is internally inconsistent:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }

  return config;
}
