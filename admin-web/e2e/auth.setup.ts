import { expect, test as setup } from '@playwright/test';

import { E2E_ADMIN } from './accounts';

/**
 * Sign in once, for every spec that needs a session.
 *
 * A setup project rather than a `beforeEach` helper, for two reasons: it runs
 * once instead of per test, and it produces a real cookie in a real browser
 * through the real login form. A helper that forged the cookie would prove
 * nothing about the path an operator actually takes.
 *
 * The sign-in flow's own behaviour — the refusal, the redirect, the role checks —
 * is asserted in `auth.spec.ts`, which explicitly runs *without* this state.
 */

export const AUTH_STATE = 'playwright/.auth/operator.json';

setup('sign in as an operator', async ({ page }) => {
  await page.goto('/login');

  await page.getByLabel('Work email').fill(E2E_ADMIN.email);
  await page.getByLabel('Password').fill(E2E_ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // The console's overview, which only renders behind the gate: reaching it is the
  // assertion that the cookie was issued and accepted.
  await expect(page.getByRole('banner')).toContainText(E2E_ADMIN.name);

  await page.context().storageState({ path: AUTH_STATE });
});
