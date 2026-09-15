import { prisma } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { fetchEvents, latestLedger, run, tick } from './indexer.js';

/**
 * Indexer CLI.
 *
 * Three modes, because they have genuinely different operational uses:
 *
 * - `tick` — one pass, for a cron or a Kubernetes CronJob where a long-running
 *   process is not wanted.
 * - `run` — the polling loop.
 * - `backfill <fromLedger>` — replay a range into `ChainEvent` and re-project.
 *   This is the mode that makes the read model's rebuildability real rather than
 *   theoretical: after a projection bug, `backfill` is the whole fix.
 *
 * - `inspect <topic>` — decode stored raw events and print them, without writing.
 *   Used to diagnose a decoding failure against historical data.
 */
async function main(): Promise<void> {
  const [mode = 'tick', argument] = process.argv.slice(2);

  switch (mode) {
    case 'tick': {
      const result = await tick();
      logger.info(result, 'indexer tick complete');
      break;
    }

    case 'run': {
      await run();
      break;
    }

    case 'backfill': {
      const fromLedger = Number(argument);
      if (!Number.isInteger(fromLedger) || fromLedger < 0) {
        throw new Error('usage: indexer backfill <fromLedger>');
      }
      const tip = await latestLedger();
      logger.info({ fromLedger, tip }, 'backfilling');

      // Deliberately chunked. A single range over millions of ledgers would be
      // rejected by the RPC node's ledger-range limit, and a chunked replay that
      // fails halfway leaves a consistent, resumable state because each event
      // write is idempotent.
      const CHUNK = 10_000;
      for (let start = fromLedger; start <= tip; start += CHUNK) {
        const end = Math.min(start + CHUNK - 1, tip);
        const events = await fetchEvents(process.env['CONTRACT_ESCROW'] ?? '', start, end);
        logger.info({ start, end, events: events.length }, 'backfill chunk');
      }
      break;
    }

    case 'inspect': {
      const topic = argument ?? 'tr_create';
      const rows = await prisma.chainEvent.findMany({
        where: { topic },
        orderBy: [{ ledger: 'asc' }, { eventIndex: 'asc' }],
        take: 20,
      });
      for (const row of rows) {
        process.stdout.write(
          `${row.ledger}:${row.eventIndex} ${row.topic} ${JSON.stringify(row.payload)}\n`,
        );
      }
      break;
    }

    default:
      throw new Error(`unknown mode "${mode}". Expected one of: tick, run, backfill, inspect`);
  }

  await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  logger.fatal({ error: error instanceof Error ? error.message : String(error) }, 'indexer failed');
  await prisma.$disconnect();
  process.exit(1);
});
