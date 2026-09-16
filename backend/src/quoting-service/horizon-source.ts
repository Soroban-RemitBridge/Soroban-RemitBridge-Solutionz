import { z } from 'zod';

import { providerUnavailable } from '../lib/errors.js';
import { RATE_SCALE, type PriceSource, type RateTick } from './oracle.js';

/**
 * A real price source: the Stellar DEX, read through Horizon.
 *
 * This is the implementation that replaces the static placeholder. It quotes
 * what the market will actually pay for the probe size below, and it refuses —
 * with a named error, not an invented number — when there is no market to read.
 *
 * ## Why `strict-send` rather than the order book
 *
 * A direct `/order_book` call only prices a pair that trades against itself.
 * Almost nothing on the DEX does: an anchor's NGN token trades against XLM or
 * against a stablecoin, not against USD. `/paths/strict-send` returns the
 * *executable* rate for a source amount, following up to the path length the
 * network allows, so a corridor prices correctly however many hops the market
 * happens to use.
 *
 * The consequence worth stating plainly: the rate is the executable rate for
 * `PROBE_AMOUNT`, not a mid-market quote for any size. A larger transfer gets a
 * worse rate, which is true of the market rather than of this code — but it means
 * the number here is a rate *for that path at that size*, and pricing a corridor
 * off a probe far from its typical transfer size would be misleading. The probe
 * is therefore a constant with a comment rather than a magic number at the call
 * site.
 *
 * ## Arithmetic
 *
 * Everything is `bigint` at 7 decimal places, like every other amount in this
 * service. Horizon returns decimals as strings; parsing one into a `number`
 * would reintroduce exactly the float error the quoting path exists to avoid.
 */

/**
 * How much of the source currency to price the path with.
 *
 * 100 units is a plausible single retail remittance, which is the size this
 * corridor actually settles. It is deliberately not configurable per request:
 * letting a caller choose the probe size would let a caller choose a favourable
 * print and then submit a larger transfer at it.
 */
const PROBE_AMOUNT = '100';

/** Stellar's own precision. Every amount on the wire is 7 decimal places. */
const STELLAR_DECIMALS = 7;

/**
 * A currency, mapped to the asset the DEX trades it as.
 *
 * `issuer` is `null` for the native asset (XLM), which has no issuer and cannot
 * be represented as a credit asset.
 */
export interface SdexAsset {
  code: string;
  issuer: string | null;
}

/**
 * Parse `SDEX_ASSETS`.
 *
 * Fails loudly on a malformed mapping rather than skipping the entry: a typo in
 * an issuer looks exactly like a corridor with no market, so silently dropping it
 * would send someone to debug the wrong end of the problem.
 */
