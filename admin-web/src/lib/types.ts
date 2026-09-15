/**
 * Wire types for the operator console.
 *
 * These mirror the backend contract rather than importing the backend's own
 * types: the two run as separate deployments and share nothing but HTTP, so the
 * console should fail to compile when the contract changes, not silently agree
 * with a type that no longer crosses the wire.
 *
 * Every monetary field arrives as a *string*. That is deliberate on the
 * backend's side — amounts are `i128` and a JSON number would be parsed as a
 * double — and this file preserves that choice so nothing downstream can
 * accidentally do `amount * 1.02` on a value that lost precision in transit.
 */

export type AgentStatus = 'PENDING' | 'AUTHORIZED' | 'SUSPENDED' | 'REVOKED';
export type AttestationStatus = 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'REVOKED';
export type TransferStatus = 'PENDING' | 'CLAIMED' | 'REFUNDED' | 'CANCELLED';
export type TopUpStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXECUTED' | 'FAILED';
export type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
export type KycTier = 'NONE' | 'STANDARD' | 'ENHANCED';

export interface Region {
  id: string;
  displayName: string;
  countryCode: string;
  currency: string;
  minBond: string;
  maxAgents: number;
  active: boolean;
}

export interface Corridor {
  id: string;
  sourceCurrency: string;
  destCurrency: string;
  regionId: string;
  tier1Max: string;
  tier2Max: string;
  dailyLimit: string;
  spreadBps: number;
  active: boolean;
  region: Region;
}

export interface AgentExposureRow {
  id: string;
  regionId: string;
  drawnAmount: string;
}

export interface Agent {
  id: string;
  stellarAddress: string;
  settlementAddress: string;
  legalName: string;
  tradingName: string | null;
  regionId: string;
  status: AgentStatus;
  bondAmount: string;
  registeredAt: string;
  authorizedAt: string | null;
  suspendedAt: string | null;
  revokedAt: string | null;
  slashCount: number;
  // `| undefined` is spelled out on every optional field here because
  // `exactOptionalPropertyTypes` distinguishes "absent" from "present and
  // undefined". zod's `.optional()` produces the latter, so declaring the plain
  // optional form would make every validated response unassignable.
  region?: Region | undefined;
  exposure?: AgentExposureRow[] | undefined;
  _count?: { alerts: number } | undefined;
}

/**
 * Agent detail adds the collateral maths.
 *
 * `requiredBond` is computed by the backend from the *contract's* collateral
 * ratio rather than re-derived here, so the console cannot show an operator a
 * headroom figure that disagrees with the check the contract will actually make.
 */
export interface AgentDetail extends Agent {
  totalDrawn: string;
  collateralRatioBps: number;
  requiredBond: string;
}

export interface Attestation {
  id: string;
  userId: string;
  tier: KycTier;
  status: AttestationStatus;
  regionId: string;
  providerId: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface Transfer {
  id: string;
  corridorId: string;
  amount: string;
  fee: string;
  payout: string;
  tokenAddress: string;
  claimHash: string;
  status: TransferStatus;
  expiry: string;
  createdAt: string;
  settledAt: string | null;
  claimedBy: string | null;
  corridor?: { id: string; destCurrency: string } | undefined;
  agent?: { id: string; legalName: string; tradingName: string | null } | null | undefined;
}

export interface TransferListResponse {
  transfers: Transfer[];
  /** Indexer progress, so "no results" is distinguishable from "not yet indexed". */
  indexer: { lastLedger: number | null; updatedAt: string | null };
}

export interface FloatAlert {
  id: string;
  agentId: string;
  regionId: string;
  kind: 'FLOAT_LOW' | 'COLLATERAL_TIGHT' | 'POOL_UTILIZATION_HIGH';
  thresholdBps: number;
  observedBps: number;
  status: AlertStatus;
  createdAt: string;
  agent?: { id: string; legalName: string; tradingName: string | null; regionId: string } | undefined;
}

export interface TopUpRequest {
  id: string;
  agentId: string;
  regionId: string;
  amountRequested: string;
  reason: string;
  status: TopUpStatus;
  requestedBy: string;
  approvedBy: string | null;
  decisionNote: string | null;
  txHash: string | null;
  failureReason: string | null;
  createdAt: string;
  decidedAt: string | null;
  executedAt: string | null;
  agent?: { id: string; legalName: string; tradingName: string | null } | undefined;
}

export interface PoolHealth {
  region: Region;
  pool: {
    totalDeposited: string;
    totalDrawn: string;
    available: string;
    utilizationBps: number;
    utilizationCapBps: number;
    capturedAt: string | null;
    stale: boolean;
  };
  agentExposureTotal: string;
}

export interface ComplianceTiers {
  corridorId: string;
  tiers: { tier: KycTier; upTo: string; description: string }[];
  dailyLimit: string;
  spreadBps: number;
}

export interface KycConfig {
  provider: string;
  supportedTiers: KycTier[];
  enhancedDueDiligence: boolean;
  attestationTtlDays: number;
  webhookSignatureRequired: boolean;
}

/** `/readyz` — what the backend is actually pointed at. */
export interface Readiness {
  status: string;
  network: string;
  networkLabel: string;
  contracts: {
    escrow: string;
    agentRegistry: string;
    complianceHook: string;
    liquidityPool: string;
  };
  limits: { maxFeeBps: number };
  kycProvider: string;
}
