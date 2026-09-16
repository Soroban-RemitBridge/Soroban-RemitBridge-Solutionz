import { expect, test } from '@playwright/test';

import { card, recordedRequests, row, setMode, stat } from './harness';

/**
 * What each page renders from a healthy backend.
 *
 * These are not "does the page load" tests — the type layer and the schema suite
 * already cover the parts of this console that can be checked without a browser.
 * What only a browser can prove is the composition: that the value a page shows
 * came from the endpoint it claims, that a filter reached the backend rather than
 * being applied to a cached list, and that the numbers an operator reads are the
 * numbers the contract enforces.
 *
 * Values asserted here come from `e2e/fixtures.mjs`, which in turn uses the region
 * and corridor configuration this repository actually ships.
 */

/** Agent ids as defined in `e2e/fixtures.mjs`. */
const AGENT_NAIROBI = '22222222-2222-4222-8222-222222222222';

test.describe('the console shell', () => {
  test.beforeEach(async ({ request }) => {
    await setMode(request, 'healthy');
  });

  test('labels the deployment it is pointed at, on every page', async ({ page }) => {
    await page.goto('/');

    // The environment chip is not decoration. Signing off a float move against
    // the wrong deployment is unrecoverable, so which one this is has to be on
    // screen without opening a second tab. `e2e` is the label the suite builds
    // with, so this also proves the build-time inlining works: an inlined value
    // that silently falls back to "local" is the failure mode here.
    const header = page.getByRole('banner');
    await expect(header.getByText('env: e2e')).toBeVisible();
    await expect(header.getByText('operator console')).toBeVisible();
  });

  test('marks the section you are in, and only that one', async ({ page }) => {
    await page.goto('/liquidity');

    await expect(page.getByRole('link', { name: 'Liquidity' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('link', { name: 'Compliance' })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('is noindex and frame-denied on every route', async ({ request }) => {
    // The console shows recipient-adjacent and compliance data. These headers are
    // set by `next.config.mjs` and apply to every path, so this asserts the
    // configuration survived contact with the build rather than the header list.
    for (const route of ['/', '/agents', '/liquidity', '/compliance', '/corridors']) {
      const response = await request.get(route);
      expect(response.status(), route).toBe(200);
      expect(response.headers()['x-robots-tag'], route).toBe('noindex, nofollow');
      expect(response.headers()['x-frame-options'], route).toBe('DENY');
    }
  });
});

test.describe('overview', () => {
  test.beforeEach(async ({ request }) => {
    await setMode(request, 'healthy');
  });

  test('leads with what is waiting on a human', async ({ page }) => {
    await page.goto('/');

    await expect(stat(page, 'Open float alerts')).toContainText('2');
    await expect(stat(page, 'Open float alerts')).toContainText('Agents below their float threshold');
    await expect(stat(page, 'Top-ups awaiting approval')).toContainText('1');
    await expect(stat(page, 'Top-ups awaiting approval')).toContainText(
      'Nothing is paid out without a decision',
    );
  });

  test('reports the contract wiring from the readiness probe, not its own config', async ({
    page,
  }) => {
    await page.goto('/');

    const wiring = card(page, 'Contract wiring');
    // Truncated, and the tails are what an operator reconciles against a
    // deployment record. The prefix and suffix are both kept on purpose.
    await expect(wiring).toContainText('…ESCROWCA');
    await expect(wiring).toContainText('…REGISTRY');
    await expect(wiring).toContainText('…HOOKXXXX');
    await expect(wiring).toContainText('…POOLXXXX');
    await expect(wiring).toContainText('Escrow');
    await expect(wiring).toContainText('Liquidity pool');
  });

  test('renders the verification configuration the backend actually reports', async ({ page }) => {
    await page.goto('/');

    // This panel is the regression test for a real defect: the endpoint used to
    // answer with the KYC provider's internal tier spelling ('Standard'), which
    // the console's schema rejects, so the whole card rendered as unavailable.
    const verification = card(page, 'Verification configuration');
    await expect(verification).toContainText('mock');
    await expect(verification.getByText('NONE', { exact: true })).toBeVisible();
    await expect(verification.getByText('STANDARD', { exact: true })).toBeVisible();
    await expect(verification.getByText('ENHANCED', { exact: true })).toBeVisible();
    await expect(verification).toContainText('Source of funds collected');
    await expect(verification).toContainText('365 days');
    await expect(verification).toContainText('unsigned webhooks will be rejected');

    await expect(stat(page, 'Network')).toContainText('Stellar Testnet');
    await expect(stat(page, 'Network')).toContainText('max fee 200 bps');
  });

  test('states what it does not do, rather than implying authority it lacks', async ({ page }) => {
    await page.goto('/');

    const limits = card(page, 'What this console does not do');
    await expect(limits).toContainText('It never shows a claim code');
    await expect(limits).toContainText('It holds no keys');
    await expect(limits).toContainText('It contains no personal data');
  });
});

test.describe('agents', () => {
  test.beforeEach(async ({ request }) => {
    await setMode(request, 'healthy');
  });

  test('lists each agent with the state an operator has to judge it by', async ({ page }) => {
    await page.goto('/agents');

    const table = card(page, 'Registered agents');
    await expect(table).toContainText('3 shown');

    const lagos = row(page, 'Mama Ada Cash Point');
    await expect(lagos).toContainText('AUTHORIZED');
    await expect(lagos).toContainText('500.00');

    // No trading name on this one: the list has to fall back to the legal name
    // rather than render an empty cell.
    const nairobi = row(page, 'Nairobi Kiosk Collective');
    await expect(nairobi).toContainText('SUSPENDED');
    await expect(nairobi).toContainText('300.00');
    await expect(nairobi).toContainText('2');

    await expect(row(page, 'Kano MMO')).toContainText('PENDING');
  });

  test('filters through the backend rather than over a list it already has', async ({
    page,
    request,
  }) => {
    await page.goto('/agents');

    await page.getByRole('link', { name: 'SUSPENDED' }).click();
    await expect(page).toHaveURL(/status=SUSPENDED/);

    // The assertion that matters is on the wire, not the DOM: the filter has to
    // reach the read model, because the read model is what lags the chain.
    const agentReads = (await recordedRequests(request)).filter(
      (entry) => entry.path === '/api/v1/agents',
    );
    expect(agentReads.at(-1)?.query['status']).toBe('SUSPENDED');

    await expect(card(page, 'Registered agents')).toContainText('1 shown');
    await expect(row(page, 'Nairobi Kiosk Collective')).toBeVisible();
    await expect(row(page, 'Mama Ada Cash Point')).toHaveCount(0);
  });

  test('reports on the agent an operator clicked', async ({ page }) => {
    await page.goto('/agents');
    await row(page, 'Mama Ada Cash Point').getByRole('link', { name: 'View' }).click();

    await expect(page).toHaveURL(/agents\/1111/);
    await expect(page.getByRole('heading', { name: 'Mama Ada Cash Point' })).toBeVisible();
    await expect(page.getByText('Lagos, Nigeria')).toBeVisible();
  });

  test('computes bond headroom against the ratio the contract enforces', async ({ page }) => {
    await page.goto('/agents/11111111-1111-4111-8111-111111111111');

    await expect(stat(page, 'Bond posted')).toContainText('500.00');
    await expect(stat(page, 'Float drawn')).toContainText('200.00');
    await expect(stat(page, 'Required for current draw')).toContainText('300.00');
    await expect(stat(page, 'Required for current draw')).toContainText('At 150.00% collateralisation');

    // Headroom, not ratio: the question is whether the *next* draw succeeds.
    await expect(stat(page, 'Bond headroom')).toContainText('200.00');
    await expect(stat(page, 'Bond headroom')).toContainText('Available before the next draw fails');

    const exposure = card(page, 'Exposure by region');
    await expect(exposure).toContainText('NG_LAG');
    await expect(exposure).toContainText('200.00');
  });

  test('shows an under-collateralised agent as a draw that will be refused', async ({ page }) => {
    await page.goto(`/agents/${AGENT_NAIROBI}`);

    // 150% of 2,400 drawn is 3,600 required against a 3,000 bond. A console that
    // showed this as fine would be showing a green light for a draw the contract
    // will reject.
    await expect(stat(page, 'Bond headroom')).toContainText('-60.00');
    await expect(stat(page, 'Bond headroom')).toContainText('The next draw will be refused on-chain');
    await expect(page.getByText('2 slashes')).toBeVisible();
  });
});

test.describe('liquidity', () => {
  test.beforeEach(async ({ request }) => {
    await setMode(request, 'healthy');
  });

  test('scopes pool health to the region you select', async ({ page }) => {
    await page.goto('/liquidity');

    await expect(page.getByRole('link', { name: 'Lagos, Nigeria (NG_LAG)' })).toBeVisible();
    await expect(stat(page, 'Total deposited')).toContainText('2,000.00');
    await expect(stat(page, 'Total drawn')).toContainText('1,200.00');
    await expect(stat(page, 'Available')).toContainText('800.00');
    await expect(stat(page, 'Utilisation')).toContainText('60.00%');
    await expect(stat(page, 'Utilisation')).toContainText('Snapshot 5m ago');
  });

  test('presents an uncaptured pool as unknown, not as empty', async ({ page }) => {
    await page.goto('/liquidity');
    await page.getByRole('link', { name: 'Nairobi, Kenya (KE_NBO)' }).click();

    // Nothing has captured this region's pool yet. Reading that as 0% utilised
    // would invite an operator to draw float that may not be there.
    await expect(stat(page, 'Utilisation')).toContainText(
      'No snapshot captured yet — figures are unknown, not zero',
    );
  });

  test('ranks open alerts by what they actually say', async ({ page }) => {
    await page.goto('/liquidity');

    const alerts = card(page, 'Open float alerts');
    await expect(alerts).toContainText('COLLATERAL_TIGHT');
    await expect(alerts).toContainText('collateral');
    await expect(alerts).toContainText('FLOAT_LOW');
    await expect(alerts).toContainText('float');
    await expect(alerts).toContainText('30.00%');
    await expect(alerts).toContainText('18.00%');
  });

  test('separates the decision from the execution', async ({ page }) => {
    await page.goto('/liquidity');

    const pending = card(page, 'Top-up requests awaiting a decision');
    await expect(pending).toContainText('Mama Ada Cash Point');
    await expect(pending).toContainText('250.00');
    await expect(pending.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect(pending.getByRole('button', { name: 'Reject' })).toBeVisible();

    // Approved is not executed. Nothing is drawn until the machine step runs.
    const approved = card(page, 'Approved, not yet executed');
    await expect(approved).toContainText('150.00');
    await expect(approved).toContainText('ops@remitbridge.example');
    await expect(approved.getByRole('button', { name: 'Execute draw' })).toBeVisible();

    await expect(card(page, 'Recent requests')).toContainText('EXECUTED');
  });
});

test.describe('compliance', () => {
  test.beforeEach(async ({ request }) => {
    await setMode(request, 'healthy');
  });

  test('shows attestation references and nothing behind them', async ({ page }) => {
    await page.goto('/compliance');

    await expect(stat(page, 'Attestations in view')).toContainText('2');
    await expect(stat(page, 'Attestations in view')).toContainText('Status: ACTIVE');

    const feed = card(page, 'Attestation feed');

    // The projection is the assertion. Adding a payload column here would put a
    // document reference in an operator's browser, so the columns are pinned.
    // Lower-cased before comparing: the console renders headers upper-case with
    // CSS, and `innerText` reports what is painted rather than what was written.
    const headers = (await feed.getByRole('columnheader').allInnerTexts()).map((header) =>
      header.toLowerCase(),
    );
    expect(headers).toEqual(['subject', 'tier', 'status', 'provider', 'region', 'issued', 'expires']);

    // And the subject is a truncated reference, not an address you can hand to
    // anyone as an identity.
    await expect(feed.getByRole('cell').first()).toHaveText(/^\w{8}…\w{6}$/);

    await expect(feed.getByText('STANDARD', { exact: true })).toBeVisible();
    await expect(feed.getByText('ENHANCED', { exact: true })).toBeVisible();
    await expect(feed).toContainText('Past expiry — the sweep will mark this EXPIRED');
    await expect(stat(page, 'Past expiry in view')).toContainText('1');
  });

  test('surfaces transfers that are past expiry and unrefunded', async ({ page }) => {
    await page.goto('/compliance');

    // Nobody has to be at fault for this state: the refund is permissionless, so
    // a gap here means nobody is watching rather than anything being broken.
    await expect(stat(page, 'Awaiting refund')).toContainText('1');
    await expect(stat(page, 'Indexer head')).toContainText('1234567');

    const refunds = card(page, 'Transfers past expiry, not yet refunded');
    await expect(refunds).toContainText('#1042');
    await expect(refunds).toContainText('75.00');
    await expect(refunds).toContainText('…abababab');
  });

  test('filters the feed by status', async ({ page }) => {
    await page.goto('/compliance');

    await page.getByRole('link', { name: 'EXPIRED' }).click();

    await expect(page.getByText('No expired attestations')).toBeVisible();
    await expect(page.getByText('The backend answered, so this is a real empty result.')).toBeVisible();
  });

  test('repeats the tier bands a sender was told about', async ({ page }) => {
    await page.goto('/compliance');

    const bands = card(page, 'Tier bands by corridor');
    await expect(bands).toContainText('NGN_LAG');
    await expect(bands).toContainText('USD→NGN');
    await expect(bands).toContainText('50.00');
    await expect(bands).toContainText('1,500.00');
    await expect(bands).toContainText('0.75%');
  });
});

test.describe('corridors', () => {
  test.beforeEach(async ({ request }) => {
    await setMode(request, 'healthy');
  });

  test('summarises the capacity the network is configured for', async ({ page }) => {
    await page.goto('/corridors');

    await expect(stat(page, 'Active corridors')).toContainText('2');
    await expect(stat(page, 'Combined daily limit')).toContainText('2,700.00');
    await expect(stat(page, 'Regions covered')).toContainText('2');

    const config = card(page, 'Corridor configuration');
    await expect(config).toContainText('Lagos, Nigeria');
    await expect(config).toContainText('Nairobi, Kenya');
    await expect(config).toContainText('0.75%');
  });

  test('explains what a sender is asked for, corridor by corridor', async ({ page }) => {
    await page.goto('/corridors');

    // Straight from the endpoint the sender app calls, so this page cannot
    // describe a different policy than the one enforced.
    const asked = card(page, 'What a sender is asked for');
    await expect(asked).toContainText('No verification required');
    await expect(asked).toContainText('Government-ID verification required');
    await expect(asked).toContainText('Enhanced due diligence: source of funds');
    await expect(asked).toContainText('up to 50.00');
  });

  test('is read-only', async ({ page }) => {
    await page.goto('/corridors');

    // Changing a threshold is an admin-gated, key-signing operation. A control
    // for it in a console with no operator authentication would be the highest
    // blast-radius mistake available on this page, so its absence is a feature
    // worth failing a build over.
    await expect(page.locator('main button, main input, main select, main textarea')).toHaveCount(0);
  });
});
