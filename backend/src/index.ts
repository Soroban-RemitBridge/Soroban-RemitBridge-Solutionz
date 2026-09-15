import type { Server } from 'node:http';

import { createServer } from './api/server.js';
import { env } from './config/env.js';
import { disconnect, prisma } from './db/client.js';
import { logger } from './lib/logger.js';
import { expireStaleAttestations } from './kyc-orchestration/service.js';

/**
 * Process entrypoint.
 *
 * Shutdown order is deliberate: stop accepting connections, finish in-flight
 * requests, then release the database. Closing the pool first would sever requests
 * that are mid-transaction, which for a transfer endpoint means a client sees a
 * failure for work that actually succeeded.
 */
async function main(): Promise<void> {
  await prisma.$connect();

  const app = createServer();
  const server: Server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, network: env.STELLAR_NETWORK, kycProvider: env.KYC_PROVIDER },
      'remitbridge backend listening',
    );
  });

  // Attestation expiry is a status transition, not a chain write: the contract
  // compares `expires_at` against the ledger clock on every check. This sweep
  // exists so the dashboard and the database-backed preflight agree with it.
  const sweep = setInterval(() => {
    void expireStaleAttestations().catch((error: unknown) => {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, 'attestation sweep failed');
    });
  }, 15 * 60 * 1_000);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    clearInterval(sweep);
    server.close(() => {
      void disconnect().then(() => process.exit(0));
    });
    // Bounded wait: a request that will not finish must not hold the process open
    // until the supervisor SIGKILLs it, which would look like a crash.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection');
    shutdown('unhandledRejection');
  });
}

main().catch((error: unknown) => {
  logger.fatal({ error: error instanceof Error ? error.message : String(error) }, 'failed to start');
  process.exit(1);
});
