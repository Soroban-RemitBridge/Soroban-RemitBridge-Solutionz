import { z } from 'zod';

import { apiGet, apiGetRoot, type ApiResult } from './api';
import type {
  Agent,
  AgentDetail,
  Attestation,
  ComplianceTiers,
  Corridor,
  FloatAlert,
  KycConfig,
  PoolHealth,
  Readiness,
  TopUpRequest,
  TransferListResponse,
} from './types';

/**
 * Endpoint wrappers with runtime validation.
 *
 * The console is typed against the backend contract, but a type is a promise
 * only until something crosses the network. Each response is therefore validated
 * at the boundary: a field that the backend stops sending becomes a clear "this
 * panel is unavailable" state rather than the string `undefined` rendered into a
 * compliance table.
 *
 * Schemas declare exactly the fields the console reads. zod strips anything
 * undeclared, so a column added to the backend cannot quietly start appearing in
 * an operator's browser before anyone has decided it should.
 */

const regionSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  countryCode: z.string(),
  currency: z.string(),
  minBond: z.string(),
  maxAgents: z.number(),
  active: z.boolean(),
});

const corridorSchema = z.object({
  id: z.string(),
  sourceCurrency: z.string(),
  destCurrency: z.string(),
  regionId: z.string(),
  tier1Max: z.string(),
  tier2Max: z.string(),
  dailyLimit: z.string(),
  spreadBps: z.number(),
  active: z.boolean(),
  region: regionSchema,
});

const agentSchema = z.object({
  id: z.string(),
  stellarAddress: z.string(),
  settlementAddress: z.string(),
  legalName: z.string(),
  tradingName: z.string().nullable(),
  regionId: z.string(),
  status: z.enum(['PENDING', 'AUTHORIZED', 'SUSPENDED', 'REVOKED']),
  bondAmount: z.string(),
  registeredAt: z.string(),
  authorizedAt: z.string().nullable(),
  suspendedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  slashCount: z.number(),
});

const agentDetailSchema = agentSchema.extend({
  totalDrawn: z.string(),
  collateralRatioBps: z.number(),
  requiredBond: z.string(),
  region: regionSchema.optional(),
  exposure: z.array(z.object({ id: z.string(), regionId: z.string(), drawnAmount: z.string() })).optional(),
});

const attestationSchema = z.object({
  id: z.string(),
  userId: z.string(),
  tier: z.enum(['NONE', 'STANDARD', 'ENHANCED']),
  status: z.enum(['PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED']),
  regionId: z.string(),
  providerId: z.string(),
  issuedAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
});

const transferSchema = z.object({
  id: z.string(),
  corridorId: z.string(),
  amount: z.string(),
  fee: z.string(),
  payout: z.string(),
  tokenAddress: z.string(),
  claimHash: z.string(),
  status: z.enum(['PENDING', 'CLAIMED', 'REFUNDED', 'CANCELLED']),
  expiry: z.string(),
  createdAt: z.string(),
  settledAt: z.string().nullable(),
  claimedBy: z.string().nullable(),
  corridor: z.object({ id: z.string(), destCurrency: z.string() }).optional(),
  agent: z
    .object({ id: z.string(), legalName: z.string(), tradingName: z.string().nullable() })
    .nullable()
    .optional(),
});

const alertSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  regionId: z.string(),
  kind: z.enum(['FLOAT_LOW', 'COLLATERAL_TIGHT', 'POOL_UTILIZATION_HIGH']),
  thresholdBps: z.number(),
  observedBps: z.number(),
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']),
  createdAt: z.string(),
  agent: z
    .object({
      id: z.string(),
      legalName: z.string(),
      tradingName: z.string().nullable(),
      regionId: z.string(),
    })
    .optional(),
});

const topUpSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  regionId: z.string(),
  amountRequested: z.string(),
  reason: z.string(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED']),
  requestedBy: z.string(),
  approvedBy: z.string().nullable(),
  decisionNote: z.string().nullable(),
  txHash: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  executedAt: z.string().nullable(),
  agent: z
    .object({ id: z.string(), legalName: z.string(), tradingName: z.string().nullable() })
    .optional(),
});

const poolHealthSchema = z.object({
  region: regionSchema,
  pool: z.object({
    totalDeposited: z.string(),
    totalDrawn: z.string(),
    available: z.string(),
    utilizationBps: z.number(),
    utilizationCapBps: z.number(),
    capturedAt: z.string().nullable(),
    stale: z.boolean(),
  }),
  agentExposureTotal: z.string(),
});

