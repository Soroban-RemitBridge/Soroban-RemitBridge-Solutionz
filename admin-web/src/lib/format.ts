/**
 * Display formatting.
 *
 * Two rules hold throughout: amounts are never parsed into a `number`, and an
 * unknown value renders as a visible placeholder rather than as `0` or `NaN`.
 * Showing a confident zero for a missing float figure is the failure mode that
 * matters — an operator would read it as "this agent has no liquidity" and act
 * on it.
 */

const STROOPS_PER_UNIT = 10_000_000n;

/** Group an integer string with thousands separators, without going via `Number`. */
function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatStroops(value: string | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || value === '') return '—';
  if (!/^-?\d+$/.test(value)) return value; // Already decimalised upstream.
  try {
    const total = BigInt(value);
    const negative = total < 0n;
    const absolute = negative ? -total : total;
    const whole = absolute / STROOPS_PER_UNIT;
    const fraction = (absolute % STROOPS_PER_UNIT).toString().padStart(7, '0');
    const trimmed = fraction.slice(0, decimals);
    return `${negative ? '-' : ''}${group(whole.toString())}${decimals > 0 ? `.${trimmed}` : ''}`;
  } catch {
    return value;
  }
}

export function formatBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '—';
  return `${(bps / 100).toFixed(2)}%`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value).getTime();
  if (Number.isNaN(parsed)) return value;
  const seconds = Math.round((Date.now() - parsed) / 1_000);
  const magnitude = Math.abs(seconds);
  if (magnitude < 60) return seconds >= 0 ? `${seconds}s ago` : `in ${-seconds}s`;
  if (magnitude < 3_600) return `${Math.round(magnitude / 60)}m ${seconds >= 0 ? 'ago' : 'from now'}`;
  if (magnitude < 86_400) return `${Math.round(magnitude / 3_600)}h ${seconds >= 0 ? 'ago' : 'from now'}`;
  return `${Math.round(magnitude / 86_400)}d ${seconds >= 0 ? 'ago' : 'from now'}`;
}

/**
 * Truncate a Stellar address or hash.
 *
 * The head and tail are both kept: an operator checking a contract against a
 * deployment record needs the prefix, and a person comparing two agents needs
 * the suffix. A middle-ellipsis keeps both legible at a glance.
 */
export function shortId(value: string | null | undefined, head = 6, tail = 6): string {
  if (!value) return '—';
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return group(Math.trunc(value).toString());
}
