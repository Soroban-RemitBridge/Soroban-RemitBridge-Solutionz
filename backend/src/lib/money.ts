/**
 * Exact monetary arithmetic.
 *
 * Soroban amounts are `i128`. JavaScript numbers are doubles, so the moment a
 * stroop amount passes through `number` it can silently lose precision above
 * 2^53 — and a rounding error in a remittance is a wrong cash payout at a shop
 * counter. Every amount therefore stays a `bigint` in this service, and only
 * crosses into `number` where a type system enforces that it is safe (basis
 * points, counts, ledger numbers).
 */

export const STROOPS_PER_UNIT = 10_000_000n;

/** Parse a user-facing decimal string ("12.50") into stroops. */
export function toStroops(amount: string): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Not a valid decimal amount: "${amount}"`);
  }

  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > 7) {
    throw new Error(`Amount has more than 7 decimal places: "${amount}"`);
  }

  const padded = fraction.padEnd(7, '0');
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt(padded);
}

/** Render stroops back to a decimal string for display or an API response. */
export function fromStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const absolute = negative ? -stroops : stroops;
  const whole = absolute / STROOPS_PER_UNIT;
  const fraction = absolute % STROOPS_PER_UNIT;
  const rendered = `${whole.toString()}.${fraction.toString().padStart(7, '0')}`.replace(/\.?0+$/, '');
  return negative ? `-${rendered === '' ? '0' : rendered}` : rendered || '0';
}

/**
 * Basis-point application with the same rounding the contracts use.
 *
 * Rounds down, in the payer's favour, matching `fee_for` in the escrow. If these
 * two ever disagree the quote shown to a sender differs from the transfer that
 * settles, which is the worst possible kind of bug in a remittance product — so
 * the shared behaviour is stated here as well as tested.
 */
export function applyBps(amount: bigint, bps: number): bigint {
  assertSafeBps(bps);
  return (amount * BigInt(bps)) / 10_000n;
}

/**
 * Ceiling for a basis-point multiplier.
 *
 * `fee_for` in the escrow only ever sees 0–10 000 (0–100%), but the same helper
 * expresses the pool's collateral ratio, which is legitimately above 100%: a
 * 150% over-collateralisation requirement is 15 000 bps, and that exact value
 * appears in the liquidity service. The ceiling is therefore set well above any
 * ratio the network would configure, so it catches a unit mix-up — a percentage
 * where basis points were meant — rather than a legitimate configuration.
 */
export const MAX_BPS = 100_000;

export function assertSafeBps(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_BPS) {
    throw new Error(`Basis points out of range: ${bps}`);
  }
}

/** Serialise a `bigint` for JSON without going through `number`. */
export function bigintToJson(value: bigint): string {
  return value.toString();
}
