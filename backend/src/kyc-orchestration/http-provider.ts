import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { env } from '../config/env.js';
import { providerUnavailable } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type {
  IdVerificationProvider,
  JsonValue,
  ProviderTier,
  VerificationOutcome,
  VerificationRequest,
  VerificationResult,
  WebhookEvent,
} from './provider.js';

/**
 * The real ID-verification provider: an HTTP adapter over a vendor's REST API.
 *
 * `mock-provider.ts` is deterministic and holds no external state, which is what
 * makes it usable in CI and what makes it unusable in production. This is the
 * other half of that pair: it performs real network calls, verifies real webhook
 * signatures, and fails closed on anything it cannot understand.
 *
 * ## The vendor contract
 *
 * Documented here rather than in a README because it is the thing an adapter
 * author has to satisfy. A vendor either speaks this directly or is reached
 * through a thin translation:
 *
 * ```
 * POST {baseUrl}/verifications
 *   → 201 {
 *       provider_ref:   string     // the vendor's own reference, stored for audit
 *       outcome:        "APPROVED" | "REJECTED" | "PENDING" | "NEEDS_INPUT"
 *       tier:           "None" | "Standard" | "Enhanced"
 *       reasons:        string[]   // "SANCTIONS_HIT", "DOCUMENT_EXPIRED", ...
 *       screened_at:    string     // ISO-8601
 *       required_input: string[]?  // when outcome is NEEDS_INPUT
 *       payload:        object     // the vendor's own record; hashed, never read
 *     }
 *
 * GET  {baseUrl}/verifications/{providerRef}          → 200, same body shape
 * POST {baseUrl}/verifications/{providerRef}/revoke   ← {"reason": string}
 * ```
 *
 * Webhooks are `POST`s whose body is the JSON above minus `provider_ref` being
 * optional, signed with `HMAC-SHA256(secret, rawBody)` in hex in the
 * `x-provider-signature` header.
 *
 * ## Fail-closed, in every direction
 *
 * An identity check that answers "approved" when it is broken is worse than one
 * that answers nothing, because the approval is what lets money move. So every
 * failure mode here — a non-2xx, a body that does not match the contract above,
 * an outcome outside the four known values, a timeout, an unsigned webhook —
 * refuses. None of them falls back to the mock, and none of them guesses.
 *
 * ## What is deliberately not sent
 *
 * The internal `userId` never leaves this service. The vendor gets a random
 * per-request reference, so a vendor breach does not hand over this system's
 * primary keys, and the database keeps the mapping.
 *
 * Document numbers *are* sent — verifying them is the point — but the request
 * body is never logged. `logger.ts` redacts by key name for the paths that do log
 * structured data; this adapter simply does not log the payload at all.
 */

const outcomeSchema = z.enum(['APPROVED', 'REJECTED', 'PENDING', 'NEEDS_INPUT']);
const tierSchema = z.enum(['None', 'Standard', 'Enhanced']);

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

const verificationResponseSchema = z.object({
  provider_ref: z.string().min(1),
  outcome: outcomeSchema,
  tier: tierSchema,
  reasons: z.array(z.string()).default([]),
  screened_at: z.string().min(1),
  required_input: z.array(z.string()).optional(),
  payload: z.record(jsonValueSchema),
});

const webhookBodySchema = verificationResponseSchema.extend({
  provider_ref: z.string().min(1),
});

