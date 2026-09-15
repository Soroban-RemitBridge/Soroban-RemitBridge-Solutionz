/**
 * Display formatting for the app.
 *
 * Same rule as the console: amounts are never parsed into a `number`. Stroop
 * values are strings from the backend and stay strings, grouped with a regex
 * rather than `Number.toLocaleString`, because the whole reason the backend
 * sends strings is that a double cannot hold an `i128`.
 */

const STROOPS_PER_UNIT = 10_000_000n;

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatAmount(value: string | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || value === '') return '—';
  if (!/^-?\d+$/.test(value)) return value;
  try {
    const total = BigInt(value);
    const negative = total < 0n;
    const absolute = negative ? -total : total;
    const whole = absolute / STROOPS_PER_UNIT;
    const fraction = (absolute % STROOPS_PER_UNIT).toString().padStart(7, '0');
    return `${negative ? '-' : ''}${group(whole.toString())}${decimals > 0 ? `.${fraction.slice(0, decimals)}` : ''}`;
  } catch {
    return value;
  }
}

/** Amounts a recipient sees are usually the local currency, quoted as text. */
export function formatRate(rate: string | number): string {
  const rendered = typeof rate === 'number' ? rate.toString() : rate;
  const [whole = '0', fraction] = rendered.split('.');
  return fraction === undefined ? group(whole) : `${group(whole)}.${fraction}`;
}

export function formatCountdown(secondsRemaining: number): string {
  if (secondsRemaining <= 0) return 'expired';
  if (secondsRemaining < 60) return `${Math.ceil(secondsRemaining)}s`;
  const minutes = Math.floor(secondsRemaining / 60);
  const seconds = Math.round(secondsRemaining % 60);
  return `${minutes}m ${seconds}s`;
}

/**
 * Truncate an address or hash for display.
 *
 * Head and tail both kept: someone verifying against a block explorer needs the
 * prefix, and someone comparing two records needs the suffix.
 */
export function shortId(value: string | null | undefined, head = 6, tail = 6): string {
  if (!value) return '—';
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
