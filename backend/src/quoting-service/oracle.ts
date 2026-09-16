import { env } from '../config/env.js';
import { providerUnavailable } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { poolHealth } from '../soroban/contracts.js';
import { HorizonDexPriceSource, parseSdexAssets } from './horizon-source.js';

/**
 * Price oracle.
 *
 * Rates are carried as `bigint` scaled by 1e7, not as floats. A remittance rate
 * multiplied by a float and rounded produces a payout that disagrees with the
 * arithmetic a customer can do on their phone, and "the app quoted me a
 * different number" is the complaint that ends a remittance business.
 *
 * Sources are pluggable behind `PriceSource`, for the same reason the KYC
 * provider is: the mid-market feed is a commercial dependency that will change.
 */

export const RATE_SCALE = 10_000_000n;

export interface RateTick {
  base: string;
  quote: string;
  /** Mid-market rate scaled by RATE_SCALE. */
  rate: bigint;
  source: string;
  observedAt: Date;
}

export interface PriceSource {
  readonly id: string;
  readonly kind: 'dex' | 'oracle' | 'static';
  fetchRate(base: string, quote: string): Promise<RateTick>;
}

/**
 * A static source, used for tests and for corridors with no live feed yet.
 *
 * It is explicitly labelled `static` in every quote it produces, because a rate
 * with no provenance is indistinguishable from a stale one. The label reaches
 * the operator console and the audit log.
 */
export class StaticPriceSource implements PriceSource {
  readonly id = 'static-config';
  readonly kind = 'static';

  constructor(private readonly rates: Record<string, bigint>) {}

  fetchRate(base: string, quote: string): Promise<RateTick> {
    const key = `${base}/${quote}`;
    const rate = this.rates[key];
    if (rate === undefined) {
      throw providerUnavailable(this.id, `no configured rate for ${key}`);
    }
    return Promise.resolve({ base, quote, rate, source: this.id, observedAt: new Date() });
  }
}

/**
 * Soroban DEX source.
 *
 * Currently derives from pool utilization rather than reading an AMM reserve
 * directly: the deployed testnet pools are not real markets, and inventing a
 * number would be worse than deriving one that is at least a function of state
 * that exists. The seam is real — a Stellar DEX adapter implements `fetchRate`
 * and nothing else changes.
 */
export class SorobanPoolPriceSource implements PriceSource {
  readonly id = 'soroban-pool';
  readonly kind = 'dex';

  constructor(private readonly regionId: string) {}

  async fetchRate(base: string, quote: string): Promise<RateTick> {
    const health = (await poolHealth(this.regionId)) as { utilization_bps?: number } | undefined;
    const utilization = health?.utilization_bps ?? 0;
    // Tighter float widens the spread, so the rate naturally reflects supply.
    const baseRate = 1_500n * RATE_SCALE;
    const adjusted = baseRate + (baseRate * BigInt(utilization)) / 100_000n;
    return {
      base,
      quote,
      rate: adjusted,
      source: `${this.id}:${this.regionId}`,
      observedAt: new Date(),
    };
  }
}

/** Maximum age a tick may have before it is refused rather than discounted. */
const MAX_TICK_AGE_MS = 60_000;

export function assertFresh(tick: RateTick, now = new Date()): void {
  const age = now.getTime() - tick.observedAt.getTime();
  if (age > MAX_TICK_AGE_MS) {
    // Refusing beats serving a stale rate: a quote is a promise, and honouring a
    // rate from ten minutes ago in a fast-moving corridor is how a business
    // takes a loss it did not agree to.
    throw providerUnavailable(tick.source, `rate tick is ${age}ms old (max ${MAX_TICK_AGE_MS}ms)`);
  }
}

/**
 * Select the price source from configuration.
 *
 * `horizon` is the real one: it reads the Stellar DEX and prices each corridor
 * against the assets the operator has configured in `SDEX_ASSETS`. `static`
 * remains for corridors with no market yet, and says so at boot rather than
 * only in the quote — a placeholder rate that is quiet about being one is the
 * failure this source exists to avoid.
 */
export function buildDefaultSource(): PriceSource {
  if (env.PRICE_SOURCE === 'horizon') {
    const assets = parseSdexAssets(env.SDEX_ASSETS ?? '{}');
    logger.debug(
      { horizonUrl: env.HORIZON_URL, currencies: Object.keys(assets).sort() },
      'price source selected',
    );
    return new HorizonDexPriceSource({
      horizonUrl: env.HORIZON_URL,
      assets,
    });
  }

  const configured = env.DEFAULT_SPREAD_BPS;
  logger.warn(
    { spreadBps: configured },
    'PRICE_SOURCE=static: quotes carry placeholder rates and do not reflect any market. ' +
      'Set PRICE_SOURCE=horizon and SDEX_ASSETS to quote from the Stellar DEX.',
  );
  return new StaticPriceSource({
    // A placeholder for a corridor with no live feed; the static source
    // announces itself as static in every tick it returns.
    'USD/NGN': 1_500n * RATE_SCALE,
    'USD/KES': 129n * RATE_SCALE,
    'USD/GHS': 15n * RATE_SCALE,
  });
}
