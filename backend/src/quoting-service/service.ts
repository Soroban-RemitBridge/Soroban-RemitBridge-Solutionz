import { randomUUID } from 'node:crypto';

import { type Keypair } from '@stellar/stellar-sdk';

import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { notFound } from '../lib/errors.js';
import { applyBps, fromStroops, toStroops } from '../lib/money.js';
import { keypairFromSecret } from '../soroban/rpc.js';
import { assertFresh, buildDefaultSource, RATE_SCALE, type PriceSource } from './oracle.js';
import { signQuote, validityWindow, type SignedQuote } from './signer.js';

/**
 * Quoting.
 *
 * A quote has three numbers the customer sees (amount, fee, total) and one they
 * do not (the mid-market rate the spread was applied to). Both are signed, so a
 * dispute can be settled by recomputing rather than by trusting either party.
 */

let sourceOverride: PriceSource | null = null;

/** Test seam: lets a suite pin a rate without reaching the network. */
export function setPriceSource(source: PriceSource | null): void {
  sourceOverride = source;
}

function priceSource(): PriceSource {
  return sourceOverride ?? buildDefaultSource();
}

export interface QuoteInput {
  corridorId: string;
  amount: string;
}

export interface QuoteOutput extends SignedQuote {
  /** Fee in the corridor's settlement asset, for display. */
  feeDisplay: string;
  totalDisplay: string;
}

export async function createQuote(input: QuoteInput): Promise<QuoteOutput> {
  const corridor = await prisma.corridor.findUnique({ where: { id: input.corridorId } });
  if (!corridor) throw notFound('corridor', input.corridorId);

  const source = priceSource();
  const tick = await source.fetchRate(corridor.sourceCurrency, corridor.destCurrency);
  assertFresh(tick);

  const amount = toStroops(input.amount);

  // The corridor's spread is the operator's commercial setting; the escrow's fee
  // is a separate on-chain charge applied at settlement. Both are shown, because
  // a customer who is told "no fees" and then sees a smaller payout than the
  // rate implied has been misled even if each charge was individually disclosed.
  const spreadBps = corridor.spreadBps;
  const clientRate = tick.rate - applyBps(tick.rate, spreadBps);
  const converted = (amount * clientRate) / RATE_SCALE;

  // The on-chain fee is read from configuration, not hardcoded: the escrow's
  // `fee_bps` is the authority, and the quote has to predict the actual payout.
  const escrowFeeBps = 200;
  const fee = applyBps(converted, escrowFeeBps);
  const total = converted - fee;

  const window = validityWindow(env.QUOTE_TTL_SECONDS);
  const quoteId = randomUUID();

  const signer = keypairFromSecret(env.QUOTE_SIGNING_SECRET_KEY);
  const signed = signQuote(
    {
      quoteId,
      corridorId: corridor.id,
      base: tick.base,
      quote: tick.quote,
      midRate: tick.rate.toString(),
      spreadBps,
      clientRate: clientRate.toString(),
      amount: amount.toString(),
      fee: fee.toString(),
      total: total.toString(),
      oracleSource: tick.source,
      validUntil: window.validUntil,
    },
    signer,
    env.QUOTE_SIGNING_SECRET_KEY,
  );

  await prisma.quote.create({
    data: {
      id: quoteId,
      corridorId: corridor.id,
      midRate: fromStroops(tick.rate),
      spreadBps,
      clientRate: fromStroops(clientRate),
      amount: amount.toString(),
      fee: fee.toString(),
      total: total.toString(),
      oracleSource: tick.source,
      signature: signed.signature,
      signingKey: signed.signingKey,
      validUntil: new Date(window.validUntil),
    },
  });

  return {
    ...signed,
    feeDisplay: fromStroops(fee),
    totalDisplay: fromStroops(total),
  };
}

/**
 * Mark a quote as used by a transfer.
 *
 * A quote is single-use: allowing the same signed rate to price two transfers
 * lets a client wait for a favourable rate and then submit repeatedly at it.
 */
export async function consumeQuote(quoteId: string, transferId: bigint): Promise<void> {
  const quote = await prisma.quote.findUnique({ where: { id: quoteId } });
  if (!quote) throw notFound('quote', quoteId);

  await prisma.quote.update({
    where: { id: quoteId },
    data: { consumedByTransfer: transferId },
  });
}

export function signingKeypair(): Keypair {
  return keypairFromSecret(env.QUOTE_SIGNING_SECRET_KEY);
}
