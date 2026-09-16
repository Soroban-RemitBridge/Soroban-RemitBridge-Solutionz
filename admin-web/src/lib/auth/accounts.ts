import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Operator accounts.
 *
 * This module is **server-only**: it uses `node:crypto` for `scrypt`, which the
 * Edge runtime `middleware.ts` cannot do. Middleware imports
 * `lib/auth/session.ts` and `lib/auth/policy.ts` only, and both are written
 * against WebCrypto so the same verification runs in both places.
 *
 * ## Why accounts come from the environment
 *
 * There is no user table, and adding one would put operator credentials in the
 * same database as the KYC data. Until there is an identity provider, the
 * operators are configuration: a named list in `OPERATOR_ACCOUNTS`, checked at
 * boot. That is a real limitation and it is stated as one — it means onboarding an
 * operator is a deploy, and it does not survive multiple instances disagreeing
 * about the environment.
 *
 * What it does buy is the thing that was missing: an operator console that can
 * authorise an agent, move float and publish revocations now requires a
 * credential, and every action carries a real person's identity instead of a
 * fixed deployment-wide placeholder.
 *
 * ## Password storage
 *
 * `scrypt`, with the parameters recorded in the stored string so they can be
 * raised later without invalidating existing hashes. The format is:
 *
 * ```
 * scrypt$<N>$<r>$<p>$<salt-base64>$<hash-base64>
 * ```
 *
 * `admin-web/scripts/operator-hash.mjs` produces these; the suite asserts that
 * the script and this module agree, because a hash generator that drifts from the
 * verifier locks everyone out.
 */

import { ROLES, type Role } from './roles';

// Re-exported for the callers that already depend on this module (the suite, the
// login route). `middleware.ts` and `session.ts` must import from `./roles`
// instead: importing them from here would pull `node:crypto` into the Edge bundle.
export { ROLES, type Role };

export interface OperatorAccount {
  email: string;
  name: string;
  /** `scrypt$…` as produced by `hashPassword`. Never a plaintext password. */
  passwordHash: string;
  roles: readonly Role[];
}

/** Default scrypt cost. `N` is the only one worth raising over time. */
export const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1 } as const;

const KEY_BYTES = 32;
const SALT_BYTES = 16;

export function hashPassword(
  password: string,
  options: { salt?: Buffer; params?: { N: number; r: number; p: number } } = {},
): string {
  const params = options.params ?? SCRYPT_PARAMS;
  const salt = options.salt ?? randomBytes(SALT_BYTES);
  const derived = scryptSync(password, salt, KEY_BYTES, params);
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Verify a password against a stored hash.
 *
 * Returns `false` for a malformed stored hash rather than throwing: a broken
 * entry in configuration should refuse that operator, not take the login route
 * down for everyone else.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Guards against a config value that would make scrypt allocate absurdly.
  if (N <= 1 || (N & (N - 1)) !== 0 || r <= 0 || p <= 0 || N > 1 << 20) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(hashRaw ?? '', 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  const salt = Buffer.from(saltRaw ?? '', 'base64');
  const derived = scryptSync(password, salt, expected.length, { N, r, p });
  return timingSafeEqual(derived, expected);
}

/**
 * Parse `OPERATOR_ACCOUNTS`.
 *
 * Throws on a malformed entry rather than skipping it. A silently dropped
 * operator looks exactly like a wrong password, which is the least debuggable
 * failure this file could produce.
 */
export function parseOperatorAccounts(raw: string | undefined): OperatorAccount[] {
  if (raw === undefined || raw.trim().length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`OPERATOR_ACCOUNTS is not valid JSON: ${String(cause)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('OPERATOR_ACCOUNTS must be a JSON array of operator objects.');
  }

  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`OPERATOR_ACCOUNTS[${index}] must be an object.`);
    }
    const { email, name, passwordHash, roles } = entry as Record<string, unknown>;

    if (typeof email !== 'string' || !email.includes('@')) {
      throw new Error(`OPERATOR_ACCOUNTS[${index}].email must be an email address.`);
    }
    const key = email.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`OPERATOR_ACCOUNTS has a duplicate entry for ${email}.`);
    }
    seen.add(key);

    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new Error(`OPERATOR_ACCOUNTS[${index}].name must be a non-empty string.`);
    }
    if (typeof passwordHash !== 'string' || !passwordHash.startsWith('scrypt$')) {
      throw new Error(
        `OPERATOR_ACCOUNTS[${index}].passwordHash must be a scrypt$… hash, not a plaintext password.`,
      );
    }
    if (!Array.isArray(roles) || roles.length === 0) {
      throw new Error(`OPERATOR_ACCOUNTS[${index}].roles must be a non-empty array.`);
    }
    for (const role of roles) {
      if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) {
        throw new Error(
          `OPERATOR_ACCOUNTS[${index}].roles contains "${String(role)}", which is not one of ${ROLES.join(', ')}.`,
        );
      }
    }

    return {
      email: key,
      name,
      passwordHash,
      roles: roles as Role[],
    };
  });
}

/** Look up an operator by email, case-insensitively. */
export function findOperator(
  accounts: readonly OperatorAccount[],
  email: string,
): OperatorAccount | undefined {
  const key = email.trim().toLowerCase();
  return accounts.find((account) => account.email === key);
}

/**
 * The account list for this process, parsed once.
 *
 * Read lazily rather than at module scope so that importing this module from a
 * test does not require a populated environment.
 */
export function operatorAccounts(): OperatorAccount[] {
  return parseOperatorAccounts(process.env['OPERATOR_ACCOUNTS']);
}