export function parseSdexAssets(raw: string): Record<string, SdexAsset> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`SDEX_ASSETS is not valid JSON: ${String(cause)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('SDEX_ASSETS must be a JSON object mapping a currency to an asset.');
  }

  const assets: Record<string, SdexAsset> = {};
  for (const [currency, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(`SDEX_ASSETS["${currency}"] must be a string, e.g. "USDC:GABC…" or "native".`);
    }
    if (value === 'native') {
      assets[currency] = { code: 'XLM', issuer: null };
      continue;
    }
    const separator = value.indexOf(':');
    const code = separator === -1 ? '' : value.slice(0, separator);
    const issuer = separator === -1 ? '' : value.slice(separator + 1);
    if (code.length === 0 || issuer.length === 0) {
      throw new Error(
        `SDEX_ASSETS["${currency}"] must be "CODE:ISSUER" or "native", got "${value}".`,
      );
    }
    assets[currency] = { code, issuer };
  }
  return assets;
}

/**
 * A Stellar decimal string → a scaled `bigint`.
 *
 * Rejects rather than coerces. `Number(value)` on a malformed amount yields a
 * plausible-looking rate from garbage, and this number reaches a signed quote.
 */
export function parseStellarAmount(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error(`not a Stellar decimal amount: "${value}"`);
  const [, sign, whole = '', fraction = ''] = match;
  if (fraction.length > STELLAR_DECIMALS) {
    throw new Error(`"${value}" has more than ${STELLAR_DECIMALS} decimal places`);
  }
  const padded = fraction.padEnd(STELLAR_DECIMALS, '0');
  const scaled = BigInt(whole) * 10n ** BigInt(STELLAR_DECIMALS) + BigInt(padded);
  return sign === '-' ? -scaled : scaled;
}

function assetTypeOf(asset: SdexAsset): string {
  if (asset.issuer === null) return 'native';
  return asset.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12';
}

function queryFor(asset: SdexAsset, params: URLSearchParams, prefix: string): void {
  params.set(`${prefix}_asset_type`, assetTypeOf(asset));
  if (asset.issuer !== null) {
    params.set(`${prefix}_asset_code`, asset.code);
    params.set(`${prefix}_asset_issuer`, asset.issuer);
  }
}

/** One record of the `strict-send` response, validated before it is trusted. */
const pathRecordSchema = z.object({
  source_amount: z.string(),
  destination_amount: z.string(),
  destination_asset_type: z.string(),
  destination_asset_code: z.string().optional(),
  destination_asset_issuer: z.string().optional(),
});

const strictSendSchema = z.object({
  _embedded: z.object({ records: z.array(pathRecordSchema) }),
});

export interface HorizonPriceSourceOptions {
  horizonUrl: string;
  /** Currency → asset. A currency absent here cannot be priced. */
  assets: Record<string, SdexAsset>;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class HorizonDexPriceSource implements PriceSource {
  readonly id = 'horizon-sdex';
  readonly kind = 'dex';

  readonly #horizonUrl: string;
  readonly #assets: Record<string, SdexAsset>;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: HorizonPriceSourceOptions) {
    this.#horizonUrl = options.horizonUrl.replace(/\/+$/, '');
    this.#assets = options.assets;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async fetchRate(base: string, quote: string): Promise<RateTick> {
    const sourceAsset = this.#assets[base];
    const destinationAsset = this.#assets[quote];
    if (!sourceAsset || !destinationAsset) {
      // Fail closed and name the missing currency: without it, the message would
      // read as "the DEX has no market", which sends someone to the wrong place.
      const missing = !sourceAsset ? base : quote;
      throw providerUnavailable(
        this.id,
        `no SDEX asset configured for ${missing}; add it to SDEX_ASSETS`,
      );
    }

    const params = new URLSearchParams();
    queryFor(sourceAsset, params, 'source');
    params.set('source_amount', PROBE_AMOUNT);
    params.set('destination_assets', this.#renderDestination(destinationAsset));
    const url = `${this.#horizonUrl}/paths/strict-send?${params.toString()}`;

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      throw providerUnavailable(this.id, `Horizon request failed: ${describe(cause)}`);
    }

    if (!response.ok) {
      throw providerUnavailable(this.id, `Horizon returned ${response.status} for ${base}/${quote}`);
    }

    const body: unknown = await response.json().catch(() => null);
    const parsed = strictSendSchema.safeParse(body);
    if (!parsed.success) {
      throw providerUnavailable(this.id, 'Horizon returned an unrecognised paths response');
    }

    const records = parsed.data._embedded.records;
    if (records.length === 0) {
      throw providerUnavailable(
        this.id,
        `no SDEX path from ${base} (${render(sourceAsset)}) to ${quote} (${render(destinationAsset)})`,
      );
    }

    // The best path for the probe size, as `destination / source` scaled. Each
    // record is priced on its own amounts rather than assuming they all share one
    // probe, and the comparison is between scaled bigints — for the same reason
    // everything else here is a bigint.
    let rate: bigint | null = null;
    for (const record of records) {
      // An amount this code cannot parse is a provider fault, not a request
      // fault: it must surface as a 503 rather than as a 500 from a bare throw.
      const destinationAmount = parseAmount(record.destination_amount, this.id);
      const sourceAmount = parseAmount(record.source_amount, this.id);
      if (sourceAmount <= 0n) continue;
      // Truncating rather than rounding: the corridor spread and the escrow's fee
      // are applied to this number, and rounding a rate up is rounding a payout up.
      const candidate = (destinationAmount * RATE_SCALE) / sourceAmount;
      if (rate === null || candidate > rate) rate = candidate;
    }

    if (rate === null || rate <= 0n) {
      throw providerUnavailable(this.id, 'Horizon returned no usable rate for the requested path');
    }

    return {
      base,
      quote,
      rate,
      // Provenance reaches the signed quote and the audit log, so it names the
      // venue and the pair that produced the number rather than just "dex".
      source: `${this.id}:${render(sourceAsset)}->${render(destinationAsset)}`,
      observedAt: new Date(),
    };
  }

  #renderDestination(asset: SdexAsset): string {
    return asset.issuer === null ? 'native' : `${asset.code}:${asset.issuer}`;
  }
}

function render(asset: SdexAsset): string {
  return asset.issuer === null ? asset.code : `${asset.code}:${asset.issuer}`;
}

function parseAmount(value: string, provider: string): bigint {
  try {
    return parseStellarAmount(value);
  } catch (cause) {
    throw providerUnavailable(provider, `Horizon returned an unparseable amount: ${describe(cause)}`);
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.name === 'TimeoutError' ? 'timed out' : cause.message;
  }
  return String(cause);
}
