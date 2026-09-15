import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatBps,
  formatDateTime,
  formatNumber,
  formatRelative,
  formatStroops,
  shortId,
} from '../src/lib/format.js';

/**
 * Display formatting for the operator console.
 *
 * The rule these enforce is not cosmetic: an amount is never parsed into a
 * `number`, and an unknown value renders as a visible placeholder rather than as
 * `0` or `NaN`. Showing a confident zero for a missing float figure is the
 * failure mode that matters -- an operator reads it as "this agent has no
 * liquidity" and approves a top-up that was not needed, or withholds one that
 * was.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('formatStroops', () => {
  it('groups and scales without going via Number', () => {
    expect(formatStroops('1500000000')).toBe('150.00');
    expect(formatStroops('12345678901')).toBe('1,234.56');
  });

  it('keeps precision beyond 2^53 stroops', () => {
    // 1e16 stroops is outside the range a double represents exactly, so a
    // Number-based implementation is already wrong at this magnitude.
    expect(formatStroops('10000000000000001')).toBe('1,000,000,000.00');
    expect(formatStroops('9007199254740993')).toBe('900,719,925.47');
  });

  it('rounds sub-unit remainders down, never up', () => {
    // Rounding up would show an operator money the transfer does not contain.
    expect(formatStroops('999')).toBe('0.00');
    expect(formatStroops('19999999')).toBe('1.99');
  });

  it('renders a visible placeholder for a missing value, never 0', () => {
    expect(formatStroops(null)).toBe('—');
    expect(formatStroops(undefined)).toBe('—');
    expect(formatStroops('')).toBe('—');
  });

  it('passes through a value it did not produce', () => {
    expect(formatStroops('1,234.56')).toBe('1,234.56');
    expect(formatStroops('n/a')).toBe('n/a');
  });
});

describe('formatBps', () => {
  it('renders basis points as a percentage', () => {
    expect(formatBps(750)).toBe('7.50%');
    expect(formatBps(4_000)).toBe('40.00%');
    expect(formatBps(0)).toBe('0.00%');
  });

  it('treats a non-finite value as missing rather than rendering NaN', () => {
    expect(formatBps(null)).toBe('—');
    expect(formatBps(undefined)).toBe('—');
    expect(formatBps(Number.NaN)).toBe('—');
    expect(formatBps(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatDateTime', () => {
  it('renders an unambiguous UTC instant', () => {
    expect(formatDateTime('2026-09-15T12:34:56.789Z')).toBe('2026-09-15 12:34:56Z');
  });

  it('passes an unparseable value through so it is visibly wrong', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
    expect(formatDateTime(null)).toBe('—');
  });
});

describe('formatRelative', () => {
  it('describes a past instant', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T12:00:00.000Z'));

    expect(formatRelative('2026-09-15T11:59:30.000Z')).toBe('30s ago');
    expect(formatRelative('2026-09-15T11:45:00.000Z')).toBe('15m ago');
    expect(formatRelative('2026-09-15T09:00:00.000Z')).toBe('3h ago');
    expect(formatRelative('2026-09-13T12:00:00.000Z')).toBe('2d ago');
  });

  it('describes a future instant in the forward direction', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T12:00:00.000Z'));

    // A quote's validity window and a transfer's expiry are both in the future,
    // and "45s ago" for a deadline would be actively misleading.
    expect(formatRelative('2026-09-15T12:00:45.000Z')).toBe('in 45s');
    expect(formatRelative('2026-09-15T12:59:00.000Z')).toBe('59m from now');
    expect(formatRelative('2026-09-15T13:00:00.000Z')).toBe('1h from now');
  });

  it('treats a missing value as missing', () => {
    expect(formatRelative(null)).toBe('—');
    expect(formatRelative(undefined)).toBe('—');
  });
});

describe('formatNumber', () => {
  it('groups counts and truncates fractions', () => {
    expect(formatNumber(1_234_567)).toBe('1,234,567');
    expect(formatNumber(12.9)).toBe('12');
  });

  it('renders a placeholder for a missing or non-finite count', () => {
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(Number.NaN)).toBe('—');
  });
});

describe('shortId', () => {
  it('keeps head and tail, because both are needed', () => {
    // An operator checking a contract against a deployment record needs the
    // prefix; someone comparing two agents needs the suffix.
    expect(shortId('CABCDEFGHIJKLMNOPQRSTUVWXYZ234567890123456789012345678901')).toBe(
      'CABCDE…678901',
    );
  });

  it('leaves a short value intact', () => {
    expect(shortId('NG_LAG')).toBe('NG_LAG');
    expect(shortId(null)).toBe('—');
  });
});
