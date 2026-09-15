import type { APIRequestContext, Locator, Page } from '@playwright/test';

/**
 * Helpers shared by the console's end-to-end specs.
 *
 * Two families. The first drives the stub backend's control plane, which is how a
 * test chooses what the page should render — including the failure modes the
 * console exists to tell apart. The second locates the console's own regions, so
 * an assertion names a panel rather than a `div` index.
 */

export const STUB_URL = process.env['STUB_URL'] ?? 'http://127.0.0.1:4010';

export type StubMode = 'healthy' | 'down' | 'malformed' | 'empty';

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

/**
 * Put the stub in a known state.
 *
 * `reset` is not optional: it clears the recorded requests and restores the
 * mutable top-up queue, so a decision made in one test cannot be read back as the
 * starting state of the next. Without it the suite would only be reliable in the
 * order it happened to run.
 */
export async function setMode(request: APIRequestContext, mode: StubMode): Promise<void> {
  const response = await request.post(`${STUB_URL}/__control`, { data: { mode, reset: true } });
  if (!response.ok()) {
    throw new Error(`could not set the stub to "${mode}": HTTP ${response.status()}`);
  }
}

/** Everything the console asked the backend for, in order. */
export async function recordedRequests(request: APIRequestContext): Promise<RecordedRequest[]> {
  const response = await request.get(`${STUB_URL}/__control`);
  const payload = (await response.json()) as { requests: RecordedRequest[] };
  return payload.requests;
}

/**
 * The last state-changing request the console sent to a given path.
 *
 * Asserting on this is how the suite checks what left the browser — the body that
 * carried an operator's decision, or the absence of a request after a confirmation
 * was dismissed. Both are invisible from the rendered page alone.
 */
export async function lastPost(
  request: APIRequestContext,
  pathSuffix: string,
): Promise<RecordedRequest | undefined> {
  const requests = await recordedRequests(request);
  return requests
    .filter((entry) => entry.method === 'POST' && entry.path.endsWith(pathSuffix))
    .at(-1);
}

export async function postCount(
  request: APIRequestContext,
  pathSuffix: string,
): Promise<number> {
  const requests = await recordedRequests(request);
  return requests.filter((entry) => entry.method === 'POST' && entry.path.endsWith(pathSuffix)).length;
}

/** The card whose heading is `title`. Cards render as `section` with an `h2`. */
export function card(page: Page, title: string): Locator {
  return page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

/** A `StatCard`, addressed by the label above its figure. */
export function stat(page: Page, label: string): Locator {
  return page.getByText(label, { exact: true }).locator('..');
}

/** The table row carrying `text`, for assertions scoped to one record. */
export function row(page: Page, text: string): Locator {
  return page.getByRole('row').filter({ hasText: text });
}
