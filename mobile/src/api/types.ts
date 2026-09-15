/**
 * Wire types for the app.
 *
 * Mirrors the backend contract rather than importing backend types: the app is
 * shipped to devices and the API evolves on its own schedule, so the app should
 * fail to compile when a field it renders disappears. Amounts are strings
 * throughout — an `i128` does not survive a JSON number.
 */

export type KycTier = 'NONE' | 'STANDARD' | 'ENHANCED';
export type TransferStatus = 'PENDING' | 'CLAIMED' | 'REFUNDED' | 'CANCELLED';

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
  region: {
    id: string;
    displayName: string;
    countryCode: string;
    currency: string;
  };
}

/**
 * A signed quote.
 *
 * `clientRate` is what the customer is offered; `midRate` is what the spread was
 * applied to. Both are signed, so a dispute is settled by recomputing rather
 * than by trusting either party — which is why the app keeps the signature
 * rather than only the numbers it displays.
 */
export interface Quote {
  quoteId: string;
  corridorId: string;
  base: string;
  quote: string;
  midRate: string;
  spreadBps: number;
  clientRate: string;
  amount: string;
  fee: string;
  total: string;
  oracleSource: string;
  validUntil: string;
  signature: string;
  signingKey: string;
  feeDisplay: string;
  totalDisplay: string;
}

/** What a transfer of this size will require of the sender. */
export interface Preflight {
  corridorId: string;
  amountStroops: string;
  requiredTier: KycTier;
  withinDailyLimit: boolean;
  active: boolean;
}

export interface ComplianceTiers {
  corridorId: string;
  tiers: { tier: KycTier; upTo: string; description: string }[];
  dailyLimit: string;
  spreadBps: number;
}

export interface TransferStatusResponse {
  id: string;
  status: TransferStatus;
  amount: string;
  fee: string;
  payout: string;
  claimHash: string;
  expiry: string;
  createdAt: string;
  settledAt: string | null;
  claimedBy: string | null;
  corridorId: string;
  expired: boolean;
  refundable: boolean;
  timeline: { topic: string; ledger: number; txHash: string; occurredAt: string }[];
}

export interface AgentSummary {
  id: string;
  legalName: string;
  tradingName: string | null;
  status: 'PENDING' | 'AUTHORIZED' | 'SUSPENDED' | 'REVOKED';
  bondAmount: string;
  regionId: string;
  region?: { displayName: string; currency: string };
  totalDrawn?: string;
  collateralRatioBps?: number;
  requiredBond?: string;
}

export interface TopUpRequest {
  id: string;
  agentId: string;
  regionId: string;
  amountRequested: string;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXECUTED' | 'FAILED';
  createdAt: string;
}
