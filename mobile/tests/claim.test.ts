import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CLAIM_CODE_LENGTH,
  formatClaimCode,
  generateClaimCode,
  hashClaimCode,
  isCanonical,
  isWellFormedClaimCode,
  normaliseClaimCode,
  verifyClaimCode,
} from '../src/lib/claim.js';

/**
 * Tests for the commit-reveal half that lives on the device.
 *
 * This is the one place in the system where a mistake is unfixable rather than
 * merely wrong: the escrow stores `sha256(reveal)` at creation and can never be
 * told a different value, so a code whose bytes do not hash to what the chain
 * committed to produces a transfer nobody can claim. The contract cannot detect
 * it, and neither can a reviewer reading the call site.
 *
 * The aliased `expo-crypto` double hashes with `node:crypto`, so the digests
 * below are real SHA-256 over real UTF-8 bytes.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

describe('the 32-byte reveal', () => {
  /**
   * This is the property the whole design rests on, and the reason the code is
   * 32 characters from a 32-symbol alphabet rather than a friendlier length. The
   * escrow's `reveal` parameter is `BytesN<32>`, so the code's UTF-8 bytes have
   * to be exactly 32 bytes with no encoding step in between.
   *
   * It is asserted over many generated codes rather than one, because it is a
   * property of the generator and not of a single output.
   */
  it('a generated code is exactly 32 UTF-8 bytes', async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { code } = await generateClaimCode();
      expect(Buffer.byteLength(code, 'utf8')).toBe(32);
      expect([...code]).toHaveLength(CLAIM_CODE_LENGTH);
    }
  });

  it('hashes the code bytes, not some other representation of them', async () => {
    const { code, hash } = await generateClaimCode();

    const expected = createHash('sha256').update(Buffer.from(code, 'utf8')).digest('hex');
    expect(hash).toBe(expected);
    // And deliberately not the grouped, human-facing form, which is what an
    // implementation that formatted before hashing would produce.
    expect(hash).not.toBe(
      createHash('sha256').update(formatClaimCode(code), 'utf8').digest('hex'),
    );
  });

  it('only draws from the alphabet, so no character needs escaping', async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { code } = await generateClaimCode();
      expect(isCanonical(code)).toBe(true);
      expect([...code].every((character) => ALPHABET.includes(character))).toBe(true);
    }
  });

  /**
   * Crockford base32 omits I, L, O and U precisely because they are the
   * characters that get misheard across a counter. Generating one would mean the
   * transcription repair below has nothing to repair.
   */
  it('never generates the characters the alphabet omits', async () => {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const { code } = await generateClaimCode();
      seen.add(code);
      expect(code).not.toMatch(/[ILOU]/);
    }
    // A sanity check on the generator: if it were returning a constant, the
    // assertions above would all still pass.
    expect(seen.size).toBeGreaterThan(250);
  });
});

describe('normaliseClaimCode', () => {
  it('uppercases and strips separators', () => {
    expect(normaliseClaimCode('abcd-efgh ijkl')).toBe('ABCDEFGH1JK1');
  });

  /**
   * Only the unambiguous slips are repaired, and the conservative choice is the
   * point: mapping a wrong character onto a *different valid* symbol would turn
   * a typo an agent could diagnose into a hash mismatch it cannot, because the
   * failed hash looks like a code that was simply wrong.
   */
  it('repairs I/L to 1 and O to 0, and nothing else', () => {
    expect(normaliseClaimCode('ILO')).toBe('110');
    // `U` is omitted from the alphabet and is deliberately *not* repaired: it
    // has no unambiguous digital neighbour, so guessing at one would risk
    // turning a typo into a hash mismatch the agent cannot diagnose. It is left
    // to fail the well-formed check instead.
    expect(normaliseClaimCode('U')).toBe('U');
    expect(isCanonical('U')).toBe(false);
  });
});

