import { createHash } from 'node:crypto';

/**
 * The ID-verification provider contract.
 *
 * The interface is the deliverable here, not the mock. Providers in this space
 * churn — pricing changes, coverage changes, one gets acquired — so the swap
 * point is designed before either end exists. `mock-provider.ts` implements it
 * for development, and a Sumsub or Onfido adapter plugs in at
 * `KYC_PROVIDER` without touching the service, the database schema or the
 * contract call.
 *
 * Two rules the interface enforces structurally:
 *
 * 1. **The provider returns data; it never decides what goes on-chain.** The
 *    service derives the attestation hash, so no provider SDK can accidentally
 *    influence what the ledger records.
 * 2. **`raw` is for hashing only.** It is typed as `JsonObject` and consumed by
 *    `attestationHashOf`; nothing else in the service is allowed to read it,
 *    which is what keeps document numbers out of logs and out of the API.
 */

export type VerificationTier = 'NONE' | 'STANDARD' | 'ENHANCED';

export type ProviderTier = 'None' | 'Standard' | 'Enhanced';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type DocumentType = 'passport' | 'national_id' | 'drivers_license';

export interface VerificationDocument {
  type: DocumentType;
  /** Personal data. Redacted from logs by key name; see `lib/logger.ts`. */
  number: string;
  countryCode: string;
  /** ISO-8601 date. */
  expiresOn: string;
}

export interface VerificationRequest {
  /** Internal user id; the provider is given a per-request reference, not the id. */
  userId: string;
  /** The tier the corridor requires, already resolved from the contract config. */
  requiredTier: VerificationTier;
  regionId: string;
  countryCode: string;
  fullName: string;
  /** ISO-8601 date. */
  dateOfBirth: string;
  address?: {
    line1: string;
    city: string;
    postalCode?: string;
    countryCode: string;
  };
  document?: VerificationDocument;
  /** Set when the tier is ENHANCED: what the funds are for. */
  sourceOfFunds?: string;
}

export type VerificationOutcome = 'APPROVED' | 'REJECTED' | 'PENDING' | 'NEEDS_INPUT';

export interface VerificationResult {
  outcome: VerificationOutcome;
  tier: ProviderTier;
  providerId: string;
  /** The provider's own reference, stored so an auditor can be routed to source. */
  providerRef: string;
  /** Machine-readable reason codes: `DOCUMENT_EXPIRED`, `SANCTIONS_HIT`, ... */
  reasons: string[];
  screenedAt: string;
  /** What the provider would need next, when `outcome` is `NEEDS_INPUT`. */
  requiredInput?: string[];
  /**
   * Provider payload, used solely to derive the attestation hash. Nothing may
   * read this field for any other purpose.
   */
  raw: JsonObject;
}

export interface WebhookEvent {
  providerRef: string;
  outcome: VerificationOutcome;
  reasons: string[];
  occurredAt: string;
  raw: JsonObject;
}

export interface IdVerificationProvider {
  /** Matches `KYC_PROVIDER` in the environment. */
  readonly id: string;
  /** Tiers this provider can actually evidence; the service refuses to ask for more. */
  readonly supportedTiers: readonly ProviderTier[];
  /** Whether the provider can screen for enhanced due diligence at all. */
  readonly supportsEnhancedDueDiligence: boolean;

  submit(request: VerificationRequest): Promise<VerificationResult>;
  fetchResult(providerRef: string): Promise<VerificationResult>;
  /** Tell the provider the verification is no longer valid (sanctions hit). */
  revoke(providerRef: string, reason: string): Promise<void>;

  /** Constant-time signature check over the raw webhook body. */
  verifyWebhookSignature(headers: Record<string, string | undefined>, rawBody: string): boolean;
  parseWebhook(rawBody: string): WebhookEvent;
}

/**
 * Deterministic JSON serialisation for hashing.
 *
 * Object key order is not guaranteed across runs, so hashing `JSON.stringify`
 * output directly would produce a different attestation hash for identical
 * input — and the hash is what the chain compares. Sorting keys recursively is
 * the smallest fix that makes the hash a pure function of the content.
 */
export function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalize(entryValue)}`).join(',')}}`;
}

/** The value that goes on-chain: `sha256` of the canonicalised provider payload. */
export function attestationHashOf(result: Pick<VerificationResult, 'providerId' | 'providerRef' | 'tier' | 'raw'>): Buffer {
  const canonical = canonicalize({
    provider_id: result.providerId,
    provider_ref: result.providerRef,
    tier: result.tier,
    payload: result.raw,
  } as JsonValue);
  return createHash('sha256').update(canonical, 'utf8').digest();
}

/** Provider tier vocabulary → the contract's `KycTier` variant names. */
export function toContractTier(tier: ProviderTier): 'None' | 'Standard' | 'Enhanced' {
  return tier;
}

export function tierSatisfies(held: ProviderTier, required: VerificationTier): boolean {
  const rank: Record<ProviderTier, number> = { None: 0, Standard: 1, Enhanced: 2 };
  const requiredProviderTier: Record<VerificationTier, ProviderTier> = {
    NONE: 'None',
    STANDARD: 'Standard',
    ENHANCED: 'Enhanced',
  };
  return rank[held] >= rank[requiredProviderTier[required]];
}
