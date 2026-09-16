import { expect, test } from '@playwright/test';

import { E2E_ADMIN } from './accounts';
import { card, lastPost, postCount, setMode } from './harness';

/**
 * Operator actions, end to end.
 *
 * These are the only tests that reach the browser-to-backend path at all: the
 * console's mutations go from a client component through this app's own
 * `/api/backend/*` proxy, so a unit test can cover neither the proxy nor the
 * button that calls it. What is asserted here is what actually left the browser —
 * the recorded request body — alongside what the operator sees afterwards.
 *
 * Two habits are pinned deliberately, because both are the reason a mistake here
 * moves money rather than pixels:
 *
 *   - Nothing is shown as done before the backend agreed. A failed approval must
 *     leave the request sitting in the queue.
 *   - Money is a string on the wire. The moment a screen does arithmetic on it,
 *     the value that arrives has already lost precision.
 */

const AGENT_LAGOS = '11111111-1111-4111-8111-111111111111';
const PENDING_TOP_UP = '44444444-4444-4444-8444-444444444444';
const APPROVED_TOP_UP = '55555555-5555-4555-8555-555555555555';

/** A syntactically valid Stellar account, which is all the form checks. */
const SUBJECT_ADDRESS = 'GDRWDVXFWVPXCFGLZQWKPQTXHMZ7JQGVQKBZTFCJYVLNSVQKZ3MT62';

test.describe('operator decisions', () => {
  test.beforeEach(async ({ request }) => {
    await setMode(request, 'healthy');
  });

  test('an approval reaches the backend with its reason attached', async ({ page, request }) => {
    await page.goto('/liquidity');

    const pending = card(page, 'Top-up requests awaiting a decision');
    const requestRow = pending.getByRole('row', { name: /Mama Ada Cash Point/ });

    await requestRow.getByLabel('Decision note (recorded in the audit log)').fill('Within the region cap');
    await requestRow.getByRole('button', { name: 'Approve' }).click();

    await expect
      .poll(async () => (await lastPost(request, '/decision')) !== undefined)
      .toBe(true);

    const decision = await lastPost(request, `/agents/liquidity/top-ups/${PENDING_TOP_UP}/decision`);
    expect(decision, 'the decision must go to the request it was made about').toBeDefined();
    // `approvedBy` is not sent by the browser at all any more; the proxy writes it
    // from the session, which is why it matches the operator the suite signed in as
    // rather than anything the form could have supplied.
    expect(decision?.body).toMatchObject({
      approved: true,
      approvedBy: E2E_ADMIN.email,
      note: 'Within the region cap',
    });

    // The note is captured before the decision, so it is part of the same request
    // rather than a follow-up nobody makes.
    await expect(card(page, 'Approved, not yet executed')).toContainText('250.00');
    await expect(pending).not.toContainText('250.00');
  });

  test('a rejection is recorded as a decision, not an absence of one', async ({ page, request }) => {
    await page.goto('/liquidity');

    const pending = card(page, 'Top-up requests awaiting a decision');
    const requestRow = pending.getByRole('row', { name: /Mama Ada Cash Point/ });

    await requestRow.getByLabel('Decision note (recorded in the audit log)').fill('Cash forecast revised down');
    await requestRow.getByRole('button', { name: 'Reject' }).click();

    await expect
      .poll(async () => (await lastPost(request, '/decision')) !== undefined)
      .toBe(true);

    const decision = await lastPost(request, '/decision');
    expect(decision?.body).toMatchObject({ approved: false, note: 'Cash forecast revised down' });

    // A rejected request is not an approved one, and must not land in the
    // execution queue.
    await expect(pending).not.toContainText('Mama Ada Cash Point');
    await expect(card(page, 'Approved, not yet executed')).not.toContainText('250.00');
  });

  test('a refused approval is surfaced and nothing is optimistically applied', async ({
    page,
    request,
  }) => {
    await page.goto('/liquidity');

    const pending = card(page, 'Top-up requests awaiting a decision');
    const requestRow = pending.getByRole('row', { name: /Mama Ada Cash Point/ });

    // The backend goes away *after* the page has loaded, which is the case that
    // matters: the operator is mid-decision when it happens.
    await setMode(request, 'down');
    await requestRow.getByRole('button', { name: 'Approve' }).click();

    await expect(requestRow.getByRole('status')).toContainText('The read model is unreachable.');

    // Showing this as approved would be a lie with a settlement transaction
    // attached, so the queue must still be exactly what it was.
    await expect(pending).toContainText('Mama Ada Cash Point');
    await expect(pending).toContainText('250.00');
  });

  test('executing an approved draw clears it out of the approval queue', async ({ page, request }) => {
    await page.goto('/liquidity');

    const approved = card(page, 'Approved, not yet executed');
    await approved.getByRole('button', { name: 'Execute draw' }).click();

    await expect
      .poll(async () => (await lastPost(request, '/execute')) !== undefined)
      .toBe(true);

    const execution = await lastPost(request, '/execute');
    expect(execution?.path).toContain(APPROVED_TOP_UP);

    await expect(card(page, 'Approved, not yet executed')).toHaveCount(0);
    // And the transaction hash is now shown against the request, so the row is
    // reconcilable against the chain.
    await expect(card(page, 'Recent requests')).toContainText('f0e1d2c3');
  });

  test('a sweep reports what it did', async ({ page, request }) => {
    await page.goto(`/agents/${AGENT_LAGOS}`);

    await page.getByRole('button', { name: 'Run liquidity sweep' }).click();

    await expect
      .poll(async () => (await lastPost(request, '/agents/liquidity/sweep')) !== undefined)
      .toBe(true);

    const sweep = await lastPost(request, '/agents/liquidity/sweep');
    expect(sweep?.body).toEqual({ regionId: 'NG_LAG' });
    await expect(page.getByRole('status')).toHaveText('Done.');
  });
});

