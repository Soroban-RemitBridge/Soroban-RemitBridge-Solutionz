import { expect, test } from '@playwright/test';

import { E2E_ADMIN, E2E_OPERATOR, E2E_VIEWER } from './accounts';
import { lastPost, setMode } from './harness';

/**
 * The gate, in a browser.
 *
 * This is the file that proves the console is actually protected, as opposed to
 * having the code for it. The unit suite covers signatures, expiry and the role
 * table; only a real request can show that the proxy refuses one.
 *
 * It runs **without** the signed-in state the other specs share, and signs in
 * through the form where it needs a session — so the login path is exercised rather
 * than assumed.
 */

test.describe('without a session', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('sends a visitor to the sign-in page, remembering where they were going', async ({ page }) => {
    await page.goto('/liquidity');

    // `next` is what makes the interruption recoverable: an operator who followed a
    // link to the page they wanted lands on it after signing in.
    await expect(page).toHaveURL(/\/login\?next=%2Fliquidity/);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

    // The console chrome is not rendered for a visitor — no navigation to click,
    // and no environment chip describing the deployment to an unauthenticated
    // browser.
    await expect(page.getByRole('banner')).toHaveCount(0);
  });

  test('refuses a read without a session', async ({ request }) => {
    // The panels read server-side, so this is the request that matters: the page
    // components never see it if this returns 401.
    const response = await request.get('/api/backend/agents?limit=1');
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  test('refuses a mutation without a session', async ({ request }) => {
    const response = await request.post('/api/backend/agents/liquidity/top-ups', {
      data: { agentId: 'x', regionId: 'NG_LAG', amount: '10', reason: 'testing' },
    });
    expect(response.status()).toBe(401);
  });

  test('does not sign anyone in with a wrong password', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Work email').fill(E2E_OPERATOR.email);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // The message is the same one an unknown email gets, so the form cannot be
    // used to discover who has an account. Scoped to the form because Next renders
    // its own route announcer with `role="alert"`.
    await expect(page.locator('form').getByRole('alert')).toHaveText(
      'Email or password is incorrect.',
    );
    await expect(page).toHaveURL(/\/login/);
  });

  test('gives an unknown email the same answer as a wrong password', async ({ request }) => {
    const unknown = await request.post('/api/auth/login', {
      data: { email: 'nobody@example.com', password: 'whatever' },
    });
    const wrongPassword = await request.post('/api/auth/login', {
      data: { email: E2E_OPERATOR.email, password: 'whatever' },
    });

    expect(unknown.status()).toBe(401);
    expect(wrongPassword.status()).toBe(401);
    expect(await unknown.json()).toEqual(await wrongPassword.json());
  });

  test('will not bounce a visitor to another site after signing in', async ({ page }) => {
    await page.goto('/login?next=https%3A%2F%2Fevil.example%2Flogin');

    await page.getByLabel('Work email').fill(E2E_VIEWER.email);
    await page.getByLabel('Password').fill(E2E_VIEWER.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Landing on the console's own overview rather than the absolute URL the query
    // parameter asked for. An accepted `next` here is a phishing vector.
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('banner')).toContainText('RemitBridge');
  });
});

// This block uses the shared signed-in state, which `auth.setup.ts` creates by
// signing in as the admin account — the widest role, so that the specs about what
// is reachable are not silently narrowed by the fixture.
test.describe('with a session', () => {
  test.beforeEach(async ({ request }) => {
    await setMode(request, 'healthy');
  });

  test('names the signed-in operator and their roles in the console', async ({ page }) => {
    await page.goto('/');

    const identity = page.getByTestId('operator-identity');
    await expect(identity).toContainText(E2E_ADMIN.name);
    await expect(identity).toContainText(E2E_ADMIN.email);
    await expect(identity).toContainText('admin');
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('signs out for real: the next request is refused', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign out' }).click();

    await expect(page).toHaveURL(/\/login/);

    // Not just a client-side route change: the cookie is gone, so a fresh
    // navigation to a protected page is redirected again.
    await page.goto('/agents');
    await expect(page).toHaveURL(/\/login\?next=%2Fagents/);
  });

  test('records the session operator as the actor, not the browser', async ({ request }) => {
    // The property the proxy exists for. The body claims somebody else did this;
    // the backend must be told it was the signed-in operator.
    const response = await request.post('/api/backend/agents/liquidity/top-ups', {
      data: {
        agentId: '11111111-1111-4111-8111-111111111111',
        regionId: 'NG_LAG',
        amount: '2500.00',
        reason: 'attribution check',
        requestedBy: 'someone-else@example.com',
        approvedBy: 'someone-else@example.com',
      },
    });
    expect(response.ok()).toBe(true);

    const recorded = await lastPost(request, '/agents/liquidity/top-ups');
    const body = recorded?.body as Record<string, unknown>;
    expect(body['requestedBy']).toBe(E2E_ADMIN.email);
    // The field the route does not use is removed rather than passed through.
    expect(body['approvedBy']).toBeUndefined();
  });

  test('refuses an action that has no authorisation policy', async ({ request }) => {
    // Fails closed: a route added to the proxy without a policy is refused rather
    // than forwarded on the strength of a valid session.
    const response = await request.post('/api/backend/agents/some-agent/revoke', {
      data: { reason: 'testing' },
    });
    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });
});

test.describe('a read-only operator', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ page, request }) => {
    await setMode(request, 'healthy');
    await page.goto('/login');
    await page.getByLabel('Work email').fill(E2E_VIEWER.email);
    await page.getByLabel('Password').fill(E2E_VIEWER.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('banner')).toContainText(E2E_VIEWER.name);
  });

  test('can read the console', async ({ page }) => {
    await page.goto('/liquidity');
    await expect(page.getByRole('heading', { name: 'Liquidity' })).toBeVisible();
  });

  test('is refused by the server when it approves a top-up', async ({ page }) => {
    // The button is hidden, but that is an affordance, not a control. This is the
    // assertion that matters: the server refuses it even when asked directly.
    await page.goto('/liquidity');
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);

    // `page.request` rather than the `request` fixture: the sign-in above put the
    // session cookie in the browser context, and the browser context's request
    // client is the one that shares its cookie jar. Asking with the standalone
    // fixture would test an unauthenticated request and pass for the wrong reason.
    const response = await page.request.post(
      '/api/backend/agents/liquidity/top-ups/44444444-4444-4444-8444-444444444444/decision',
      { data: { approved: true } },
    );
    expect(response.status()).toBe(403);

    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/liquidity:decide/);
  });
});
