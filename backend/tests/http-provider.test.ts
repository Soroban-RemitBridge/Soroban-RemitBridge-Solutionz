import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { isAppError } from '../src/lib/errors.js';
import { HttpIdVerificationProvider } from '../src/kyc-orchestration/http-provider.js';
import { attestationHashOf, type VerificationRequest } from '../src/kyc-orchestration/provider.js';

/**
 * The HTTP provider is the one that runs in production, so this suite is written
 * around what it must *never* do: approve on a broken response, accept an
 * unsigned webhook, or hand the vendor this system's internal identifiers.
 *
 * `fetch` is injected rather than mocked at the module level, so the assertions
 * can inspect the actual request body that would leave the process.
 */

const BASE_URL = 'https://vendor.example.test/api';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/**
 * `Response` is global, but the node typings in this workspace do not resolve
 * `RequestInfo`, so the stub narrows the input to what this provider actually
 * passes — a URL string — and casts once, here, rather than at each call site.
 */
function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** The request body, asserted to be the JSON string the provider builds. */
function bodyOf(call: FetchCall | undefined): string {
  const body = call?.init?.body;
  if (typeof body !== 'string') throw new Error('expected a string request body');
  return body;
}

function headersOf(call: FetchCall | undefined): Record<string, string | readonly string[]> {
  const headers = call?.init?.headers;
  if (headers === undefined || headers instanceof Headers || Array.isArray(headers)) {
    throw new Error('expected a plain headers object');
  }
  return headers;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function providerResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider_ref: 'vendor-ref-1',
    outcome: 'APPROVED',
    tier: 'Standard',
    reasons: [],
    screened_at: '2026-09-16T09:00:00.000Z',
    payload: { decision: 'approved', check_id: 'chk_1' },
    ...overrides,
  };
}

function build(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  options: { apiKey?: string; webhookSecret?: string } = {},
) {
  const { fetchImpl, calls } = stubFetch(handler);
  const provider = new HttpIdVerificationProvider({
    baseUrl: BASE_URL,
    fetchImpl,
    timeoutMs: 5_000,
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.webhookSecret !== undefined ? { webhookSecret: options.webhookSecret } : {}),
  });
  return { provider, calls };
}

/**
 * A refusal is an `AppError` whose message is deliberately generic, so the
 * specific reason has to be read from `details.cause` — that is what keeps a
 * vendor error body, which can quote a document number, out of an HTTP response.
 */
async function refusalOf(promise: Promise<unknown>): Promise<{ code: string; cause: string }> {
  const settled = await promise.then(
    () => 'resolved',
    (error: unknown) => error,
  );
  if (!isAppError(settled)) throw new Error(`expected a provider refusal, got: ${String(settled)}`);
  return { code: settled.code, cause: String(settled.details['cause']) };
}

function throwRefusal(run: () => unknown): { code: string; cause: string } {
  try {
    run();
  } catch (error) {
    if (!isAppError(error)) throw error;
    return { code: error.code, cause: String(error.details['cause']) };
  }
  throw new Error('expected a refusal, but the call returned normally');
}

function request(overrides: Partial<VerificationRequest> = {}): VerificationRequest {
  return {
    userId: 'user-1',
    requiredTier: 'STANDARD',
    regionId: 'NG_LAG',
    countryCode: 'NG',
    fullName: 'Ada Lovelace',
    dateOfBirth: '1990-01-01',
    document: {
      type: 'passport',
      number: 'A12345678',
      countryCode: 'NG',
      expiresOn: '2030-01-01',
    },
    ...overrides,
  };
}

