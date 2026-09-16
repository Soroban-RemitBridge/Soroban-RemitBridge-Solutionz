import { describe, expect, it } from 'vitest';

import { isAppError } from '../src/lib/errors.js';
import {
  HorizonDexPriceSource,
  parseSdexAssets,
  parseStellarAmount,
  type SdexAsset,
} from '../src/quoting-service/horizon-source.js';
import { RATE_SCALE } from '../src/quoting-service/oracle.js';

/**
 * The DEX source is the one place in this service that prices against a live
 * market, so the suite is written around what it must *refuse* to do: quote a
 * currency it has no asset for, quote a pair with no market, and treat a broken
 * response as anything other than a failure. An order-book read that guesses is
 * worse than one that fails, because the guess goes into a signed quote.
 *
 * Nothing here reaches the network: `fetch` is injected, and the fixtures are the
 * shape Horizon's `strict-send` endpoint actually returns.
 */

const USDC = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const ASSETS = {
  USD: { code: 'USDC', issuer: USDC },
  XLM: { code: 'XLM', issuer: null },
};

/** 100 units of source buying 149999 of destination: a 1499.99 rate. */
const DESTINATION_FOR_100 = '149999.0000000';
const EXPECTED_RATE = 1_499n * RATE_SCALE + (99n * RATE_SCALE) / 100n;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/**
 * `Response` is global, but the node typings in this workspace do not resolve
 * `RequestInfo`, so the stub narrows the input to what this source actually
 * passes — a URL string — and casts once, here, rather than at each call site.
 */
