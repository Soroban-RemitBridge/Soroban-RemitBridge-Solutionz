/**
 * React Native polyfills.
 *
 * Imported for its side effects at the top of the root layout, before anything
 * that touches `@stellar/stellar-sdk`. Two gaps have to be closed for the SDK to
 * run on a device:
 *
 * - `Buffer` does not exist in Hermes. The SDK uses it for XDR and base64.
 * - Hermes has no cryptographically secure `crypto.getRandomValues`, which the
 *   SDK uses for key generation and which *this app* relies on to mint a claim
 *   code. `react-native-get-random-values` installs a native bridge
 *   implementation. Falling back to `Math.random` here would produce guessable
 *   claim codes, so this import is a correctness requirement, not a convenience.
 */

import 'react-native-get-random-values';

import { Buffer } from 'buffer';

/**
 * Widening `globalThis` locally rather than through a global `declare`.
 *
 * A global declaration would collide with `@types/node`'s `Buffer` if those
 * types are ever pulled in by a transitive dependency, and the collision would
 * look like an unrelated type error in a file nobody expects to touch.
 */
type GlobalWithBuffer = typeof globalThis & { Buffer?: typeof Buffer };

const scope = globalThis as GlobalWithBuffer;

if (scope.Buffer === undefined) {
  scope.Buffer = Buffer;
}