describe('HttpIdVerificationProvider.submit', () => {
  it('POSTs to the vendor and maps its result', async () => {
    const { provider, calls } = build(() => jsonResponse(providerResult(), 201));
    const result = await provider.submit(request());

    expect(calls[0]?.url).toBe(`${BASE_URL}/verifications`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(result.outcome).toBe('APPROVED');
    expect(result.tier).toBe('Standard');
    expect(result.providerId).toBe('http');
    expect(result.providerRef).toBe('vendor-ref-1');
    expect(result.screenedAt).toBe('2026-09-16T09:00:00.000Z');
  });

  it('never sends the internal user id to the vendor', async () => {
    const { provider, calls } = build(() => jsonResponse(providerResult(), 201));
    await provider.submit(request());

    // The vendor gets a random per-request reference instead: a vendor breach
    // must not hand over this system's primary keys.
    expect(bodyOf(calls[0])).not.toContain('user-1');
  });

  it('sends a fresh reference per submission, not one derived from the subject', async () => {
    const { provider, calls } = build(() => jsonResponse(providerResult(), 201));
    await provider.submit(request());
    await provider.submit(request());

    const first = JSON.parse(bodyOf(calls[0])) as { reference: string };
    const second = JSON.parse(bodyOf(calls[1])) as { reference: string };
    expect(first.reference).not.toBe(second.reference);
    expect(first.reference).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does send the document, because verifying it is the point', async () => {
    const { provider, calls } = build(() => jsonResponse(providerResult(), 201));
    await provider.submit(request());

    const body = JSON.parse(bodyOf(calls[0])) as {
      subject: { document: { number: string } };
      region_id: string;
    };
    expect(body.subject.document.number).toBe('A12345678');
    expect(body.region_id).toBe('NG_LAG');
  });

  it('asks for the enhanced tier as Enhanced', async () => {
    const { provider, calls } = build(() => jsonResponse(providerResult(), 201));
    await provider.submit(request({ requiredTier: 'ENHANCED', sourceOfFunds: 'salary' }));

    const body = JSON.parse(bodyOf(calls[0])) as {
      tier: string;
      source_of_funds: string;
    };
    expect(body.tier).toBe('Enhanced');
    expect(body.source_of_funds).toBe('salary');
  });

  it('omits optional fields rather than sending undefined', async () => {
    const { provider, calls } = build(() => jsonResponse(providerResult(), 201));
    const { document: _document, ...withoutDocument } = request();
    await provider.submit(withoutDocument);

    const body = JSON.parse(bodyOf(calls[0])) as { subject: Record<string, unknown> };
    expect('document' in body.subject).toBe(false);
    expect('source_of_funds' in body).toBe(false);
  });

  it('sends the API key as a bearer token when one is configured', async () => {
    const { provider, calls } = build(() => jsonResponse(providerResult(), 201), {
      apiKey: 'vendor-key',
    });
    await provider.submit(request());

    expect(headersOf(calls[0])['authorization']).toBe('Bearer vendor-key');
  });

  it('sends no authorization header when no key is configured', async () => {
    const { provider, calls } = build(() => jsonResponse(providerResult(), 201));
    await provider.submit(request());

    expect('authorization' in headersOf(calls[0])).toBe(false);
  });

  it('keeps the vendor payload for hashing and nothing else', async () => {
    const { provider } = build(() => jsonResponse(providerResult(), 201));
    const result = await provider.submit(request());

    expect(result.raw).toEqual({ decision: 'approved', check_id: 'chk_1' });
    // The hash is what goes on-chain, so it must be a pure function of the
    // provider's own record.
    expect(attestationHashOf(result)).toHaveLength(32);
  });
});

describe('HttpIdVerificationProvider refusal paths', () => {
  it('refuses on a non-2xx response, and does not echo the vendor body', async () => {
    const { provider } = build(() =>
      jsonResponse({ error: 'document A12345678 could not be read' }, 422),
    );

    // The vendor's error body can quote the submitted document data, and this
    // error reaches an HTTP response, so only the status is propagated.
    const refusal = await refusalOf(provider.submit(request()));
    expect(refusal.code).toBe('PROVIDER_UNAVAILABLE');
    expect(refusal.cause).toMatch(/returned 422/);
    expect(refusal.cause).not.toMatch(/A12345678/);
  });

  it('refuses a body outside the contract rather than assuming approval', async () => {
    const { provider } = build(() => jsonResponse({ status: 'ok' }, 200));
    await expect(provider.submit(request())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('refuses a non-JSON body', async () => {
    const { provider } = build(() => new Response('<html>gateway</html>', { status: 200 }));
    await expect(provider.submit(request())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('refuses an outcome outside the four known values', async () => {
    const { provider } = build(() =>
      jsonResponse(providerResult({ outcome: 'PROBABLY_FINE' }), 201),
    );
    await expect(provider.submit(request())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('refuses a result missing its provider reference', async () => {
    const { provider } = build(() => jsonResponse(providerResult({ provider_ref: '' }), 201));
    await expect(provider.submit(request())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('refuses on a timeout and names the cause', async () => {
    const { provider } = build(() => {
      throw new DOMException('The operation was aborted', 'TimeoutError');
    });
    const refusal = await refusalOf(provider.submit(request()));
    expect(refusal.cause).toMatch(/failed: timed out/);
  });

  it('refuses on a transport error', async () => {
    const { provider } = build(() => {
      throw new Error('ECONNREFUSED 127.0.0.1:443');
    });
    const refusal = await refusalOf(provider.submit(request()));
    expect(refusal.cause).toMatch(/ECONNREFUSED/);
  });
});

describe('HttpIdVerificationProvider.fetchResult and revoke', () => {
  it('fetches a result by reference, encoding the reference', async () => {
    const { provider, calls } = build(() => jsonResponse(providerResult(), 200));
    const result = await provider.fetchResult('ref/with/slashes');

    expect(calls[0]?.url).toBe(`${BASE_URL}/verifications/ref%2Fwith%2Fslashes`);
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.body).toBeUndefined();
    expect(result.providerRef).toBe('vendor-ref-1');
  });

  it('revokes by reference, sending the reason', async () => {
    const { provider, calls } = build(() => jsonResponse(providerResult(), 200));
    await provider.revoke('vendor-ref-1', 'sanctions_match');

    expect(calls[0]?.url).toBe(`${BASE_URL}/verifications/vendor-ref-1/revoke`);
    expect(JSON.parse(bodyOf(calls[0]))).toEqual({ reason: 'sanctions_match' });
  });
});

describe('HttpIdVerificationProvider webhooks', () => {
  const secret = 'webhook-secret';
  const body = JSON.stringify(
    providerResult({ outcome: 'REJECTED', reasons: ['SANCTIONS_HIT'] }),
  );

  function signed(rawBody: string): string {
    return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  }

  it('accepts a correctly signed body', () => {
    const { provider } = build(() => jsonResponse({}), { webhookSecret: secret });
    expect(
      provider.verifyWebhookSignature({ 'x-provider-signature': signed(body) }, body),
    ).toBe(true);
  });

  it('rejects a body that does not match its signature', () => {
    const { provider } = build(() => jsonResponse({}), { webhookSecret: secret });
    const tampered = JSON.stringify(providerResult({ outcome: 'APPROVED' }));
    expect(provider.verifyWebhookSignature({ 'x-provider-signature': signed(body) }, tampered)).toBe(
      false,
    );
  });

  it('rejects a missing or malformed signature header', () => {
    const { provider } = build(() => jsonResponse({}), { webhookSecret: secret });
    expect(provider.verifyWebhookSignature({}, body)).toBe(false);
    expect(provider.verifyWebhookSignature({ 'x-provider-signature': 'short' }, body)).toBe(false);
  });

  it('refuses every webhook when no secret is configured', () => {
    // Accepting unsigned webhooks in development is how an unsigned-webhook
    // assumption reaches production, and this endpoint writes attestations.
    const { provider } = build(() => jsonResponse({}));
    expect(
      provider.verifyWebhookSignature({ 'x-provider-signature': signed(body) }, body),
    ).toBe(false);
  });

  it('parses a verified body into a webhook event', () => {
    const { provider } = build(() => jsonResponse({}), { webhookSecret: secret });
    const event = provider.parseWebhook(body);

    expect(event.providerRef).toBe('vendor-ref-1');
    expect(event.outcome).toBe('REJECTED');
    expect(event.reasons).toEqual(['SANCTIONS_HIT']);
    expect(event.occurredAt).toBe('2026-09-16T09:00:00.000Z');
  });

  it('refuses an unparseable webhook body', () => {
    const { provider } = build(() => jsonResponse({}), { webhookSecret: secret });

    // An event that cannot be read must not be recorded as anything, least of
    // all as an approval.
    expect(throwRefusal(() => provider.parseWebhook('not json')).cause).toMatch(/provider contract/);
    expect(
      throwRefusal(() => provider.parseWebhook(JSON.stringify({ provider_ref: '' }))).cause,
    ).toMatch(/provider contract/);
  });
});