describe('formatClaimCode', () => {
  it('groups in fours for reading aloud', () => {
    expect(formatClaimCode('0123456789ABCDEFGHJKMNPQRSTVWXYZ')).toBe(
      '0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV-WXYZ',
    );
  });

  it('round-trips: normalising the displayed form recovers the canonical code', async () => {
    const { code, hash } = await generateClaimCode();
    const displayed = formatClaimCode(code);

    expect(normaliseClaimCode(displayed)).toBe(code);
    // The hash of the displayed form, once normalised, is the hash that was
    // committed — which is what makes it safe for an agent to type what they see.
    expect(await hashClaimCode(displayed)).toBe(hash);
  });
});

describe('hashClaimCode', () => {
  it('refuses a code that is not 32 characters', async () => {
    await expect(hashClaimCode('ABC')).rejects.toThrow(/32 characters/);
  });

  it('refuses a code containing a character outside the alphabet', async () => {
    await expect(hashClaimCode('U'.repeat(32))).rejects.toThrow(/outside the alphabet/);
  });

  /**
   * Throwing rather than quietly hashing something else is the important part. A
   * lenient implementation would return a plausible-looking digest for a code no
   * reveal could ever satisfy, and the transfer would be created successfully
   * and be unclaimable forever.
   */
  it('never returns a digest for an input it cannot honour', async () => {
    const results = await Promise.allSettled([
      hashClaimCode(''),
      hashClaimCode('too-short'),
      hashClaimCode('0'.repeat(31)),
      hashClaimCode('0'.repeat(33)),
    ]);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
  });
});

describe('verifyClaimCode', () => {
  it('matches the code that produced the hash', async () => {
    const { code, hash } = await generateClaimCode();
    expect(await verifyClaimCode(code, hash)).toEqual({ status: 'matches' });
  });

  it('matches regardless of case, grouping or stray whitespace', async () => {
    const { code, hash } = await generateClaimCode();
    const asTyped = `${formatClaimCode(code).toLowerCase()} `;
    expect(await verifyClaimCode(asTyped, hash)).toEqual({ status: 'matches' });
  });

  it('reports a malformed entry separately from a mismatch', async () => {
    const { hash } = await generateClaimCode();

    const short = await verifyClaimCode('ABC', hash);
    expect(short.status).toBe('malformed');

    const empty = await verifyClaimCode('', hash);
    expect(empty.status).toBe('malformed');
    if (empty.status === 'malformed') expect(empty.reason).toBe('no code entered');
  });

  /**
   * The malformed/mismatch split exists so the agent app can say "that is too
   * short" instead of "that code is wrong". In front of a customer, those are
   * different sentences, and the second one implies the sender made a mistake
   * they did not.
   */
  it('reports a well-formed but incorrect code as a mismatch', async () => {
    const { code, hash } = await generateClaimCode();
    const wrong = code === '0'.repeat(32) ? '1'.repeat(32) : '0'.repeat(32);

    const result = await verifyClaimCode(wrong, hash);
    expect(result.status).toBe('mismatch');
    if (result.status === 'mismatch') {
      expect(result.expected).toBe(hash);
      expect(result.actual).not.toBe(hash);
    }
  });

  it('is case-insensitive about the expected hash', async () => {
    const { code, hash } = await generateClaimCode();
    expect(await verifyClaimCode(code, hash.toUpperCase())).toEqual({ status: 'matches' });
  });

  /**
   * `verifyClaimCode` is a usability check, not a security boundary — anyone
   * holding the code can compute the same hash, and the contract re-verifies
   * regardless. Recorded as a test so a future reader does not mistake the agent
   * app's pre-check for enforcement.
   */
  it('is not the security boundary: a wrong hash simply fails to match', async () => {
    const { code } = await generateClaimCode();
    const other = await generateClaimCode();
    expect((await verifyClaimCode(code, other.hash)).status).toBe('mismatch');
  });
});

describe('isWellFormedClaimCode', () => {
  it('accepts a normalised generated code and rejects the near misses', async () => {
    const { code } = await generateClaimCode();
    expect(isWellFormedClaimCode(code)).toBe(true);
    expect(isWellFormedClaimCode(formatClaimCode(code))).toBe(true);
    expect(isWellFormedClaimCode(code.slice(0, 31))).toBe(false);
    expect(isWellFormedClaimCode(`${code}0`)).toBe(false);
    expect(isWellFormedClaimCode('U'.repeat(32))).toBe(false);
  });
});