test.describe('proposing a float top-up', () => {
  test.beforeEach(async ({ request }) => {
    await setMode(request, 'healthy');
  });

  test('sends the amount as a string, never as a number', async ({ page, request }) => {
    await page.goto(`/agents/${AGENT_LAGOS}`);

    await page.getByLabel('Amount').fill('2500.00');
    await page.getByLabel('Reason').fill('Cash demand above forecast');
    await page.getByRole('button', { name: 'Submit request' }).click();

    await expect
      .poll(async () => (await lastPost(request, '/agents/liquidity/top-ups')) !== undefined)
      .toBe(true);

    const proposal = await lastPost(request, '/agents/liquidity/top-ups');
    expect(proposal?.body).toMatchObject({
      agentId: AGENT_LAGOS,
      regionId: 'NG_LAG',
      reason: 'Cash demand above forecast',
      requestedBy: E2E_ADMIN.email,
    });

    // The decisive assertion in this file. `2500` would be a double by the time
    // the backend saw it, and the precision is gone before anything can validate
    // it — which is why every monetary field on this wire is a string.
    const body = proposal?.body as { amount?: unknown };
    expect(typeof body.amount).toBe('string');
    expect(body.amount).toBe('2500.00');

    await expect(page.getByRole('status')).toHaveText('Done.');
  });

  test('will not submit an amount it cannot represent exactly', async ({ page }) => {
    await page.goto(`/agents/${AGENT_LAGOS}`);

    await page.getByLabel('Reason').fill('Cash demand above forecast');

    // Too many decimal places to be a whole number of stroops.
    await page.getByLabel('Amount').fill('2500.12345678');
    await expect(page.getByRole('button', { name: 'Submit request' })).toBeDisabled();

    await page.getByLabel('Amount').fill('2500.1234567');
    await expect(page.getByRole('button', { name: 'Submit request' })).toBeEnabled();
  });

  test('will not submit without a reason', async ({ page }) => {
    await page.goto(`/agents/${AGENT_LAGOS}`);

    await page.getByLabel('Amount').fill('2500.00');
    await expect(page.getByRole('button', { name: 'Submit request' })).toBeDisabled();

    // Too short to be a reason an auditor can use.
    await page.getByLabel('Reason').fill('ok');
    await expect(page.getByRole('button', { name: 'Submit request' })).toBeDisabled();

    await page.getByLabel('Reason').fill('Cash demand above forecast');
    await expect(page.getByRole('button', { name: 'Submit request' })).toBeEnabled();
  });
});

test.describe('revoking attestations', () => {
  test.beforeEach(async ({ request }) => {
    await setMode(request, 'healthy');
  });

  test('publishes nothing until the confirmation is accepted', async ({ page, request }) => {
    await page.goto('/compliance');

    await page.getByLabel('Subject address').fill(SUBJECT_ADDRESS);
    await page.getByLabel('Reason').fill('sanctions_match');
    const revoke = page.getByRole('button', { name: 'Revoke attestations' });

    // Dismissed: a revocation is published on-chain and the console cannot undo
    // it, so the confirmation is the last thing standing between a mis-click and
    // a customer being unable to send.
    page.once('dialog', (dialog) => void dialog.dismiss());
    await revoke.click();
    await expect.poll(() => postCount(request, '/kyc/revocations')).toBe(0);

    page.once('dialog', (dialog) => void dialog.accept());
    await revoke.click();
    await expect.poll(() => postCount(request, '/kyc/revocations')).toBe(1);

    const revocation = await lastPost(request, '/kyc/revocations');
    expect(revocation?.body).toMatchObject({
      subjectAddress: SUBJECT_ADDRESS,
      reason: 'sanctions_match',
    });
  });

  test('requires a well-formed subject address and a reason', async ({ page }) => {
    await page.goto('/compliance');

    const revoke = page.getByRole('button', { name: 'Revoke attestations' });
    await expect(revoke).toBeDisabled();

    await page.getByLabel('Subject address').fill('not-an-address');
    await page.getByLabel('Reason').fill('sanctions_match');
    await expect(revoke).toBeDisabled();

    await page.getByLabel('Subject address').fill(SUBJECT_ADDRESS);
    await expect(revoke).toBeEnabled();
  });

  test('never renders a subject address in full', async ({ page }) => {
    await page.goto('/compliance');

    // A subject address is an identity, and the console's contract is to show a
    // reference to one. Truncated is the whole point: the operator can reconcile
    // it against a record without the screen becoming a directory.
    const subjects = await card(page, 'Attestation feed')
      .locator('tbody tr td:first-child')
      .allInnerTexts();

    expect(subjects.length).toBeGreaterThan(0);
    for (const subject of subjects) {
      expect(subject).not.toBe(SUBJECT_ADDRESS);
      expect(subject).toMatch(/^\w{8}…\w{6}$/);
    }
  });
});