function stubFetch(
  handler: (url: string) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return handler(url);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** One `strict-send` record, in the shape Horizon returns it. */
function pathRecord(destinationAmount: string, sourceAmount = '100.0000000') {
  return {
    source_asset_type: 'credit_alphanum4',
    source_asset_code: 'USDC',
    source_asset_issuer: USDC,
    source_amount: sourceAmount,
    destination_asset_type: 'native',
    destination_amount: destinationAmount,
    path: [],
  };
}

function records(...amounts: string[]): Response {
  return jsonResponse({ _embedded: { records: amounts.map((amount) => pathRecord(amount)) } });
}

function source(overrides: { assets?: Record<string, SdexAsset>; fetchImpl?: typeof fetch } = {}) {
  return new HorizonDexPriceSource({
    horizonUrl: 'https://horizon-testnet.stellar.org',
    assets: overrides.assets ?? ASSETS,
    fetchImpl: overrides.fetchImpl ?? stubFetch(() => records(DESTINATION_FOR_100)).fetchImpl,
    timeoutMs: 5_000,
  });
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

describe('parseStellarAmount', () => {
  it('scales a Stellar decimal to 7 places without going through a float', () => {
    expect(parseStellarAmount('100')).toBe(1_000_000_000n);
    expect(parseStellarAmount('100.0000000')).toBe(1_000_000_000n);
    expect(parseStellarAmount('1499.9900000')).toBe(14_999_900_000n);
    expect(parseStellarAmount('0.0000001')).toBe(1n);
  });

  it('keeps precision a double would lose', () => {
    // 2^53 + 1 stroops, the same magnitude the money tests use: this value is not
    // representable as a double, which is why nothing on this path parses one.
    expect(parseStellarAmount('900719925474099.2000001')).toBe(9_007_199_254_740_992_000_001n);
  });

  it('refuses anything that is not a Stellar amount', () => {
    expect(() => parseStellarAmount('1e5')).toThrowError(/not a Stellar decimal/);
    expect(() => parseStellarAmount('')).toThrowError(/not a Stellar decimal/);
    expect(() => parseStellarAmount('1.00000001')).toThrowError(/more than 7 decimal places/);
  });
});

describe('parseSdexAssets', () => {
  it('reads an issued asset and the native asset', () => {
    expect(parseSdexAssets(`{"USD":"USDC:${USDC}","XLM":"native"}`)).toEqual({
      USD: { code: 'USDC', issuer: USDC },
      XLM: { code: 'XLM', issuer: null },
    });
  });

  it('fails loudly on a malformed mapping rather than skipping the entry', () => {
    // Skipping would leave a typo'd issuer looking exactly like a corridor with
    // no market, which sends someone to debug the wrong end of the problem.
    expect(() => parseSdexAssets('not json')).toThrowError(/not valid JSON/);
    expect(() => parseSdexAssets('["USD"]')).toThrowError(/must be a JSON object/);
    expect(() => parseSdexAssets('{"USD":42}')).toThrowError(/must be a string/);
    expect(() => parseSdexAssets('{"USD":"USDC"}')).toThrowError(/CODE:ISSUER/);
  });
});

describe('HorizonDexPriceSource.fetchRate', () => {
  it('prices the best path for the probe size', async () => {
    const { fetchImpl } = stubFetch(() => records('140000.0000000', DESTINATION_FOR_100));
    const tick = await source({ fetchImpl }).fetchRate('USD', 'XLM');

    // The better of the two records, not the first one returned.
    expect(tick.rate).toBe(EXPECTED_RATE);
    expect(tick.base).toBe('USD');
    expect(tick.quote).toBe('XLM');
  });

  it('labels the tick with the venue and the assets it priced', async () => {
    const tick = await source().fetchRate('USD', 'XLM');

    // Provenance reaches the signed quote and the audit log, so it names the
    // pair rather than a bare "dex".
    expect(tick.source).toBe(`horizon-sdex:USDC:${USDC}->XLM`);
    expect(tick.observedAt).toBeInstanceOf(Date);
    expect(Date.now() - tick.observedAt.getTime()).toBeLessThan(1_000);
  });

  it('asks for the native asset as native, with no code or issuer', async () => {
    const { fetchImpl, calls } = stubFetch(() => records(DESTINATION_FOR_100));
    await source({ fetchImpl }).fetchRate('XLM', 'USD');

    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/paths/strict-send');
    expect(url.searchParams.get('source_asset_type')).toBe('native');
    expect(url.searchParams.get('source_asset_code')).toBeNull();
    expect(url.searchParams.get('source_asset_issuer')).toBeNull();
    expect(url.searchParams.get('destination_assets')).toBe(`USDC:${USDC}`);
    expect(url.searchParams.get('source_amount')).toBe('100');
  });

  it('asks for a long asset code as credit_alphanum12', async () => {
    const { fetchImpl, calls } = stubFetch(() => records(DESTINATION_FOR_100));
    await source({
      assets: { LONGCODE: { code: 'LONGCODE', issuer: USDC } },
      fetchImpl,
    }).fetchRate('LONGCODE', 'LONGCODE');

    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('source_asset_type')).toBe('credit_alphanum12');
  });

  it('parses a response captured from the live network', async () => {
    // Captured from `horizon.stellar.org` on 2026-09-16: 100 USDC buying XLM.
    // Recorded verbatim rather than hand-written, because a fixture built from
    // this file's own assumptions would agree with a source that is wrong about
    // the real API.
    const live = {
      _embedded: {
        records: [
          {
            source_asset_type: 'credit_alphanum4',
            source_asset_code: 'USDC',
            source_asset_issuer: USDC,
            source_amount: '100.0000000',
            destination_asset_type: 'native',
            destination_amount: '569.3523040',
            path: [],
          },
        ],
      },
    };
    const { fetchImpl } = stubFetch(() => jsonResponse(live));
    const tick = await source({ fetchImpl }).fetchRate('USD', 'XLM');

    // 569.3523040 for 100 units, scaled by 1e7.
    expect(tick.rate).toBe(56_935_230n);
  });

  it('refuses a currency with no configured asset, and names it', async () => {
    const refusal = await refusalOf(source().fetchRate('USD', 'NGN'));
    expect(refusal.code).toBe('PROVIDER_UNAVAILABLE');
    expect(refusal.cause).toMatch(/no SDEX asset configured for NGN/);
  });

  it('refuses a pair with no market instead of inventing a rate', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ _embedded: { records: [] } }));
    const refusal = await refusalOf(source({ fetchImpl }).fetchRate('USD', 'XLM'));
    expect(refusal.cause).toMatch(/no SDEX path from USD \(USDC:.*\) to XLM \(XLM\)/);
  });

  it('refuses on a non-2xx response', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ title: 'Not Found' }, 404));
    const refusal = await refusalOf(source({ fetchImpl }).fetchRate('USD', 'XLM'));
    expect(refusal.code).toBe('PROVIDER_UNAVAILABLE');
    expect(refusal.cause).toMatch(/Horizon returned 404/);
  });

  it('refuses a body outside the expected shape', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse({ _embedded: { records: 'nope' } }));
    const refusal = await refusalOf(source({ fetchImpl }).fetchRate('USD', 'XLM'));
    expect(refusal.cause).toMatch(/unrecognised paths response/);
  });

  it('reports an unparseable amount as a provider fault, not a crash', async () => {
    const { fetchImpl } = stubFetch(() => records('not-a-number'));
    const refusal = await refusalOf(source({ fetchImpl }).fetchRate('USD', 'XLM'));
    expect(refusal.code).toBe('PROVIDER_UNAVAILABLE');
    expect(refusal.cause).toMatch(/unparseable amount/);
  });

  it('refuses a non-positive rate', async () => {
    const { fetchImpl } = stubFetch(() => records('0.0000000'));
    const refusal = await refusalOf(source({ fetchImpl }).fetchRate('USD', 'XLM'));
    expect(refusal.cause).toMatch(/no usable rate/);
  });

  it('refuses on a timeout, and says so rather than reporting the URL', async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new DOMException('The operation was aborted', 'TimeoutError');
    });
    const refusal = await refusalOf(source({ fetchImpl }).fetchRate('USD', 'XLM'));
    expect(refusal.cause).toMatch(/Horizon request failed: timed out/);
  });
});
