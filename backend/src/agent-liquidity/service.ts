import { Keypair } from '@stellar/stellar-sdk';

import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { conflict, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { drawLiquidity, requiredBondFor } from '../soroban/contracts.js';
import { keypairFromSecret } from '../soroban/rpc.js';

/**
 * Agent liquidity monitoring.
 *
 * An agent running out of cash is not a technical incident, it is a queue of
 * people outside a shop who cannot collect their money. So the service watches
 * two distinct failure modes and names them separately:
 *
 * - `FLOAT_LOW`: the agent's undrawn float is thin relative to its bond, so it
 *   will be unable to settle soon.
 * - `COLLATERAL_TIGHT`: the bond itself is close to the draw, so the *next*
 *   draw would be refused by the pool no matter how much float is available.
 *
 * They have different remedies — top up the pool versus top up the bond — and
 * reporting them as one alert sends operators to the wrong fix.
 */

export type AlertKind = 'FLOAT_LOW' | 'COLLATERAL_TIGHT' | 'POOL_UTILIZATION_HIGH';

export interface LiquidityObservation {
  agentId: string;
  regionId: string;
  bond: bigint;
  drawn: bigint;
  undrawnCapacity: bigint;
  /** Undrawn float as a share of bond, in basis points. */
  floatRatioBps: number;
  /** Bond headroom over the required collateral, in basis points. */
  collateralHeadroomBps: number;
}

/**
 * Evaluate one agent's position.
 *
 * Pure and independently testable, which is the point: the arithmetic behind
 * "is this agent about to run dry" is exactly the kind of thing that should not
 * be entangled with a database read and an RPC call.
 */
export function evaluateAgent(observation: {
  bond: bigint;
  drawn: bigint;
  collateralRatioBps: number;
}): Pick<LiquidityObservation, 'undrawnCapacity' | 'floatRatioBps' | 'collateralHeadroomBps'> {
  const { bond, drawn, collateralRatioBps } = observation;
  const requiredForCurrent = (drawn * BigInt(collateralRatioBps)) / 10_000n;
  const headroom = bond > requiredForCurrent ? bond - requiredForCurrent : 0n;

  // How much more the agent could draw before the bond stops covering it.
  const undrawnCapacity = (headroom * 10_000n) / BigInt(collateralRatioBps || 1);

  const floatRatioBps = bond > 0n ? Number((undrawnCapacity * 10_000n) / bond) : 0;
  const collateralHeadroomBps = bond > 0n ? Number((headroom * 10_000n) / bond) : 0;

  return {
    undrawnCapacity,
    floatRatioBps,
    collateralHeadroomBps,
  };
}

export function classifyAlert(observation: LiquidityObservation): { kind: AlertKind; threshold: number; observed: number } | null {
  if (observation.collateralHeadroomBps < 1_000) {
    return { kind: 'COLLATERAL_TIGHT', threshold: 1_000, observed: observation.collateralHeadroomBps };
  }
  if (observation.floatRatioBps < env.AGENT_FLOAT_ALERT_BPS) {
    return { kind: 'FLOAT_LOW', threshold: env.AGENT_FLOAT_ALERT_BPS, observed: observation.floatRatioBps };
  }
  return null;
}

/**
 * Sweep every active agent in a region and open alerts where thresholds are
 * breached. Alerts are deduplicated against open rows so a monitoring loop that
 * runs every minute does not produce sixty alerts an hour per agent.
 */
export async function sweepRegion(regionId: string): Promise<{ evaluated: number; opened: number }> {
  const agents = await prisma.agent.findMany({
    where: { regionId, status: 'AUTHORIZED' },
    include: { exposure: { where: { regionId } } },
  });

  let opened = 0;
  for (const agent of agents) {
    const bond = BigInt(agent.bondAmount.toString());
    const drawn = BigInt(agent.exposure[0]?.drawnAmount.toString() ?? '0');

    const evaluation = evaluateAgent({ bond, drawn, collateralRatioBps: 15_000 });
    const observation: LiquidityObservation = {
      agentId: agent.id,
      regionId,
      bond,
      drawn,
      ...evaluation,
    };

    const alert = classifyAlert(observation);
    if (!alert) continue;

    const existing = await prisma.agentFloatAlert.findFirst({
      where: { agentId: agent.id, regionId, kind: alert.kind, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
    });
    if (existing) continue;

    await prisma.agentFloatAlert.create({
      data: {
        agentId: agent.id,
        regionId,
        kind: alert.kind,
        thresholdBps: alert.threshold,
        observedBps: alert.observed,
      },
    });
    opened += 1;
    logger.warn({ agentId: agent.id, regionId, kind: alert.kind }, 'liquidity alert opened');
  }

  return { evaluated: agents.length, opened };
}

export interface ProposeTopUpInput {
  agentId: string;
  regionId: string;
  amount: bigint;
  reason: string;
  requestedBy: string;
}

/**
 * Propose a top-up. Deliberately separate from executing it: a person approves,
 * a machine executes, and the split is recorded so the audit trail shows both.
 */
export async function proposeTopUp(input: ProposeTopUpInput) {
  const agent = await prisma.agent.findUnique({ where: { id: input.agentId } });
  if (!agent) throw notFound('agent', input.agentId);
  if (agent.status !== 'AUTHORIZED') {
    throw conflict('agent is not authorized in its region', { status: agent.status });
  }

  // Ask the chain rather than re-deriving the collateral rule locally. If these
  // two ever disagree, the chain is right and this number is a bug.
  const required = await requiredBondFor(agent.stellarAddress, input.regionId, input.amount);
  if (required !== undefined && BigInt(agent.bondAmount.toString()) < required) {
    throw conflict('bond does not cover the requested draw', {
      bond: agent.bondAmount.toString(),
      required: required.toString(),
      hint: 'top up the bond, not the pool',
    });
  }

  return prisma.liquidityTopUpRequest.create({
    data: {
      agentId: input.agentId,
      regionId: input.regionId,
      amountRequested: input.amount.toString(),
      reason: input.reason,
      requestedBy: input.requestedBy,
    },
  });
}

export async function decideTopUp(input: {
  requestId: string;
  approved: boolean;
  approvedBy: string;
  note?: string;
}) {
  const request = await prisma.liquidityTopUpRequest.findUnique({
    where: { id: input.requestId },
    include: { agent: true },
  });
  if (!request) throw notFound('top-up request', input.requestId);
  if (request.status !== 'PENDING') {
    throw conflict('request has already been decided', { status: request.status });
  }

  return prisma.liquidityTopUpRequest.update({
    where: { id: input.requestId },
    data: {
      status: input.approved ? 'APPROVED' : 'REJECTED',
      approvedBy: input.approvedBy,
      decisionNote: input.note ?? null,
      decidedAt: new Date(),
    },
  });
}

/**
 * Execute an approved top-up.
 *
 * The failure path is the interesting one. A rejected draw leaves the request in
 * `FAILED` with the chain's reason attached rather than silently reverting to
 * `APPROVED`, so the operator sees the pool's actual objection — usually
 * `UtilizationCapExceeded` or `InsufficientCollateral` — instead of a request
 * that appears stuck.
 */
export async function executeTopUp(requestId: string): Promise<{ txHash?: string; status: string }> {
  const request = await prisma.liquidityTopUpRequest.findUnique({
    where: { id: requestId },
    include: { agent: true },
  });
  if (!request) throw notFound('top-up request', requestId);
  if (request.status !== 'APPROVED') {
    throw conflict('only approved requests can be executed', { status: request.status });
  }

  const operator: Keypair = keypairFromSecret(env.OPERATOR_SECRET_KEY);

  try {
    const result = await drawLiquidity(
      operator,
      request.agent.stellarAddress,
      request.regionId,
      BigInt(request.amountRequested.toString()),
    );

    await prisma.$transaction([
      prisma.liquidityTopUpRequest.update({
        where: { id: requestId },
        data: { status: 'EXECUTED', txHash: result.hash ?? null, executedAt: new Date() },
      }),
      prisma.agentExposure.upsert({
        where: { agentId_regionId: { agentId: request.agentId, regionId: request.regionId } },
        create: {
          agentId: request.agentId,
          regionId: request.regionId,
          drawnAmount: request.amountRequested,
        },
        update: { drawnAmount: { increment: request.amountRequested } },
      }),
      prisma.agentFloatAlert.updateMany({
        where: { agentId: request.agentId, regionId: request.regionId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      }),
    ]);

    logger.info({ requestId, txHash: result.hash }, 'top-up executed');
    return { ...(result.hash ? { txHash: result.hash } : {}), status: 'EXECUTED' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await prisma.liquidityTopUpRequest.update({
      where: { id: requestId },
      data: { status: 'FAILED', failureReason: reason },
    });
    logger.error({ requestId, reason }, 'top-up failed');
    throw error;
  }
}
