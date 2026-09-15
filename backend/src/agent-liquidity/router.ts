import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { notFound, validationFailed } from '../lib/errors.js';
import { toStroops } from '../lib/money.js';
import { prisma } from '../db/client.js';
import {
  decideTopUp,
  executeTopUp,
  proposeTopUp,
  sweepRegion,
} from './service.js';

const proposeSchema = z.object({
  agentId: z.string().uuid(),
  regionId: z.string().min(2).max(12),
  amount: z.string().regex(/^\d+(\.\d{1,7})?$/),
  reason: z.string().min(4).max(500),
  requestedBy: z.string().min(1),
});

const decisionSchema = z.object({
  approved: z.boolean(),
  approvedBy: z.string().min(1),
  note: z.string().max(500).optional(),
});

export function agentLiquidityRouter(): Router {
  const router = Router();

  /** Agent detail: the view the operator dashboard and the agent app both use. */
  router.get('/agents/:id', async (req: Request, res: Response) => {
    const id = req.params.id ?? '';
    const agent = await prisma.agent.findUnique({
      where: { id },
      include: {
        region: true,
        exposure: true,
        alerts: { where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] } }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!agent) throw notFound('agent', id);

    const bond = BigInt(agent.bondAmount.toString());
    const drawn = agent.exposure.reduce((total, row) => total + BigInt(row.drawnAmount.toString()), 0n);

    res.json({
      ...agent,
      bondAmount: bond.toString(),
      totalDrawn: drawn.toString(),
      collateralRatioBps: 15_000,
      requiredBond: ((drawn * 15_000n) / 10_000n).toString(),
    });
  });

  router.get('/agents', async (req: Request, res: Response) => {
    const query = z
      .object({
        regionId: z.string().optional(),
        status: z.enum(['PENDING', 'AUTHORIZED', 'SUSPENDED', 'REVOKED']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .safeParse(req.query);
    if (!query.success) throw validationFailed({ issues: query.error.issues });

    const agents = await prisma.agent.findMany({
      where: {
        ...(query.data.regionId ? { regionId: query.data.regionId } : {}),
        ...(query.data.status ? { status: query.data.status } : {}),
      },
      orderBy: { registeredAt: 'desc' },
      take: query.data.limit,
      include: { exposure: true, _count: { select: { alerts: true } } },
    });

    res.json({ agents });
  });

  /** Run one monitoring sweep; used by cron and by the dashboard's refresh. */
  router.post('/agents/liquidity/sweep', async (req: Request, res: Response) => {
    const body = z.object({ regionId: z.string().min(2).max(12) }).safeParse(req.body);
    if (!body.success) throw validationFailed({ issues: body.error.issues });

    const result = await sweepRegion(body.data.regionId);
    res.json(result);
  });

  router.get('/agents/liquidity/alerts', async (req: Request, res: Response) => {
    const query = z
      .object({
        status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']).default('OPEN'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .safeParse(req.query);
    if (!query.success) throw validationFailed({ issues: query.error.issues });

    const alerts = await prisma.agentFloatAlert.findMany({
      where: { status: query.data.status },
      orderBy: { createdAt: 'desc' },
      take: query.data.limit,
      include: { agent: { select: { id: true, tradingName: true, legalName: true, regionId: true } } },
    });

    res.json({ alerts });
  });

  router.post('/agents/liquidity/top-ups', async (req: Request, res: Response) => {
    const body = proposeSchema.safeParse(req.body);
    if (!body.success) throw validationFailed({ issues: body.error.issues });

    const request = await proposeTopUp({
      agentId: body.data.agentId,
      regionId: body.data.regionId,
      amount: toStroops(body.data.amount),
      reason: body.data.reason,
      requestedBy: body.data.requestedBy,
    });
    res.status(201).json(request);
  });

  router.get('/agents/liquidity/top-ups', async (req: Request, res: Response) => {
    const query = z
      .object({
        status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .safeParse(req.query);
    if (!query.success) throw validationFailed({ issues: query.error.issues });

    const requests = await prisma.liquidityTopUpRequest.findMany({
      where: query.data.status ? { status: query.data.status } : {},
      orderBy: { createdAt: 'desc' },
      take: query.data.limit,
      include: { agent: { select: { id: true, tradingName: true, legalName: true } } },
    });
    res.json({ requests });
  });

  /**
   * Approve or reject a request.
   *
   * Approval is a separate call from execution on purpose: a human decides, a
   * machine acts, and the audit trail shows both. Collapsing them would let an
   * automated sweep move float without anyone having approved it.
   */
  router.post('/agents/liquidity/top-ups/:id/decision', async (req: Request, res: Response) => {
    const id = req.params.id ?? '';
    const body = decisionSchema.safeParse(req.body);
    if (!body.success) throw validationFailed({ issues: body.error.issues });

    const updated = await decideTopUp({
      requestId: id,
      approved: body.data.approved,
      approvedBy: body.data.approvedBy,
      ...(body.data.note ? { note: body.data.note } : {}),
    });
    res.json(updated);
  });

  router.post('/agents/liquidity/top-ups/:id/execute', async (req: Request, res: Response) => {
    const id = req.params.id ?? '';
    const result = await executeTopUp(id);
    res.json(result);
  });

  /** Region float overview for the pool-health panel. */
  router.get('/liquidity/regions/:regionId', async (req: Request, res: Response) => {
    const regionId = req.params.regionId ?? '';
    const [region, latest, exposure] = await Promise.all([
      prisma.region.findUnique({ where: { id: regionId } }),
      prisma.liquidityPoolSnapshot.findFirst({ where: { regionId }, orderBy: { capturedAt: 'desc' } }),
      prisma.agentExposure.aggregate({ where: { regionId }, _sum: { drawnAmount: true } }),
    ]);
    if (!region) throw notFound('region', regionId);

    const deposited = BigInt(latest?.totalDeposited.toString() ?? '0');
    const drawn = BigInt(latest?.totalDrawn.toString() ?? '0');
    const utilizationBps = deposited > 0n ? Number((drawn * 10_000n) / deposited) : 0;

    res.json({
      region,
      pool: {
        totalDeposited: deposited.toString(),
        totalDrawn: drawn.toString(),
        available: (deposited - drawn).toString(),
        utilizationBps,
        utilizationCapBps: latest?.utilizationBps ?? 0,
        capturedAt: latest?.capturedAt ?? null,
        stale: latest === null,
      },
      agentExposureTotal: exposure._sum.drawnAmount?.toString() ?? '0',
    });
  });

  return router;
}
