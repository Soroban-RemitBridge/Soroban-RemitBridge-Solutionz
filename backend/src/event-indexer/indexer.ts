import { type Prisma } from '@prisma/client';
import { type xdr } from '@stellar/stellar-sdk';

import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { logger } from '../lib/logger.js';
import { server, networkPassphrase } from '../soroban/rpc.js';
import { decodeEvent, UndecodableEventError, type DecodedEvent, type RawContractEvent } from './decoder.js';

/**
 * Event indexer.
 *
 * Two design choices worth stating.
 *
 * **`ChainEvent` is the source of truth; `Transfer`, `Agent` and the pool
 * snapshots are derived views.** That is what makes the read model rebuildable: a
 * projection bug is fixed by replaying, not by a migration with a backfill of
 * unknown correctness. The audit row is written *after* the projection, not
 * before, because it carries a foreign key into the table the projection creates
 * — the ordering is explained at `persist`. Every projection is an upsert or an
 * idempotent update, so a crash between the two steps re-converges on the next
 * tick rather than double-counting.
 *
 * **The cursor advances only after the whole batch is written.** A crash
 * mid-batch re-processes events on restart, which is safe because every write is
 * an idempotent upsert keyed on `(contractId, ledger, eventIndex)`. The reverse
 * ordering — advance then write — turns a crash into permanently missing history,
 * and missing history in a payments ledger shows up as a customer being told
 * their money does not exist.
 */

export interface IndexerTickResult {
  fromLedger: number;
  toLedger: number;
  eventsDecoded: number;
  eventsSkipped: number;
  projectionsUpdated: number;
}

const CONTRACT_IDS = [
  env.CONTRACT_ESCROW,
  env.CONTRACT_AGENT_REGISTRY,
  env.CONTRACT_COMPLIANCE_HOOK,
  env.CONTRACT_LIQUIDITY_POOL,
];

/** Latest ledger the RPC node has closed. */
export async function latestLedger(): Promise<number> {
  const health = await server.getLatestLedger();
  return health.sequence;
}

async function cursorFor(contractId: string): Promise<number | null> {
  const row = await prisma.indexerCursor.findUnique({ where: { contractId } });
  return row?.lastLedger ?? null;
}

async function saveCursor(contractId: string, ledger: number): Promise<void> {
  await prisma.indexerCursor.upsert({
    where: { contractId },
    create: { contractId, lastLedger: ledger },
    update: { lastLedger: ledger },
  });
}

export async function fetchEvents(
  contractId: string,
  fromLedger: number,
  toLedger: number,
): Promise<RawContractEvent[]> {
  const response = await server.getEvents({
    startLedger: fromLedger,
    endLedger: toLedger,
    filters: [{ type: 'contract', contractIds: [contractId] }],
    limit: 200,
  });

  return response.events.map((event, index) => ({
    contractId,
    ledger: event.ledger,
    // The RPC response has no per-event index field in every SDK version, so the
    // position in the response is used. It is stable because the node returns
    // events in ledger order, and the uniqueness constraint then catches any
    // duplicate rather than double-counting a transfer.
    eventIndex: index,
    txHash: event.txHash,
    topicXdr: event.topic.map((topic: xdr.ScVal) => topic.toXDR('base64')),
    valueXdr: event.value.toXDR('base64'),
    closedAt: event.ledgerClosedAt,
  }));
}

/** One indexing pass across all four contracts. */
export async function tick(): Promise<IndexerTickResult> {
  const tip = await latestLedger();
  let eventsDecoded = 0;
  let eventsSkipped = 0;
  let projectionsUpdated = 0;
  let lowest = tip;

  for (const contractId of CONTRACT_IDS) {
    const stored = await cursorFor(contractId);
    const from =
      stored !== null
        ? stored + 1
        : env.INDEXER_START_LEDGER === 'latest'
          ? tip
          : env.INDEXER_START_LEDGER;

    if (from > tip) continue;
    lowest = Math.min(lowest, from);

    const events = await fetchEvents(contractId, from, tip);
    let highestWritten = from;

    for (const raw of events) {
      try {
        const decoded = decodeEvent(raw);
        const written = await persist(raw, decoded);
        eventsDecoded += 1;
        if (written) projectionsUpdated += 1;
        highestWritten = Math.max(highestWritten, raw.ledger);
      } catch (error) {
        if (error instanceof UndecodableEventError) {
          // Counted and logged, never swallowed. An undecodable event is a real
          // gap between the contracts and the indexer, and the only wrong
          // responses are to crash the loop or to ignore it quietly.
          eventsSkipped += 1;
          logger.error(
            { topic: error.topic, ledger: raw.ledger, txHash: raw.txHash, reason: error.message },
            'undecodable contract event',
          );
          highestWritten = Math.max(highestWritten, raw.ledger);
          continue;
        }
        throw error;
      }
    }

    await saveCursor(contractId, tip);
  }

  return {
    fromLedger: lowest,
    toLedger: tip,
    eventsDecoded,
    eventsSkipped,
    projectionsUpdated,
  };
}

