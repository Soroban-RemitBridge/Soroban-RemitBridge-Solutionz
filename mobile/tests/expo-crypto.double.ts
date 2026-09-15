import { createHash, randomBytes } from 'node:crypto';

/**
 * A Node stand-in for `expo-crypto`, wired in through `vitest.config.ts`.
 *
 * `expo-crypto` is a native module: `getRandomBytesAsync` reaches a platform RNG
 * and `digestStringAsync` reaches a platform digest, neither of which exists in
 * a Node test process. Mocking them is not a shortcut around the thing being
 * tested — it is what makes the thing being tested observable.
 *
 * The two functions below are implemented with `node:crypto` so the arithmetic
 * is real. That matters more than it sounds: the property that has to hold is
 * that the *bytes* of the generated code, hashed, equal the hash the contract
 * will verify against. A stub that returned a fixed digest would assert that the
 * code calls a function, not that the result is correct.
 */

export const CryptoDigestAlgorithm = {
  SHA256: 'SHA-256',
} as const;

export async function getRandomBytesAsync(byteCount: number): Promise<Uint8Array> {
  return new Uint8Array(randomBytes(byteCount));
}

export async function digestStringAsync(
  algorithm: string,
  data: string,
): Promise<string> {
  if (algorithm !== CryptoDigestAlgorithm.SHA256) {
    throw new Error(`unsupported test double algorithm: ${algorithm}`);
  }
  // `utf8` explicitly: the contract's `BytesN<32>` reveal is the code's UTF-8
  // bytes, so a double that hashed anything else would be testing a different
  // protocol from the one that ships.
  return createHash('sha256').update(data, 'utf8').digest('hex');
}
