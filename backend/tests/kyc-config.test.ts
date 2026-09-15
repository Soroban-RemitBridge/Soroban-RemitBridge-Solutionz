import { createServer } from 'node:http';

import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer as createApp } from '../src/api/server.js';

/**
 * Regression tests for the KYC configuration endpoint.
 *
 * The bug this pins down: the provider interface describes its tiers in the
 * vendor's spelling — `'None' | 'Standard' | 'Enhanced'` — and the endpoint
 * returned that array verbatim. Every other representation of a tier in this
 * codebase uses the canonical upper-case form: the Prisma `KycTier` enum, the
 * attestation records, the compliance hook's tier bands, and the operator
 * console's response schema. So `/kyc/config` was the one endpoint whose
 * vocabulary matched nothing else, and the only consumer that validates its
 * responses — the console — rejected the whole payload as malformed and rendered
 * "KYC configuration unavailable" instead of the tiers.
 *
 * Two vocabularies for one concept is the defect; this asserts the endpoint
 * speaks the one every other part of the system reads.
 *
 * The route touches no database, so this runs anywhere, like the body-parsing
 * suite.
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

interface KycConfigBody {
  provider?: string;
  supportedTiers?: string[];
  enhancedDueDiligence?: boolean;
  attestationTtlDays?: number;
  webhookSignatureRequired?: boolean;
}

describe('GET /api/v1/kyc/config', () => {
  it('reports supported tiers in the canonical vocabulary', async () => {
    const response = await fetch(`${baseUrl}/api/v1/kyc/config`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as KycConfigBody;

    // The decisive assertion. A `'Standard'` here is a payload no console
    // schema and no comparison against a corridor's required tier can match.
    expect(body.supportedTiers).toEqual(['NONE', 'STANDARD', 'ENHANCED']);
  });

  it('uses tier names that the rest of the system can act on', async () => {
    const response = await fetch(`${baseUrl}/api/v1/kyc/config`);
    const body = (await response.json()) as KycConfigBody;

    // Compared against the same values the attestation feed returns, rather than
    // against a literal repeated from the endpoint: the point is that the two
    // agree, so a rename on one side has to be a deliberate decision.
    const canonical = new Set(['NONE', 'STANDARD', 'ENHANCED']);
    for (const tier of body.supportedTiers ?? []) {
      expect(canonical.has(tier)).toBe(true);
    }

    expect(body.provider).toBe('mock');
    expect(body.enhancedDueDiligence).toBe(true);
    expect(typeof body.attestationTtlDays).toBe('number');
    // No webhook secret in the test environment, so signature checking is off —
    // and the response has to say so, because a console that assumed otherwise
    // would tell an operator that unsigned webhooks are rejected when they are not.
    expect(body.webhookSignatureRequired).toBe(false);
  });
});
