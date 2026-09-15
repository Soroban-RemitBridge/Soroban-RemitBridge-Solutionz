import { PrismaClient } from '@prisma/client';

import { env, isProduction } from '../config/env.js';

/**
 * Prisma client.
 *
 * `BigInt` support is enabled explicitly rather than left to a global
 * monkey-patch. `Transfer.id` is a `bigint` because it mirrors an on-chain `u64`,
 * and the alternative — `(BigInt.prototype as any).toJSON = ...` somewhere in a
 * bootstrap file — is the kind of global mutation that makes a serialisation bug
 * impossible to trace back to its source.
 *
 * A single instance is reused across hot reloads in development. Without this,
 * `tsx watch` accumulates connection pools until Postgres refuses new ones, which
 * looks like a database outage rather than a dev-server quirk.
 */
declare global {
  // `var` is required here: a `declare global` block cannot introduce a
  // `const`/`let` binding, and this is the binding Prisma's own docs prescribe.
  var __remitbridgePrisma: PrismaClient | undefined;
}

function createClient(): PrismaClient {
  return new PrismaClient({
    log: isProduction
      ? [{ emit: 'event', level: 'error' }]
      : [
          { emit: 'event', level: 'error' },
          { emit: 'event', level: 'warn' },
        ],
    errorFormat: isProduction ? 'minimal' : 'pretty',
  });
}

export const prisma: PrismaClient = globalThis.__remitbridgePrisma ?? createClient();

if (!isProduction) {
  globalThis.__remitbridgePrisma = prisma;
}

/** Disconnect cleanly on shutdown so in-flight transactions are not severed. */
export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}

export type Db = typeof prisma;

export { env as databaseEnv };
