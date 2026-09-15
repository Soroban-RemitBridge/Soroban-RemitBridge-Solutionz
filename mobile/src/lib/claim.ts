import * as Crypto from 'expo-crypto';

/**
 * Claim codes — the commit-reveal half that lives on the device.
 *
 * The escrow stores `sha256(reveal)` and never the reveal itself, and its
 * `reveal` parameter is `BytesN<32>`. That constraint shapes everything here:
 *
 * **The code is exactly 32 characters drawn from a 32-symbol alphabet, so its
 * UTF-8 bytes are exactly 32 bytes and *are* the reveal.** No encoding layer
 * sits between what the sender writes down and what the contract receives, which
 * removes the most likely place for this flow to break: a code that hashes to
 * something the chain never saw.
 *
 * **The alphabet is Crockford base32**, which omits `I`, `L`, `O` and `U`.
 * Those are the characters people mis-transcribe, and the recipient of a
 * remittance may well be reading a code aloud to an agent. `normaliseClaimCode`
 * maps the two colloquially-recoverable cases (`I`/`L` to `1`, `O` to `0`) so a
 * likely slip still resolves rather than failing the transfer.
 *
 * Entropy is 32 × log2(32) = 160 bits, which is not brute-forceable and is the
 * reason `getRandomBytesAsync` (a native CSPRNG) is used rather than
 * `Math.random`.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const CLAIM_CODE_LENGTH = 32;

/** How many characters go in each display group. */
const GROUP_SIZE = 4;

export class InvalidClaimCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidClaimCodeError';
  }
}

export interface ClaimCode {
  /** The canonical, ungrouped 32-character form. This is what gets hashed. */
  code: string;
  /** `sha256(code)` as lowercase hex — the only part that goes on-chain. */
  hash: string;
}

/**
 * Mint a claim code.
 *
 * The modulo is unbiased: 256 is an exact multiple of 32, so every symbol is
 * equally likely. A non-power-of-two alphabet here would silently make some
 * characters more probable than others.
 */
export async function generateClaimCode(): Promise<ClaimCode> {
  const random = await Crypto.getRandomBytesAsync(CLAIM_CODE_LENGTH);
  let code = '';
  for (let index = 0; index < CLAIM_CODE_LENGTH; index += 1) {
    code += ALPHABET[(random[index] ?? 0) % ALPHABET.length];
  }
  return { code, hash: await hashClaimCode(code) };
}

/**
 * `sha256` of the code, as hex.
 *
 * `digestStringAsync` hashes the UTF-8 bytes, which is exactly the `BytesN<32>`
 * the contract will verify against once the code is revealed. Hashing the
 * displayed, hyphenated form instead would produce a hash no reveal could ever
 * satisfy — so callers are expected to pass the canonical code, and this throws
 * rather than quietly hashing something else.
 */
export async function hashClaimCode(code: string): Promise<string> {
  const canonical = normaliseClaimCode(code);
  if (canonical.length !== CLAIM_CODE_LENGTH) {
    throw new InvalidClaimCodeError(
      `a claim code is ${CLAIM_CODE_LENGTH} characters; got ${canonical.length}`,
    );
  }
  if (!isCanonical(canonical)) {
    throw new InvalidClaimCodeError('claim code contains a character outside the alphabet');
  }
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, canonical);
}

/**
 * Uppercase, strip separators, and repair the two slips worth repairing.
 *
 * Deliberately conservative: a wrong character that maps to a different *valid*
 * symbol would turn a typo into a hash mismatch the agent cannot diagnose, so
 * only the unambiguous substitutions are applied.
 */
export function normaliseClaimCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

/** Group for display: `ABCD-EFGH-…`. */
export function formatClaimCode(code: string): string {
  const canonical = normaliseClaimCode(code);
  const groups: string[] = [];
  for (let index = 0; index < canonical.length; index += GROUP_SIZE) {
    groups.push(canonical.slice(index, index + GROUP_SIZE));
  }
  return groups.join('-');
}

export function isCanonical(code: string): boolean {
  return [...code].every((character) => ALPHABET.includes(character));
}

export function isWellFormedClaimCode(code: string): boolean {
  const canonical = normaliseClaimCode(code);
  return canonical.length === CLAIM_CODE_LENGTH && isCanonical(canonical);
}

export type ClaimVerification =
  | { status: 'matches' }
  | { status: 'malformed'; reason: string }
  | { status: 'mismatch'; actual: string; expected: string };

/**
 * Check a revealed code against the hash recorded for a transfer.
 *
 * The agent app runs this before attempting an on-chain claim so a mistyped code
 * fails on the phone, in front of the customer, instead of as a rejected
 * transaction with a fee attached. It is not a security boundary: anyone holding
 * the code can compute the same hash. It is a usability check that happens to be
 * the same arithmetic the contract performs.
 */
export async function verifyClaimCode(
  code: string,
  expectedHash: string,
): Promise<ClaimVerification> {
  if (!isWellFormedClaimCode(code)) {
    const canonical = normaliseClaimCode(code);
    return {
      status: 'malformed',
      reason:
        canonical.length === 0
          ? 'no code entered'
          : `expected ${CLAIM_CODE_LENGTH} characters, got ${canonical.length}`,
    };
  }

  const actual = await hashClaimCode(code);
  if (actual.toLowerCase() !== expectedHash.toLowerCase()) {
    return { status: 'mismatch', actual, expected: expectedHash };
  }
  return { status: 'matches' };
}
