import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * The operator accounts the end-to-end suite runs against.
 *
 * Three accounts, one per role, because the interesting assertions are about what
 * a role *cannot* do: a viewer must be refused when it tries to approve a top-up,
 * and "the button was not rendered" is not the same claim as "the server said no".
 *
 * The password hashes are produced by the real generator script rather than
 * hand-written, so the suite exercises the same code path a deployment does. If the
 * hash format ever drifts from what `lib/auth/accounts.ts` verifies, the sign-in
 * here fails loudly instead of the suite passing against a fixture that no longer
 * matches the app.
 */

export const E2E_PASSWORD = 'e2e-operator-password';

// Resolved from the working directory, which Playwright sets to this project — the
// same convention `webServer.command` uses for `./e2e/stub-backend.mjs`.
// `import.meta.url` would be the tidier spelling, but Playwright transpiles its
// config to CommonJS, where it is a syntax error.
const HASH_SCRIPT = resolve(process.cwd(), 'scripts/operator-hash.mjs');

function hashOf(password: string): string {
  return execFileSync(process.execPath, [HASH_SCRIPT, password], { encoding: 'utf8' }).trim();
}

export const E2E_SESSION_SECRET = 'e2e-operator-session-secret-0123456789abcdef';

/**
 * The account the suite signs in as by default.
 *
 * An admin, so that every mutation surface is reachable and the specs about
 * rendered controls are testing what they name. The narrower roles exist to assert
 * what they *cannot* do, which is the more interesting half.
 */
export const E2E_ADMIN = {
  email: 'admin@remitbridge.example',
  name: 'Ada Admin',
  password: E2E_PASSWORD,
  roles: ['admin'],
} as const;

/** Moves float, but must not be able to publish a compliance revocation. */
export const E2E_OPERATOR = {
  email: 'ops@remitbridge.example',
  name: 'Ops Operator',
  password: E2E_PASSWORD,
  roles: ['operator'],
} as const;

/** Reads everything, mutates nothing. */
export const E2E_VIEWER = {
  email: 'viewer@remitbridge.example',
  name: 'Read Only Reviewer',
  password: E2E_PASSWORD,
  roles: ['viewer'],
} as const;

export const OPERATOR_ACCOUNTS_JSON = JSON.stringify(
  [E2E_ADMIN, E2E_OPERATOR, E2E_VIEWER].map((account) => ({
    email: account.email,
    name: account.name,
    passwordHash: hashOf(account.password),
    roles: [...account.roles],
  })),
);