export interface HttpProviderOptions {
  baseUrl: string;
  apiKey?: string;
  webhookSecret?: string;
  timeoutMs?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class HttpIdVerificationProvider implements IdVerificationProvider {
  readonly id = 'http';
  readonly supportedTiers: readonly ProviderTier[] = ['None', 'Standard', 'Enhanced'];
  readonly supportsEnhancedDueDiligence = true;

  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #webhookSecret: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: HttpProviderOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#webhookSecret = options.webhookSecret;
    this.#timeoutMs = options.timeoutMs ?? env.KYC_PROVIDER_TIMEOUT_MS;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  async submit(request: VerificationRequest): Promise<VerificationResult> {
    const body = {
      // Random, not derived from `userId`: a reference derived from the subject
      // would be a stable pseudonymous identifier at the vendor, which is a
      // different privacy posture than one that cannot be correlated.
      reference: randomUUID(),
      tier: request.requiredTier === 'ENHANCED' ? 'Enhanced' : 'Standard',
      region_id: request.regionId,
      country_code: request.countryCode,
      subject: {
        full_name: request.fullName,
        date_of_birth: request.dateOfBirth,
        ...(request.address !== undefined ? { address: request.address } : {}),
        ...(request.document !== undefined
          ? {
              document: {
                type: request.document.type,
                number: request.document.number,
                country_code: request.document.countryCode,
                expires_on: request.document.expiresOn,
              },
            }
          : {}),
      },
      ...(request.sourceOfFunds !== undefined ? { source_of_funds: request.sourceOfFunds } : {}),
    };

    const response = await this.#request('POST', '/verifications', body);
    return this.#toResult(response);
  }

  async fetchResult(providerRef: string): Promise<VerificationResult> {
    const response = await this.#request(
      'GET',
      `/verifications/${encodeURIComponent(providerRef)}`,
      undefined,
    );
    return this.#toResult(response);
  }

  async revoke(providerRef: string, reason: string): Promise<void> {
    await this.#request(
      'POST',
      `/verifications/${encodeURIComponent(providerRef)}/revoke`,
      { reason },
    );
  }

  verifyWebhookSignature(
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): boolean {
    const secret = this.#webhookSecret;
    if (!secret) {
      // Refusing is the only safe default, exactly as in the mock. Accepting
      // unsigned webhooks in development is how an unsigned-webhook assumption
      // reaches production, and this endpoint is what turns a screening result
      // into an on-chain attestation.
      logger.warn(
        { provider: this.id },
        'webhook signature rejected: no KYC_PROVIDER_WEBHOOK_SECRET configured',
      );
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
    const parsed = webhookBodySchema.safeParse(safeJsonText(rawBody));
    if (!parsed.success) {
      // The caller has already verified the signature, so this is a contract
      // mismatch rather than an attack — but an unparseable event must not be
      // recorded as anything, least of all as an approval.
      throw providerUnavailable(this.id, 'webhook body does not match the provider contract');
    }

    const body = parsed.data;
    return {
      providerRef: body.provider_ref,
      outcome: body.outcome,
      reasons: body.reasons,
      occurredAt: body.screened_at,
      raw: body.payload,
    };
  }

  async #request(method: 'GET' | 'POST', path: string, body: unknown): Promise<z.infer<typeof verificationResponseSchema>> {
    const url = `${this.#baseUrl}${path}`;

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(this.#apiKey !== undefined ? { authorization: `Bearer ${this.#apiKey}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      throw providerUnavailable(this.id, `request to ${path} failed: ${describe(cause)}`);
    }

    if (!response.ok) {
      // The vendor's error body is not propagated: it can echo the submitted
      // document data back, and this error ends up in an HTTP response.
      throw providerUnavailable(this.id, `${method} ${path} returned ${response.status}`);
    }

    const parsed = verificationResponseSchema.safeParse(await safeJson(response));
    if (!parsed.success) {
      throw providerUnavailable(
        this.id,
        `${method} ${path} returned a body outside the provider contract`,
      );
    }
    return parsed.data;
  }

  #toResult(response: z.infer<typeof verificationResponseSchema>): VerificationResult {
    const outcome: VerificationOutcome = response.outcome;
    return {
      outcome,
      tier: response.tier,
      providerId: this.id,
      providerRef: response.provider_ref,
      reasons: response.reasons,
      screenedAt: response.screened_at,
      ...(response.required_input !== undefined ? { requiredInput: response.required_input } : {}),
      // The vendor's own record, kept only so `attestationHashOf` can hash it.
      raw: response.payload,
    };
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function safeJsonText(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.name === 'TimeoutError' ? 'timed out' : cause.message;
  }
  return String(cause);
}
