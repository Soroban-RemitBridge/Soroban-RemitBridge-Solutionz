import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

/**
 * Environment schema.
 *
 * Parsed once at import time and failing fast, so a missing contract address is
 * a boot error with a named variable rather than a `undefined` that surfaces
 * three layers down as a malformed XDR call.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  STELLAR_NETWORK: z.enum(['testnet', 'futurenet', 'mainnet', 'local']).default('testnet'),
  SOROBAN_RPC_URL: z.string().url(),
  STELLAR_NETWORK_PASSPHRASE: z.string().min(1),

  CONTRACT_ESCROW: z.string().startsWith('C', 'expected a contract (C...) address'),
  CONTRACT_AGENT_REGISTRY: z.string().startsWith('C', 'expected a contract (C...) address'),
  CONTRACT_COMPLIANCE_HOOK: z.string().startsWith('C', 'expected a contract (C...) address'),
  CONTRACT_LIQUIDITY_POOL: z.string().startsWith('C', 'expected a contract (C...) address'),

  ATTESTER_SECRET_KEY: z.string().startsWith('S', 'expected a secret (S...) key'),
  OPERATOR_SECRET_KEY: z.string().startsWith('S', 'expected a secret (S...) key'),
  TREASURY_PUBLIC_KEY: z.string().startsWith('G', 'expected a public (G...) key'),

  KYC_PROVIDER: z.enum(['mock', 'sumsub', 'onfido']).default('mock'),
  KYC_PROVIDER_API_KEY: z.string().optional(),
  KYC_PROVIDER_WEBHOOK_SECRET: z.string().optional(),
  KYC_ATTESTATION_TTL_DAYS: z.coerce.number().int().positive().default(365),

  DEFAULT_SPREAD_BPS: z.coerce.number().int().min(0).max(2_000).default(75),
  QUOTE_TTL_SECONDS: z.coerce.number().int().min(5).max(600).default(45),
  QUOTE_SIGNING_SECRET_KEY: z.string().startsWith('S', 'expected a secret (S...) key'),

  INDEXER_START_LEDGER: z.union([z.literal('latest'), z.coerce.number().int().nonnegative()]).default('latest'),
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  INDEXER_STORE_RAW_XDR: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  AGENT_FLOAT_ALERT_BPS: z.coerce.number().int().min(0).max(10_000).default(3_000),
  POOL_UTILIZATION_ALERT_BPS: z.coerce.number().int().min(0).max(10_000).default(7_000),
  MIN_POOL_RESERVE_BPS: z.coerce.number().int().min(0).max(10_000).default(2_000),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Variables that must never reach a log line, an error response or a stack trace.
 * `logger.ts` redacts these keys defensively, because the realistic leak is not
 * malice — it is someone logging the whole config object while debugging.
 */
export const SECRET_ENV_KEYS = [
  'ATTESTER_SECRET_KEY',
  'OPERATOR_SECRET_KEY',
  'QUOTE_SIGNING_SECRET_KEY',
  'KYC_PROVIDER_API_KEY',
  'KYC_PROVIDER_WEBHOOK_SECRET',
  'DATABASE_URL',
] as const;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

export const env: Env = parseEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
