import { createServer } from 'node:http';

import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer as createApp } from '../src/api/server.js';

/**
 * Regression tests for request body handling.
 *
 * Both cases here are about middleware *ordering*, which is the kind of defect
 * that cannot be seen by reading a single file: each piece looks right on its
 * own, and the failure only appears when they are composed.
 *
 * The bug this pins down: mounting `express.text()` on the whole `/api/v1`
 * prefix so webhook signature verification could see raw bytes. `express.text`
 * marks the body as consumed, so the JSON parser registered afterwards silently
 * skipped — and every POST in the service received a string where it expected an
 * object. The routes affected have nothing to do with webhooks, so the symptom
 * pointed nowhere near the cause.
 *
 * These assertions deliberately avoid the database. An invalid-but-object body
 * is rejected by validation *before* any query runs, which is exactly what makes
 * it a useful probe: one error message proves the body was parsed, the other
 * proves it was not.
 */

let close: () => Promise<void>;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp();
  const server = createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
});

afterAll(async () => {
  await close();
});

/** True when a validation error names a field rather than complaining about the type. */
function mentionsField(details: unknown, field: string): boolean {
  return JSON.stringify(details).includes(field);
}

describe('request body parsing', () => {
  it('parses a JSON body as an object on a normal POST route', async () => {
    const response = await fetch(`${baseUrl}/api/v1/transfers/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Missing `amount`, so this fails validation — without touching the
      // database, which is what makes the test runnable anywhere.
      body: JSON.stringify({ corridorId: 'NGN_LAG' }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { details?: unknown } };

    // The decisive assertion: the failure must be about the *missing field*.
    // If the body had arrived as a string, the error would instead be
    // "Expected object, received string" and would not name `amount`.
    expect(mentionsField(body.error?.details, 'amount')).toBe(true);
  });

  it('parses a JSON body as an object on a quoting route', async () => {
    const response = await fetch(`${baseUrl}/api/v1/quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ corridorId: 'NGN_LAG' }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error?: { details?: unknown } };
    expect(mentionsField(body.error?.details, 'amount')).toBe(true);
  });

  it('rejects a body that is not JSON as a client error, not a 500', async () => {
    const response = await fetch(`${baseUrl}/api/v1/quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });

    // Malformed input is the client's error. Reporting it as 500 tells the client
    // to retry something that can never succeed, and hides real server faults in
    // a stream of client-input noise.
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('MALFORMED_BODY');

    // The parser's raw message quotes the offending body, and a body here can be
    // a document number. It must not be echoed back.
    expect(JSON.stringify(body)).not.toContain('not json');
  });

  it('serves the liveness probe without touching the database', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });
});
