import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { decodeEvent, UndecodableEventError, type RawContractEvent } from '../src/event-indexer/decoder.js';

/**
 * These tests encode real `ScVal`s rather than hand-written base64 blobs. A
 * fixture with the wrong XDR would pass against a decoder that is itself wrong,
 * which is the failure mode this whole module exists to prevent.
 */
function encode(value: unknown, type?: string): string {
  return nativeToScVal(value, type === undefined ? undefined : { type }).toXDR('base64');
}

function event(topic: string, payload: unknown, subjects: unknown[] = []): RawContractEvent {
  return {
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M',
    ledger: 1_234,
    eventIndex: 0,
    txHash: 'abc123',
    topicXdr: [encode(topic, 'symbol'), ...subjects.map((subject) => encode(subject))],
    valueXdr: encode(payload),
    closedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('decodeEvent', () => {
  it('decodes a transfer creation with its sender and corridor as subjects', () => {
    const decoded = decodeEvent(
      event(
        'tr_create',
        [1n, 1_000n, 'CTOKEN', Buffer.alloc(32, 9), 1_700_000_000n],
        ['GSENDER', 'NGN_LAG'],
      ),
    );

    expect(decoded.kind).toBe('transfer.created');
    expect(decoded.subjects).toEqual(['GSENDER', 'NGN_LAG']);
    expect(decoded.transferId).toBe(1n);
    expect(decoded.payload['amount']).toBe('1000');
    expect(decoded.payload['expiry']).toBe('1700000000');
    // The hash is hex-encoded so an auditor can compare it against a claim code
    // without a binary tool.
    expect(decoded.payload['claimHash']).toBe(Buffer.alloc(32, 9).toString('hex'));
  });

  it('decodes a settlement into gross, fee and payout', () => {
    const decoded = decodeEvent(event('tr_claim', [7n, 1_000n, 20n, 980n], ['GAGENT', 'NGN_LAG']));
    expect(decoded.kind).toBe('transfer.claimed');
    expect(decoded.transferId).toBe(7n);
    expect(decoded.payload).toMatchObject({ gross: '1000', fee: '20', payout: '980' });
  });

  it('decodes a refund', () => {
    const decoded = decodeEvent(event('tr_refnd', [3n, 500n], ['GSENDER', 'NGN_LAG']));
    expect(decoded.kind).toBe('transfer.refunded');
    expect(decoded.transferId).toBe(3n);
  });

  it('reports a pool draw with the resulting exposure, not the increment', () => {
    const decoded = decodeEvent(event('lp_draw', [250n, 900n, 4_500], ['GAGENT', 'NG_LAG']));
    expect(decoded.kind).toBe('pool.drawn');
    expect(decoded.payload).toMatchObject({ amount: '250', exposure: '900', utilizationBps: 4_500 });
    // A draw has no transfer id. Getting this wrong would attach float exposure to
    // an unrelated remittance.
    expect(decoded.transferId).toBeNull();
  });

  it('raises on an unknown topic rather than dropping the event', () => {
    // A topic the indexer does not know means the contract was upgraded without
    // it. Continuing would silently drop events, and the API would then report a
    // transfer the customer can see on-chain as non-existent.
    expect(() => decodeEvent(event('not_a_topic', [1n]))).toThrow(UndecodableEventError);
  });

  it('raises on a payload with too few fields', () => {
    expect(() => decodeEvent(event('tr_create', [1n, 1_000n]))).toThrow(/expected at least 5 fields/);
  });

  it('raises rather than defaulting when an amount is not an integer', () => {
    expect(() => decodeEvent(event('tr_refnd', [1n, 'not-a-number']))).toThrow(UndecodableEventError);
  });

  it('keeps configuration events readable without inventing a shape for them', () => {
    const decoded = decodeEvent(event('esc_cfg', [200, true, 7_776_000], ['fee']));
    expect(decoded.kind).toBe('escrow.config_updated');
    expect(decoded.payload).toHaveProperty('value');
  });

  it('rejects an event whose first topic is not a symbol', () => {
    const raw = event('tr_create', [1n]);
    raw.topicXdr[0] = xdr.ScVal.scvU32(5).toXDR('base64');
    expect(() => decodeEvent(raw)).toThrow(/not a symbol/);
  });
});
