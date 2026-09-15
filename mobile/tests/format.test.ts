import { describe, expect, it } from 'vitest';

import {
  formatAmount,
  formatCountdown,
  formatRate,
  shortId,
} from '../src/lib/format.js';

/**
 * Display formatting for money.
 *
 * These look like cosmetic helpers and are not: the rule they enforce is that an
 * amount is never parsed into a `number`. The backend sends strings precisely
 * because a double cannot hold an `i128`, so a formatter that went via `Number`
 * would silently corrupt the largest transfers — the ones where a wrong figure
 * costs the most.
 */

describe('formatAmount', () => {
  it('renders stroops with grouping, without going via Number', () => {
    expect(formatAmount('12345678901')).toBe('1,234.56');
    expect(formatAmount('1000000000')).toBe('100.00');
    expect(formatAmount('10000000')).toBe('1.00');
  });

  /**
   * 10_000_000_000_000_000 is 1e16: outside `Number.MAX_SAFE_INTEGER`'s exact
   * integer range, so a `Number`-based implementation would already be wrong
   * here. This is the case the string pipeline exists for.
   */
  it('keeps full precision beyond 2^53 stroops', () => {
    expect(formatAmount('10000000000000001')).toBe('1,000,000,000.00');
    expect(formatAmount('9007199254740993')).toBe('900,719,925.47');
  });

  it('rounds sub-unit remainders down rather than up', () => {
    // 999 stroops is under one unit. Rounding up would show a recipient money
    // the transfer does not contain.
    expect(formatAmount('999')).toBe('0.00');
    expect(formatAmount('19999999')).toBe('1.99');
  });

  it('handles negatives without losing the sign', () => {
    expect(formatAmount('-15000000')).toBe('-1.50');
    expect(formatAmount('-999')).toBe('-0.00');
  });

  it('renders a visible placeholder for a missing value', () => {
    // Never "0" and never "NaN": an operator reading a confident zero would act
    // on a figure that does not exist.
    expect(formatAmount(null)).toBe('—');
    expect(formatAmount(undefined)).toBe('—');
    expect(formatAmount('')).toBe('—');
  });

  it('passes through a value it did not produce, rather than guessing', () => {
    expect(formatAmount('1,234.56')).toBe('1,234.56');
    expect(formatAmount('n/a')).toBe('n/a');
  });

  it('honours the requested decimal places', () => {
    expect(formatAmount('12345678901', 0)).toBe('1,234');
    expect(formatAmount('12345678901', 4)).toBe('1,234.5678');
  });
});

describe('formatRate', () => {
  it('groups the whole part and leaves the fraction alone', () => {
    expect(formatRate('1234.5678')).toBe('1,234.5678');
    expect(formatRate('1000000')).toBe('1,000,000');
    expect(formatRate(1500)).toBe('1,500');
  });

  it('does not invent a fraction that was not quoted', () => {
    expect(formatRate('129')).toBe('129');
  });
});

describe('formatCountdown', () => {
  it('reports a non-positive remaining time as expired', () => {
    expect(formatCountdown(0)).toBe('expired');
    expect(formatCountdown(-30)).toBe('expired');
  });

  it('counts up rather than down inside the last minute', () => {
    // `ceil` so the display never shows "0s" while time remains.
    expect(formatCountdown(45.2)).toBe('46s');
    expect(formatCountdown(1)).toBe('1s');
  });

  it('switches to minutes and seconds past a minute', () => {
    expect(formatCountdown(125)).toBe('2m 5s');
    expect(formatCountdown(60)).toBe('1m 0s');
  });
});

describe('shortId', () => {
  it('keeps head and tail, because both are needed', () => {
    // A real 56-character contract address.
    expect(shortId('CABCDEFGHIJKLMNOPQRSTUVWXYZ234567890123456789012345678901')).toBe(
      'CABCDE…678901',
    );
  });

  it('leaves a short value alone rather than padding it', () => {
    expect(shortId('NG_LAG')).toBe('NG_LAG');
    expect(shortId(null)).toBe('—');
  });

  it('respects the requested head and tail lengths', () => {
    expect(shortId('CABCDEFGHIJKLMNOP', 4, 4)).toBe('CABC…MNOP');
  });
});