/**
 * Persist one event and project it.
 *
 * Returns whether a projection changed, so the caller can log an actually-busy
 * tick rather than a busy-looking one.
 */
async function persist(raw: RawContractEvent, decoded: DecodedEvent): Promise<boolean> {
  const existing = await prisma.chainEvent.findUnique({
    where: {
      contractId_ledger_eventIndex: {
        contractId: raw.contractId,
        ledger: raw.ledger,
        eventIndex: raw.eventIndex,
      },
    },
    select: { id: true },
  });
  if (existing) return false;

  // Project *before* recording the audit row.
  //
  // `ChainEvent.transferId` is a foreign key into `Transfer`, and for a
  // `transfer.created` event the row it points at is created by this very
  // projection. Inserting the audit row first therefore failed with
  // `ChainEvent_transferId_fkey`, which took down not just that event but the
  // indexer loop — and because the row was never written, the cursor guard did
  // not stop the same event from failing again on the next tick.
  const changed = await project(raw, decoded);

  await prisma.chainEvent.create({
    data: {
      contractId: raw.contractId,
      topic: decoded.topic,
      ledger: raw.ledger,
      eventIndex: raw.eventIndex,
      txHash: raw.txHash,
      payload: asJson(decoded.payload),
      rawXdr: env.INDEXER_STORE_RAW_XDR ? JSON.stringify({ topic: raw.topicXdr, value: raw.valueXdr }) : null,
      // Linked only when there is a row to link to. A settlement event can
      // arrive with no local transfer — the indexer started after the event it
      // settles — and `projectTransferSettled` already records that as a warning
      // rather than inventing a transfer. A dangling reference here would fail the
      // insert and lose the event entirely, which is the opposite of what the raw
      // log is for.
      transferId: await linkableTransferId(decoded.transferId),
      occurredAt: new Date(raw.closedAt),
    },
  });

  return changed;
}

/** The transfer id to attach to an event, or null when no such row exists. */
async function linkableTransferId(id: bigint | null): Promise<bigint | null> {
  if (id === null) return null;
  const transfer = await prisma.transfer.findUnique({ where: { id }, select: { id: true } });
  return transfer?.id ?? null;
}

async function project(raw: RawContractEvent, decoded: DecodedEvent): Promise<boolean> {
  switch (decoded.kind) {
    case 'transfer.created':
      return projectTransferCreated(raw, decoded);
    case 'transfer.claimed':
      return projectTransferSettled(raw, decoded, 'CLAIMED');
    case 'transfer.refunded':
      return projectTransferSettled(raw, decoded, 'REFUNDED');
    case 'transfer.cancelled':
      return projectTransferSettled(raw, decoded, 'CANCELLED');
    case 'agent.status_changed':
      return projectAgentStatus(raw, decoded);
    case 'pool.drawn':
      return projectPoolDraw(decoded);
    default:
      // Config and admin events are recorded in `ChainEvent` and read from there
      // by the dashboard's audit timeline. Projecting them into their own tables
      // would duplicate state that only ever changes by operator action, which
      // the admin API records directly.
      return false;
  }
}

async function projectTransferCreated(raw: RawContractEvent, decoded: DecodedEvent): Promise<boolean> {
  const id = BigInt(String(decoded.payload['id']));
  const senderAddress = decoded.subjects[0] ?? '';
  const corridorId = decoded.subjects[1] ?? '';

  const [sender, corridor] = await Promise.all([
    prisma.user.findFirst({ where: { stellarAddress: senderAddress } }),
    prisma.corridor.findUnique({ where: { id: corridorId } }),
  ]);

  if (!sender || !corridor) {
    // The off-chain row does not exist yet — most often a transfer created before
    // the sender finished onboarding. Logged at warn with everything needed to
    // reconcile by hand, because a missing row here means the sender-facing
    // tracker will not show this transfer.
    logger.warn(
      { transferId: id.toString(), senderAddress, corridorId, ledger: raw.ledger },
      'transfer event has no matching off-chain user or corridor',
    );
    return false;
  }

  await prisma.transfer.upsert({
    where: { id },
    create: {
      id,
      senderId: sender.id,
      corridorId,
      amount: String(decoded.payload['amount']),
      tokenAddress: String(decoded.payload['token']),
      claimHash: String(decoded.payload['claimHash']),
      expiry: new Date(Number(BigInt(String(decoded.payload['expiry']))) * 1_000),
      status: 'PENDING',
      createdAt: new Date(raw.closedAt),
      createTxHash: raw.txHash,
    },
    update: {
      status: 'PENDING',
      createTxHash: raw.txHash,
    },
  });

  return true;
}