const readinessSchema = z.object({
  status: z.string(),
  network: z.string(),
  networkLabel: z.string(),
  contracts: z.object({
    escrow: z.string(),
    agentRegistry: z.string(),
    complianceHook: z.string(),
    liquidityPool: z.string(),
  }),
  limits: z.object({ maxFeeBps: z.number() }),
  kycProvider: z.string(),
});

const kycConfigSchema = z.object({
  provider: z.string(),
  supportedTiers: z.array(z.enum(['NONE', 'STANDARD', 'ENHANCED'])),
  enhancedDueDiligence: z.boolean(),
  attestationTtlDays: z.number(),
  webhookSignatureRequired: z.boolean(),
});

/**
 * The schemas, exported for the test suite.
 *
 * This console's correctness is mostly a matter of what it *refuses* to render,
 * and that judgement lives here rather than in any component: an amount that
 * arrives as a JSON number, a status the console does not know, or a pool figure
 * missing its staleness flag all have to fail at this boundary or they render as
 * a confident wrong figure in front of an operator who is about to act on it.
 *
 * Exposing them is what makes that testable without a browser, which matters
 * because the alternative -- a component test suite -- is a much larger thing to
 * add, and would test the same assertions through a less direct route.
 */
export const __testing = {
  regionSchema,
  corridorSchema,
  agentSchema,
  agentDetailSchema,
  attestationSchema,
  transferSchema,
  alertSchema,
  topUpSchema,
  poolHealthSchema,
  readinessSchema,
  kycConfigSchema,
};

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered.length > 0 ? `?${rendered}` : '';
}

export const endpoints = {
  readiness: (): Promise<ApiResult<Readiness>> => apiGetRoot('/readyz', (body) => readinessSchema.parse(body)),

  kycConfig: (): Promise<ApiResult<KycConfig>> =>
    apiGet('/kyc/config', (body) => kycConfigSchema.parse(body)),

  agents: (params: { regionId?: string; status?: string; limit?: number } = {}): Promise<
    ApiResult<{ agents: Agent[] }>
  > =>
    apiGet(`/agents${query(params)}`, (body) =>
      z.object({ agents: z.array(agentSchema) }).parse(body),
    ),

  agent: (id: string): Promise<ApiResult<AgentDetail>> =>
    apiGet(`/agents/${encodeURIComponent(id)}`, (body) => agentDetailSchema.parse(body)),

  alerts: (status = 'OPEN'): Promise<ApiResult<{ alerts: FloatAlert[] }>> =>
    apiGet(`/agents/liquidity/alerts${query({ status })}`, (body) =>
      z.object({ alerts: z.array(alertSchema) }).parse(body),
    ),

  topUps: (status?: string): Promise<ApiResult<{ requests: TopUpRequest[] }>> =>
    apiGet(`/agents/liquidity/top-ups${query({ status })}`, (body) =>
      z.object({ requests: z.array(topUpSchema) }).parse(body),
    ),

  poolHealth: (regionId: string): Promise<ApiResult<PoolHealth>> =>
    apiGet(`/liquidity/regions/${encodeURIComponent(regionId)}`, (body) =>
      poolHealthSchema.parse(body),
    ),

  attestations: (params: { status?: string; regionId?: string; limit?: number } = {}): Promise<
    ApiResult<{ attestations: Attestation[]; expiresSweepable: number }>
  > =>
    apiGet(`/kyc/attestations${query(params)}`, (body) =>
      z.object({ attestations: z.array(attestationSchema), expiresSweepable: z.number() }).parse(body),
    ),

  transfers: (params: { corridorId?: string; status?: string; limit?: number } = {}): Promise<
    ApiResult<TransferListResponse>
  > =>
    apiGet(`/transfers${query(params)}`, (body) =>
      z
        .object({
          transfers: z.array(transferSchema),
          indexer: z.object({ lastLedger: z.number().nullable(), updatedAt: z.string().nullable() }),
        })
        .parse(body),
    ),

  corridors: (): Promise<ApiResult<{ corridors: Corridor[] }>> =>
    apiGet('/corridors', (body) =>
      z.object({ corridors: z.array(corridorSchema) }).parse(body),
    ),

  complianceTiers: (corridorId: string): Promise<ApiResult<ComplianceTiers>> =>
    apiGet(`/corridors/${encodeURIComponent(corridorId)}/compliance-tiers`, (body) =>
      z
        .object({
          corridorId: z.string(),
          tiers: z.array(
            z.object({
              tier: z.enum(['NONE', 'STANDARD', 'ENHANCED']),
              upTo: z.string(),
              description: z.string(),
            }),
          ),
          dailyLimit: z.string(),
          spreadBps: z.number(),
        })
        .parse(body),
    ),
};
