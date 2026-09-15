import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '../config/env.js';
import { providerUnavailable } from '../lib/errors.js';
import {
  attestationHashOf,
  type IdVerificationProvider,
  type JsonObject,
  type ProviderTier,
  type VerificationRequest,
  type VerificationResult,
  type WebhookEvent,
} from './provider.js';

/**
 * In-repo provider used for development, tests and CI.
 *
 * It is deliberately *not* a stub that always approves. A mock that returns
 * `APPROVED` for everything lets an integration pass while the rejection paths —
 * which are the ones that matter in a compliance product — are never executed,
 * and the resulting test suite gives false confidence. Instead it derives a
 * deterministic outcome from the request, so every branch is reachable by
 * construction:
 *
 * | Trigger in the request | Outcome |
 * | --- | --- |
 * | name contains "reject" | `REJECTED` / `SANCTIONS_HIT` |
 * | document expired | `REJECTED` / `DOCUMENT_EXPIRED` |
 * | `ENHANCED` without `sourceOfFunds` | `NEEDS_INPUT` |
 * | name contains "pending" | `PENDING` (provider still working) |
 * | otherwise | `APPROVED` at the requested tier |
 *
 * Determinism matters more than realism here: a flaky mock produces a flaky CI,
 * and the first thing anyone does with a flaky test is delete it.
 */
export class MockIdVerificationProvider implements IdVerificationProvider {
  readonly id = 'mock';
  readonly supportedTiers: readonly ProviderTier[] = ['None', 'Standard', 'Enhanced'];
  readonly supportsEnhancedDueDiligence = true;

  async submit(request: VerificationRequest): Promise<VerificationResult> {
    const normalizedName = request.fullName.toLowerCase();
    const screenedAt = new Date().toISOString();
    const providerRef = `mock_${request.regionId}_${hashSuffix(request.userId + screenedAt)}`;

    const base = {
      providerId: this.id,
      providerRef,
      screenedAt,
    } as const;

    if (!request.document && request.requiredTier !== 'NONE') {
      return {
        ...base,
        outcome: 'NEEDS_INPUT',
        tier: 'None',
        reasons: ['DOCUMENT_REQUIRED'],
        requiredInput: ['document'],
        raw: rawPayload(request, { decision: 'needs_input', reason: 'DOCUMENT_REQUIRED' }),
      };
    }

    if (normalizedName.includes('reject')) {
      return {
        ...base,
        outcome: 'REJECTED',
        tier: 'None',
        reasons: ['SANCTIONS_HIT'],
        raw: rawPayload(request, { decision: 'rejected', reason: 'SANCTIONS_HIT' }),
      };
    }

    if (request.document && isExpired(request.document.expiresOn)) {
      return {
        ...base,
        outcome: 'REJECTED',
        tier: 'None',
        reasons: ['DOCUMENT_EXPIRED'],
        raw: rawPayload(request, { decision: 'rejected', reason: 'DOCUMENT_EXPIRED' }),
      };
    }

    if (normalizedName.includes('pending')) {
      return {
        ...base,
        outcome: 'PENDING',
        tier: 'None',
        reasons: ['MANUAL_REVIEW'],
        raw: rawPayload(request, { decision: 'pending', reason: 'MANUAL_REVIEW' }),
      };
    }

    if (request.requiredTier === 'ENHANCED' && !request.sourceOfFunds) {
      return {
        ...base,
        outcome: 'NEEDS_INPUT',
        tier: 'Standard',
        reasons: ['SOURCE_OF_FUNDS_REQUIRED'],
        requiredInput: ['sourceOfFunds'],
        raw: rawPayload(request, { decision: 'needs_input', reason: 'SOURCE_OF_FUNDS_REQUIRED' }),
      };
    }

    const tier: ProviderTier = request.requiredTier === 'ENHANCED' ? 'Enhanced' : 'Standard';
    return {
      ...base,
      outcome: 'APPROVED',
      tier,
      reasons: [],
      raw: rawPayload(request, { decision: 'approved', reason: null }),
    };
  }

  async fetchResult(providerRef: string): Promise<VerificationResult> {
    // The reference encodes nothing but a digest, so a lookup cannot be
    // reconstructed; a real provider would be queried here.
    throw providerUnavailable(this.id, `no stored result for ${providerRef}`);
  }

  async revoke(_providerRef: string, _reason: string): Promise<void> {
    // Nothing to do: the mock holds no external state, and revocation is
    // recorded on-chain by the service rather than by the provider.
  }

  verifyWebhookSignature(
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): boolean {
    const secret = env.KYC_PROVIDER_WEBHOOK_SECRET;
    if (!secret) {
      // Refusing is the only safe default. Accepting unsigned webhooks in
      // development is how an unsigned-webhook assumption reaches production.
      return false;
    }
    const provided = headers['x-provider-signature'];
    if (!provided) return false;

    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    const providedBuffer = Buffer.from(provided, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    // Length check first: `timingSafeEqual` throws on a length mismatch, and a
    // throw is itself a timing signal.
    if (providedBuffer.length !== expectedBuffer.length) return false;
    return timingSafeEqual(providedBuffer, expectedBuffer);
  }

  parseWebhook(rawBody: string): WebhookEvent {
    const parsed = JSON.parse(rawBody) as {
      providerRef?: string;
      outcome?: string;
      reasons?: string[];
      occurredAt?: string;
    };
    if (!parsed.providerRef) {
      throw new Error('webhook is missing providerRef');
    }
    return {
      providerRef: parsed.providerRef,
      outcome: (parsed.outcome ?? 'PENDING') as WebhookEvent['outcome'],
      reasons: parsed.reasons ?? [],
      occurredAt: parsed.occurredAt ?? new Date().toISOString(),
      raw: parsed as unknown as JsonObject,
    };
  }
}

function isExpired(isoDate: string): boolean {
  const expires = Date.parse(isoDate);
  if (Number.isNaN(expires)) return true;
  return expires <= Date.now();
}

function hashSuffix(input: string): string {
  return createHmac('sha256', 'mock-provider-ref').update(input).digest('hex').slice(0, 12);
}

/**
 * A deliberately *minimal* payload.
 *
 * The hash covers it, so shape is a compatibility surface: adding a field here
 * changes every future attestation hash. The mock keeps to the minimum the
 * canonicalisation test asserts against, and never includes the document number
 * — the hash is published, and a low-entropy document number in the preimage is
 * a brute-forceable secret.
 */
function rawPayload(
  request: VerificationRequest,
  decision: { decision: string; reason: string | null },
): JsonObject {
  return {
    country_code: request.countryCode,
    decision: decision.decision,
    reason: decision.reason,
    region_id: request.regionId,
    requested_tier: request.requiredTier,
    screened_at: new Date().toISOString().slice(0, 10),
  };
}

export { attestationHashOf };
