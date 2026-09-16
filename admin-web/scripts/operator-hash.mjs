#!/usr/bin/env node
import { randomBytes, scryptSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * Generate the `passwordHash` for an `OPERATOR_ACCOUNTS` entry.
 *
 * Plain Node rather than TypeScript, so it runs without a build step or a loader:
 * this is a command someone runs once while setting up a deployment, and it should
 * not be the step that fails because a dev dependency is missing.
 *
 * The format has to match `src/lib/auth/accounts.ts`, and duplication like that
 * drifts. `tests/auth.test.ts` imports this module and asserts that a hash made
 * here verifies there, so a drift is a red build rather than a lockout at 9am.
 *
 *   node scripts/operator-hash.mjs 'correct horse battery staple'
 *   node scripts/operator-hash.mjs 'correct horse battery staple' --json
 */

export const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1 };

const KEY_BYTES = 32;
const SALT_BYTES = 16;

export function hashOperatorPassword(password, options = {}) {
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

function main(argv) {
  const password = argv.find((argument) => !argument.startsWith('--'));
  const asJson = argv.includes('--json');

  if (password === undefined) {
    process.stderr.write(
      "Usage: node scripts/operator-hash.mjs '<password>' [--json]\n" +
        'The password is read from the argument, so it will land in your shell history.\n' +
        'Prefer the --json form and delete the history line afterwards.\n',
    );
    process.exitCode = 1;
    return;
  }

  const passwordHash = hashOperatorPassword(password);

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify({ email: 'operator@example.com', name: 'Operator Name', passwordHash, roles: ['operator'] }, null, 2)}\n`,
    );
    return;
  }
  process.stdout.write(`${passwordHash}\n`);
}

// Only run when invoked directly: this module is also imported by the test that
// keeps `accounts.ts` and this file honest about the hash format.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