async function projectTransferSettled(
  raw: RawContractEvent,
  decoded: DecodedEvent,
  status: 'CLAIMED' | 'REFUNDED' | 'CANCELLED',
): Promise<boolean> {
  const id = BigInt(String(decoded.payload['id']));

  const existing = await prisma.transfer.findUnique({ where: { id } });
  if (!existing) {
    logger.warn({ transferId: id.toString(), status, ledger: raw.ledger }, 'settlement event with no transfer row');
    return false;
  }

  const claimedBy = decoded.subjects[0];

  await prisma.transfer.update({
    where: { id },
    data: {
      status,
      settledAt: new Date(raw.closedAt),
      settleTxHash: raw.txHash,
      ...(status === 'CLAIMED' && claimedBy ? { claimedBy } : {}),
      ...(status === 'CLAIMED'
        ? {
            fee: payloadAmount(decoded.payload['fee']),
            payout: payloadAmount(decoded.payload['payout']),
          }
        : {}),
    },
  });

  if (status === 'CLAIMED' && claimedBy) {
    const agent = await prisma.agent.findFirst({ where: { stellarAddress: claimedBy } });
    if (agent) {
      await prisma.transfer.update({ where: { id }, data: { agentId: agent.id } });
    }
  }

  return true;
}

async function projectAgentStatus(_raw: RawContractEvent, decoded: DecodedEvent): Promise<boolean> {
  const agentAddress = decoded.subjects[0];
  if (!agentAddress) return false;

  const payload = decoded.payload['value'];
  const to: unknown = Array.isArray(payload) ? (payload as unknown[])[1] : undefined;
  const statusMap: Record<string, 'PENDING' | 'AUTHORIZED' | 'SUSPENDED' | 'REVOKED'> = {
    Pending: 'PENDING',
    Authorized: 'AUTHORIZED',
    Suspended: 'SUSPENDED',
    Revoked: 'REVOKED',
  };
  const status = typeof to === 'string' ? statusMap[to] : undefined;
  if (!status) return false;

  const result = await prisma.agent.updateMany({
    where: { stellarAddress: agentAddress },
    data: {
      status,
      ...(status === 'AUTHORIZED' ? { authorizedAt: new Date() } : {}),
      ...(status === 'SUSPENDED' ? { suspendedAt: new Date() } : {}),
      ...(status === 'REVOKED' ? { revokedAt: new Date() } : {}),
    },
  });

  return result.count > 0;
}

async function projectPoolDraw(decoded: DecodedEvent): Promise<boolean> {
  const agentAddress = decoded.subjects[0];
  const regionId = decoded.subjects[1];
  if (!agentAddress || !regionId) return false;

  const agent = await prisma.agent.findFirst({ where: { stellarAddress: agentAddress } });
  if (!agent) return false;

  await prisma.agentExposure.upsert({
    where: { agentId_regionId: { agentId: agent.id, regionId } },
    create: { agentId: agent.id, regionId, drawnAmount: payloadAmount(decoded.payload['exposure']) },
    // Absolute, not incremented: the event carries the agent's resulting exposure,
    // so a replayed event converges on the same value instead of double-counting.
    update: { drawnAmount: payloadAmount(decoded.payload['exposure']) },
  });

  return true;
}

/**
 * Widen a decoded payload to Prisma's JSON input type.
 *
 * The decoder only emits JSON-safe values — strings, numbers, booleans, `null`,
 * arrays and plain objects, with every `bigint` already stringified — but that
 * is a runtime guarantee the type system cannot see through
 * `Record<string, unknown>`. The cast is unavoidable; it is confined to one
 * function, with the guarantee named, rather than scattered at each write.
 */
function asJson(payload: Record<string, unknown>): Prisma.InputJsonValue {
  return payload as Prisma.InputJsonValue;
}

/**
 * Read an amount out of a decoded payload as a string.
 *
 * The decoder already normalises `bigint`s to strings, so a value that is not a
 * string here is a decoding bug — and `String(unknown)` would turn it into
 * `"[object Object]"`, a plausible-looking amount in a reconciliation record.
 * Failing loudly is the only safe option.
 */
function payloadAmount(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  throw new Error(`expected a decimal string in the event payload, got ${typeof value}`);
}

/** Long-running loop used by `npm run indexer`. */
export async function run(shouldStop: () => boolean = () => false): Promise<void> {
  logger.info({ contracts: CONTRACT_IDS, intervalMs: env.INDEXER_POLL_INTERVAL_MS }, 'indexer started');
  while (!shouldStop()) {
    try {
      const result = await tick();
      if (result.eventsDecoded > 0 || result.eventsSkipped > 0) {
        logger.info(result, 'indexer tick');
      }
    } catch (error) {
      // The loop is deliberately never broken by a transient RPC failure: an
      // indexer that exits on a blip needs a supervisor to notice, and during
      // that window it is not indexing at all.
      logger.error({ error: error instanceof Error ? error.message : String(error) }, 'indexer tick failed');
    }
    await new Promise((resolve) => setTimeout(resolve, env.INDEXER_POLL_INTERVAL_MS));
  }
  void networkPassphrase;
}
