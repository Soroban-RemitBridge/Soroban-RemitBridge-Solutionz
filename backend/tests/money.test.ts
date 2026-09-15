import { describe, expect, it } from 'vitest';

import { applyBps, assertSafeBps, fromStroops, MAX_BPS, toStroops } from '../src/lib/money.js';

/**
 * These tests are the reason money never becomes a `number` in this service. The
 * first case below is the one that silently fails with doubles, and it is not
 * hypothetical: 2^53 stroops is about 900 million XLM, well within the range a
 * high-value corridor can move.
 */
describe('toStroops', () => {
  it('parses whole and fractional amounts exactly', () => {
    expect(toStroops('1')).toBe(10_000_000n);
    expect(toStroops('12.5')).toBe(125_000_000n);
    expect(toStroops('0.0000001')).toBe(1n);
    expect(toStroops('12.3456789')).toBe(123_456_789n);
  });

  it('keeps precision far beyond what a double can hold', () => {
    // 9007199254740993 is 2^53 + 1: the smallest integer a double cannot represent.
    const exact = toStroops('900719925.4740993');
    expect(exact).toBe(9_007_199_254_740_993n);
    expect(BigInt(Number(exact))).not.toBe(exact);
  });

  it('rejects anything that is not an exact decimal', () => {
    expect(() => toStroops('1.2.3')).toThrow(/valid decimal/);
    expect(() => toStroops('-5')).toThrow(/valid decimal/);
    expect(() => toStroops('1e7')).toThrow(/valid decimal/);
    expect(() => toStroops('1.00000001')).toThrow(/7 decimal places/);
  });
});

describe('fromStroops', () => {
  it('round-trips every amount it produces', () => {
    for (const value of ['0.0000001', '1', '12.5', '900719925.4740993']) {
      expect(fromStroops(toStroops(value))).toBe(value.replace(/^0\.0+$/, '0'));
    }
  });

  it('renders zero and negatives without loss', () => {
    expect(fromStroops(0n)).toBe('0');
    expect(fromStroops(-1n)).toBe('-0.0000001');
  });
});

describe('applyBps', () => {
  it('matches the escrow: rounds down in the payer\u2019s favour', () => {
    // 2% of 1000 = 20.
    expect(applyBps(1_000n, 200)).toBe(20n);
    // 3 bps of 333 = 0.0999 -> 0, not 1. The escrow's `fee_for` divides with
    // integer arithmetic, so anything else would make the quote and the
    // settlement disagree.
    expect(applyBps(333n, 3)).toBe(0n);
    // 150% (the pool's collateral ratio) is expressed with the same helper.
    expect(applyBps(1_001n, 15_000)).toBe(1_501n);
  });

  it('refuses out-of-range basis points instead of clamping', () => {
    expect(() => applyBps(100n, MAX_BPS + 1)).toThrow(/out of range/);
    expect(() => applyBps(100n, -1)).toThrow(/out of range/);
    expect(() => applyBps(100n, 1.5)).toThrow(/out of range/);
    expect(() => assertSafeBps(10_000)).not.toThrow();
    // Ratios above 100% are in range on purpose; only a unit mix-up is rejected.
    expect(() => assertSafeBps(15_000)).not.toThrow();
  });
});
