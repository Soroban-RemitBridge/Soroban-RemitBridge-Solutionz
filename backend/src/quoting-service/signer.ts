import { createHmac, timingSafeEqual } from 'node:crypto';

import { Keypair } from '@stellar/stellar-sdk';

import { canonicalize, type JsonValue } from '../kyc-orchestration/provider.js';

/**
 * Quote signing.
 *
 * A quote is a promise about a price. Signing it is what lets a client prove,
 * later and offline, that the rate it showed a customer is the rate the network
 * quoted — and what lets anyone verify that a settled transfer was priced at an
 * agreed rate rather than at whatever the backend felt like at the time.
 *
 * `createHmac` is used rather than an Ed25519 signature because, at this scope,
 * the verifier and the issuer are the same service. The interface takes the raw
 * bytes and an algorithm name so swapping in `Keypair.sign` later is a change to
 * one function, and the signature is labelled with its algorithm so a verifier
 * can refuse one it does not understand rather than mis-verify it.
 */

export interface QuoteBody {
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
}

export interface SignedQuote extends QuoteBody {
  signature: string;
  algorithm: 'hmac-sha256';
  signingKey: string;
}

export function signQuote(body: QuoteBody, signer: Keypair, secret: string): SignedQuote {
  const signature = createHmac('sha256', secret)
    .update(canonicalize(body as unknown as JsonValue), 'utf8')
    .digest('hex');

  return {
    ...body,
    signature,
    algorithm: 'hmac-sha256',
    // The public key is included so a verifier knows *which* key to check against
    // and can reject a quote signed by a rotated or unknown key, rather than
    // trying the current one and reporting a generic mismatch.
    signingKey: signer.publicKey(),
  };
}

export function verifyQuote(quote: SignedQuote, secret: string, expectedKey?: string): boolean {
  if (quote.algorithm !== 'hmac-sha256') return false;
  if (expectedKey !== undefined && quote.signingKey !== expectedKey) return false;

  const { signature, algorithm, signingKey, ...body } = quote;
  void algorithm;
  void signingKey;

  const expected = createHmac('sha256', secret)
    .update(canonicalize(body as unknown as JsonValue), 'utf8')
    .digest('hex');

  const providedBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

/** Whether a quote is still inside its validity window. */
export function isQuoteLive(quote: Pick<SignedQuote, 'validUntil'>, now = new Date()): boolean {
  const validUntil = Date.parse(quote.validUntil);
  if (Number.isNaN(validUntil)) return false;
  return validUntil > now.getTime();
}

/**
 * A short validity window is the mechanism, not an implementation detail.
 *
 * The backend cannot read the rate between the moment it quotes and the moment
 * the transfer settles, so the window is how long it is willing to carry that
 * risk. Making it long would make the quote authoritative for longer than the
 * oracle data behind it is trustworthy.
 */
export function validityWindow(ttlSeconds: number, now = new Date()): { validUntil: string; ttlSeconds: number } {
  return {
    validUntil: new Date(now.getTime() + ttlSeconds * 1_000).toISOString(),
    ttlSeconds,
  };
}
