import { expect, test } from '@playwright/test';

import { card, setMode, stat } from './harness';

/**
 * How the console behaves when it cannot trust an answer.
 *
 * This file is the browser half of a claim the schema suite makes on its own: the
 * console's correctness is mostly a matter of what it *refuses* to render. The
 * schema tests prove a payload is rejected; only a render proves what an operator
 * then sees. Three states have to stay apart, and none of them may look like the
 * others:
 *
 *   empty      the backend answered, and the answer is "nothing"
 *   unavailable   the backend did not answer
 *   malformed  the backend answered something the contract does not allow
 *
 * The last one is the dangerous one. A number where money should be is not a
 * cosmetic defect — it is a value that lost its precision before any validation
 * could run — and the honest response is to show nothing, loudly.
 */

const ERROR_STATE_EXPLANATION =
  'This panel is showing nothing rather than a default value: an unknown figure must not read as a real one.';

test.describe('when the backend is not there', () => {
  test.beforeEach(async ({ request }) => {
    await setMode(request, 'down');
  });

  test('the overview reports unknown figures rather than zero', async ({ page }) => {
    await page.goto('/');

    // A confident 0 would read as "no agents need float", which is the opposite
    // of "we could not ask".
    await expect(stat(page, 'Open float alerts')).toContainText('—');
    await expect(stat(page, 'Open float alerts')).toContainText('Alerts endpoint unreachable');
    await expect(stat(page, 'Top-ups awaiting approval')).toContainText('—');
    await expect(stat(page, 'Top-ups awaiting approval')).toContainText(
      'Top-up endpoint unreachable',
    );

    await expect(card(page, 'Contract wiring')).toContainText('Contract wiring unavailable');
    await expect(card(page, 'Verification configuration')).toContainText(
      'KYC configuration unavailable',
    );
  });

  test('a failed read is not rendered as an empty list', async ({ page }) => {
    await page.goto('/agents');

    await expect(page.getByText('Could not load agents')).toBeVisible();
    await expect(page.getByText(ERROR_STATE_EXPLANATION)).toBeVisible();

    // And the count is not reported as a number we do not have.
    await expect(page.getByText('Count unavailable')).toBeVisible();
    await expect(page.getByText('No agents match this filter')).toHaveCount(0);
  });

  test('names the reason the backend gave, when it gave one', async ({ page }) => {
    await page.goto('/agents');

    // The envelope is parsed leniently: a proxy or a platform error page can put
    // anything in front of the API, and a generic message is better than none.
    await expect(page.getByText('The read model is unreachable.')).toBeVisible();
  });
});

test.describe('when the backend answers with the wrong shape', () => {
  test.beforeEach(async ({ request }) => {
    await setMode(request, 'malformed');
  });

  test('money that arrives as a number is refused, not rendered', async ({ page }) => {
    await page.goto('/agents');

    await expect(page.getByText('Could not load agents')).toBeVisible();
    await expect(page.getByText(ERROR_STATE_EXPLANATION)).toBeVisible();

    // The specific defect: a bond of `500` rather than `"5000000000"`. It must
    // not appear as a bond figure at all, and no table is drawn to imply the
    // other fields were trusted.
    await expect(page.getByText('500.00')).toHaveCount(0);
    await expect(page.locator('main table')).toHaveCount(0);
  });

  test('a status the console does not know is refused, not badged', async ({ page }) => {
    await page.goto('/compliance');

    // An unrecognised tier would otherwise render as a neutral badge, telling an
    // operator "nothing unusual" about a subject they cannot rank.
    const feed = card(page, 'Attestation feed');
    await expect(feed).toContainText('Could not load attestations');
    await expect(feed).toContainText(ERROR_STATE_EXPLANATION);
    await expect(feed.getByRole('cell')).toHaveCount(0);
  });

  test('an alert kind the console does not know is refused too', async ({ page }) => {
    await page.goto('/liquidity');

    const alerts = card(page, 'Open float alerts');
    await expect(alerts).toContainText('Could not load alerts');
    await expect(alerts).toContainText(ERROR_STATE_EXPLANATION);
  });
});

test.describe('when the deployment is genuinely empty', () => {
  test.beforeEach(async ({ request }) => {
    await setMode(request, 'empty');
  });

  test('an empty result is presented as a real answer', async ({ page }) => {
    await page.goto('/agents');

    await expect(page.getByText('No agents match this filter')).toBeVisible();
    await expect(
      page.getByText('An empty list here is a real answer: the registry has nothing to show for it.'),
    ).toBeVisible();

    // The contrast this whole file exists for: nothing failed, so the failure
    // panel must be absent.
    await expect(page.getByText(ERROR_STATE_EXPLANATION)).toHaveCount(0);
    await expect(page.getByText('Could not load agents')).toHaveCount(0);
  });

  test('states that the empty answer came from the backend', async ({ page }) => {
    await page.goto('/compliance');

    await expect(page.getByText('No active attestations')).toBeVisible();
    await expect(page.getByText('The backend answered, so this is a real empty result.')).toBeVisible();
    await expect(page.getByText('Nothing is waiting on a refund')).toBeVisible();
    await expect(page.getByText(ERROR_STATE_EXPLANATION)).toHaveCount(0);
  });

  test('still renders the page rather than collapsing it', async ({ page }) => {
    await page.goto('/liquidity');

    // No regions are configured yet, so there is no pool to scope to. That is a
    // configuration state, not a failure, and the page says which.
    await expect(page.getByText('No regions configured')).toBeVisible();
    await expect(page.getByText('No open float alerts')).toBeVisible();
    await expect(page.getByText('Nothing is waiting for approval')).toBeVisible();

    await page.goto('/corridors');
    await expect(page.getByText('No corridors configured')).toBeVisible();
  });
});
