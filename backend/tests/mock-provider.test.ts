import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MockIdVerificationProvider } from '../src/kyc-orchestration/mock-provider.js';
import {
  attestationHashOf,
  canonicalize,
  type VerificationRequest,
} from '../src/kyc-orchestration/provider.js';

/**
 * The mock exists to make every branch reachable, so the suite asserts each one
 * explicitly. If a future edit collapses two branches, these fail — which is the
 * point, because the branch that gets collapsed in a hurry is always a rejection.
 */
const provider = new MockIdVerificationProvider();

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

describe('MockIdVerificationProvider', () => {
  it('approves an ordinary request at the requested tier', async () => {
    const result = await provider.submit(request());
    expect(result.outcome).toBe('APPROVED');
    expect(result.tier).toBe('Standard');
    expect(result.reasons).toEqual([]);
  });

  it('rejects a sanctions match', async () => {
    const result = await provider.submit(request({ fullName: 'Rejected Person' }));
    expect(result.outcome).toBe('REJECTED');
    expect(result.reasons).toContain('SANCTIONS_HIT');
    // A rejected verification must not carry a tier, or a caller that reads only
    // `tier` would treat it as verified.
    expect(result.tier).toBe('None');
  });

  it('rejects an expired document', async () => {
    const result = await provider.submit(
      request({ document: { type: 'passport', number: 'A1', countryCode: 'NG', expiresOn: '2000-01-01' } }),
    );
    expect(result.outcome).toBe('REJECTED');
    expect(result.reasons).toContain('DOCUMENT_EXPIRED');
  });

  it('asks for source of funds rather than approving enhanced due diligence blind', async () => {
    const result = await provider.submit(request({ requiredTier: 'ENHANCED' }));
    expect(result.outcome).toBe('NEEDS_INPUT');
    expect(result.requiredInput).toContain('sourceOfFunds');
  });

  it('approves enhanced due diligence once source of funds is supplied', async () => {
    const result = await provider.submit(
      request({ requiredTier: 'ENHANCED', sourceOfFunds: 'Salary, 12 months statements' }),
    );
    expect(result.outcome).toBe('APPROVED');
    expect(result.tier).toBe('Enhanced');
  });

  it('asks for a document when the tier needs one and none was given', async () => {
    const request_: VerificationRequest = { ...request() };
    delete request_.document;
    const result = await provider.submit(request_);
    expect(result.outcome).toBe('NEEDS_INPUT');
    expect(result.requiredInput).toContain('document');
  });

  it('reports a still-running check as pending rather than guessing', async () => {
    const result = await provider.submit(request({ fullName: 'Pending Review' }));
    expect(result.outcome).toBe('PENDING');
  });
});

describe('attestation hashing', () => {
  it('is stable under key reordering', () => {
    const a = canonicalize({ b: 1, a: 2 });
    const b = canonicalize({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });

  it('handles nested structures and arrays deterministically', () => {
    expect(canonicalize({ z: [{ y: 1, x: 2 }], a: null })).toBe('{"a":null,"z":[{"x":2,"y":1}]}');
  });

  it('never leaks the document number into the hashed payload', async () => {
    const result = await provider.submit(request({ document: { type: 'passport', number: 'SECRET-9999', countryCode: 'NG', expiresOn: '2030-01-01' } }));
    const preimage = canonicalize(result.raw);
    // The hash is published. A low-entropy document number in its preimage is a
    // brute-forceable secret, so this assertion is a security property, not a
    // tidiness preference.
    expect(preimage).not.toContain('SECRET-9999');
    expect(preimage).not.toContain('A12345678');
  });

  it('produces the same hash for identical verifications', async () => {
    const first = await provider.submit(request());
    const second = await provider.submit(request());
    // providerRef contains a timestamp, so the hash *should* differ; what must
    // hold is that the hash is a pure function of the canonical payload.
    const hashA = attestationHashOf({ ...first, providerRef: 'fixed', raw: { decision: 'approved' } });
    const hashB = attestationHashOf({ ...second, providerRef: 'fixed', raw: { decision: 'approved' } });
    expect(hashA.equals(hashB)).toBe(true);
    expect(hashA.length).toBe(32);
  });
});

describe('webhook verification', () => {
  it('refuses when no secret is configured rather than accepting everything', () => {
    // Fails closed by design: accepting unsigned webhooks in development is how
    // an unsigned-webhook assumption reaches production.
    expect(provider.verifyWebhookSignature({}, '{}')).toBe(false);
  });

  it('rejects a body that does not match its signature', () => {
    const secret = 'test-secret';
    // The secret is injected rather than read from `process.env` at call time:
    // configuration is parsed once at boot, so a provider built here is the only
    // honest way to exercise a configured signature check.
    const signed = new MockIdVerificationProvider({ webhookSecret: secret });
    const body = JSON.stringify({ providerRef: 'mock_1', outcome: 'APPROVED' });
    const signature = createHmac('sha256', secret).update(body).digest('hex');

    expect(signed.verifyWebhookSignature({ 'x-provider-signature': signature }, body)).toBe(true);
    expect(signed.verifyWebhookSignature({ 'x-provider-signature': signature }, `${body} `)).toBe(false);
    expect(signed.verifyWebhookSignature({ 'x-provider-signature': 'short' }, body)).toBe(false);
  });
});
