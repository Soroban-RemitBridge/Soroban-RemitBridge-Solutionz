import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { prisma } from '../db/client.js';
import { notFound, validationFailed } from '../lib/errors.js';
import { fromStroops, toStroops } from '../lib/money.js';

/**
 * Sender-facing transfer tracking.
 *
 * Reads come from the indexed read model, never from a chain call on the request
 * path. A sender checking "where is my money" must not get a 503 because an RPC
 * node is having a bad minute, and the read model is the same data the chain
 * produced anyway — one ledger behind at worst, and the response says how stale
 * it might be.
 */

const listQuerySchema = z.object({
  senderId: z.string().uuid().optional(),
  corridorId: z.string().min(2).max(12).optional(),
  status: z.enum(['PENDING', 'CLAIMED', 'REFUNDED', 'CANCELLED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function transfersRouter(): Router {
  const router = Router();

  router.get('/transfers', async (req: Request, res: Response) => {
    const query = listQuerySchema.safeParse(req.query);
    if (!query.success) throw validationFailed({ issues: query.error.issues });

    const [transfers, cursor] = await Promise.all([
      prisma.transfer.findMany({
        where: {
          ...(query.data.senderId ? { senderId: query.data.senderId } : {}),
          ...(query.data.corridorId ? { corridorId: query.data.corridorId } : {}),
          ...(query.data.status ? { status: query.data.status } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: query.data.limit,
        include: {
          corridor: { select: { id: true, destCurrency: true } },
          agent: { select: { id: true, tradingName: true, legalName: true } },
        },
      }),
      prisma.indexerCursor.findFirst({ orderBy: { lastLedger: 'asc' } }),
    ]);

    res.json({
      transfers: transfers.map(serialiseTransfer),
      // Surfaced so a client can tell "no results" apart from "the indexer has not
      // caught up yet". Without it, a lagging indexer looks like a lost transfer.
      indexer: { lastLedger: cursor?.lastLedger ?? null, updatedAt: cursor?.updatedAt ?? null },
    });
  });

  router.get('/transfers/:id/status', async (req: Request, res: Response) => {
    const id = req.params.id ?? '';
    if (!/^\d+$/.test(id)) throw validationFailed({ id: 'expected a numeric transfer id' });

    const transfer = await prisma.transfer.findUnique({
      where: { id: BigInt(id) },
      include: {
        corridor: true,
        agent: { select: { id: true, tradingName: true, legalName: true, regionId: true } },
        events: { orderBy: [{ ledger: 'asc' }, { eventIndex: 'asc' }] },
      },
    });
    if (!transfer) throw notFound('transfer', id);

    const now = Date.now();
    const expired = transfer.status === 'PENDING' && transfer.expiry.getTime() < now;

    res.json({
      ...serialiseTransfer(transfer),
      // The recipient-facing answer. `expired` but not yet refunded is a real and
      // common state — anyone may trigger the refund, so the window between
      // expiry and refund is not an error condition.
      expired,
      refundable: expired,
      timeline: transfer.events.map((event) => ({
        topic: event.topic,
        ledger: event.ledger,
        txHash: event.txHash,
        occurredAt: event.occurredAt,
      })),
    });
  });

  router.get('/transfers/:id/receipt', async (req: Request, res: Response) => {
    const id = req.params.id ?? '';
    if (!/^\d+$/.test(id)) throw validationFailed({ id: 'expected a numeric transfer id' });

    const transfer = await prisma.transfer.findUnique({
      where: { id: BigInt(id) },
      include: { corridor: true, agent: true },
    });
    if (!transfer) throw notFound('transfer', id);

    res.json({
      transferId: transfer.id.toString(),
      status: transfer.status,
      amount: fromStroops(BigInt(transfer.amount.toString())),
      fee: fromStroops(BigInt(transfer.fee.toString())),
      payout: fromStroops(BigInt(transfer.payout.toString())),
      corridor: transfer.corridor.id,
      agent: transfer.agent ? { id: transfer.agent.id, name: transfer.agent.tradingName ?? transfer.agent.legalName } : null,
      createdAt: transfer.createdAt,
      settledAt: transfer.settledAt,
      // The claim hash, not the code, and not the recipient's identity. A receipt
      // is a public artefact the moment it is emailed; everything identifiable is
      // deliberately absent from it.
      claimHash: transfer.claimHash,
      settleTxHash: transfer.settleTxHash,
    });
  });

  /** Taker-side helper: what would this amount cost, before creating anything. */
  router.post('/transfers/preflight', async (req: Request, res: Response) => {
    const body = z
      .object({
        corridorId: z.string().min(2).max(12),
        amount: z.string().regex(/^\d+(\.\d{1,7})?$/),
      })
      .safeParse(req.body);
    if (!body.success) throw validationFailed({ issues: body.error.issues });

    const corridor = await prisma.corridor.findUnique({ where: { id: body.data.corridorId } });
    if (!corridor) throw notFound('corridor', body.data.corridorId);

    const amount = toStroops(body.data.amount);
    const tier1Max = BigInt(corridor.tier1Max.toString());
    const tier2Max = BigInt(corridor.tier2Max.toString());

    res.json({
      corridorId: corridor.id,
      amountStroops: amount.toString(),
      requiredTier: amount <= tier1Max ? 'NONE' : amount <= tier2Max ? 'STANDARD' : 'ENHANCED',
      withinDailyLimit: amount <= BigInt(corridor.dailyLimit.toString()),
      active: corridor.active,
    });
  });

  return router;
}

interface SerialisableTransfer {
  id: bigint;
  amount: unknown;
  fee?: unknown;
  payout?: unknown;
  status: string;
  expiry: Date;
  createdAt: Date;
  settledAt: Date | null;
}

/**
 * Amounts leave the API as strings.
 *
 * A JSON number would be parsed as a double on the way out, which is the same
 * precision loss the database schema and the money helpers exist to avoid.
 * `id` is a `bigint` for the same reason and is stringified here rather than
 * relying on a global `BigInt.prototype` patch.
 */
function serialiseTransfer(transfer: SerialisableTransfer): Record<string, unknown> {
  return {
    ...transfer,
    id: transfer.id.toString(),
    amount: transfer.amount === undefined ? undefined : String(transfer.amount),
    fee: transfer.fee === undefined ? undefined : String(transfer.fee),
    payout: transfer.payout === undefined ? undefined : String(transfer.payout),
  };
}
