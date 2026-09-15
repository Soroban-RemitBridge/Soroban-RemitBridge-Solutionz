import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { isQuoteLive, signQuote, validityWindow, verifyQuote, type QuoteBody } from '../src/quoting-service/signer.js';

/**
 * A quote is a promise about a price. These tests treat the signature as a
 * security boundary rather than a checksum: every mutation of the body must break
 * it, because the alternative is a client presenting a rate the backend never
 * agreed to.
 */
const SECRET = 'test-quote-signing-secret';
const signer = Keypair.random();

function body(overrides: Partial<QuoteBody> = {}): QuoteBody {
  return {
    quoteId: 'q-1',
    corridorId: 'NGN_LAG',
    base: 'USD',
    quote: 'NGN',
    midRate: '15000000000',
    spreadBps: 75,
    clientRate: '14887500000',
    amount: '1000000000',
    fee: '20000000',
    total: '1488550000',
    oracleSource: 'static-config',
    validUntil: '2030-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('signQuote', () => {
  it('produces a verifiable signature over the whole body', () => {
    const signed = signQuote(body(), signer, SECRET);
    expect(signed.algorithm).toBe('hmac-sha256');
    expect(signed.signingKey).toBe(signer.publicKey());
    expect(verifyQuote(signed, SECRET)).toBe(true);
  });

  it('breaks when any field is tampered with', () => {
    const signed = signQuote(body(), signer, SECRET);
    const fields = Object.keys(body()) as (keyof QuoteBody)[];

    for (const field of fields) {
      const tampered = { ...signed, [field]: 'tampered' } as typeof signed;
      if (field === 'spreadBps') tampered.spreadBps = 9_999;
      expect(verifyQuote(tampered, SECRET), `field ${field} did not invalidate the signature`).toBe(false);
    }
  });

  it('rejects a signature produced with a different secret', () => {
    const signed = signQuote(body(), signer, 'a-different-secret');
    expect(verifyQuote(signed, SECRET)).toBe(false);
  });

  it('rejects a quote signed by a key other than the expected one', () => {
    const signed = signQuote(body(), signer, SECRET);
    // Relevant after a key rotation: an old quote must not silently verify
    // against the new key.
    expect(verifyQuote(signed, SECRET, Keypair.random().publicKey())).toBe(false);
    expect(verifyQuote(signed, SECRET, signer.publicKey())).toBe(true);
  });

  it('rejects an algorithm it does not understand rather than guessing', () => {
    const signed = signQuote(body(), signer, SECRET);
    expect(verifyQuote({ ...signed, algorithm: 'ed25519' as 'hmac-sha256' }, SECRET)).toBe(false);
  });
});

describe('validity window', () => {
  it('places the expiry exactly ttl seconds ahead', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const window = validityWindow(45, now);
    expect(window.validUntil).toBe('2026-01-01T00:00:45.000Z');
    expect(window.ttlSeconds).toBe(45);
  });

  it('treats a quote as dead at its expiry instant, not one millisecond later', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(isQuoteLive({ validUntil: '2026-01-01T00:00:01.000Z' }, now)).toBe(true);
    expect(isQuoteLive({ validUntil: now.toISOString() }, now)).toBe(false);
  });

  it('treats an unparseable expiry as expired', () => {
    expect(isQuoteLive({ validUntil: 'not-a-date' })).toBe(false);
  });
});
