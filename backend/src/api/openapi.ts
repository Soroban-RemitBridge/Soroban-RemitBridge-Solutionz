import { COMPLIANCE_ERROR_NAMES } from '../config/constants.js';

/**
 * OpenAPI 3.1 description.
 *
 * Written by hand rather than generated, because the parts a client integrator
 * actually needs — why a transfer was refused, which tier it needs, whether a
 * quote is still valid — are business semantics that a schema generator would
 * flatten into `object`. The document is served from `/openapi.json` so it cannot
 * drift out of sync with the deployment it describes.
 */
export function openApiDocument(): Record<string, unknown> {
  const moneyString = {
    type: 'string',
    pattern: '^\\d+(\\.\\d{1,7})?$',
    description:
      'Decimal amount as a string. Never a JSON number: an i128 stroop amount loses precision as a double, and a rounding error here is a wrong cash payout.',
  } as const;

  const errorResponse = {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string', example: 'COMPLIANCE_REFUSED' },
          message: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
          requestId: { type: 'string' },
        },
      },
    },
  } as const;

  return {
    openapi: '3.1.0',
    info: {
      title: 'RemitBridge API',
      version: '0.1.0',
      license: { name: 'Apache-2.0' },
      description: [
        'Last-mile remittance cash-out network on Stellar/Soroban.',
        '',
        'Two conventions run through every endpoint:',
        '',
        '- **Amounts are decimal strings.** `"125.50"`, never `125.5`. Parsing an',
        '  amount as a JSON number would go through a double before any handler',
        '  sees it.',
        '- **Refusals are specific.** A compliance rejection returns the contract\'s',
        '  own reason (`AttestationMissing`, `DailyLimitExceeded`, ...), not a',
        '  generic failure, because the client routes to a different flow for each.',
        '',
        'Nothing on-chain identifies a person. Recipients never need a wallet.',
      ].join('\n'),
    },
    servers: [{ url: '/api/v1' }],
    tags: [
      { name: 'transfers', description: 'Sender and recipient transfer tracking' },
      { name: 'compliance', description: 'Tiering, verification and attestations' },
      { name: 'agents', description: 'Agent onboarding and float management' },
      { name: 'quoting', description: 'FX quotes and corridor configuration' },
    ],
    paths: {
      '/transfers': {
        get: {
          tags: ['transfers'],
          summary: 'List transfers',
          parameters: [
            { name: 'senderId', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'corridorId', in: 'query', schema: { type: 'string' } },
            { name: 'status', in: 'query', schema: { enum: ['PENDING', 'CLAIMED', 'REFUNDED', 'CANCELLED'] } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          ],
          responses: {
            '200': {
              description: 'Transfers, plus the indexer cursor so a client can distinguish "none" from "not yet indexed"',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/TransferList' } } },
            },
            '400': { $ref: '#/components/responses/ValidationFailed' },
          },
        },
      },
      '/transfers/{id}/status': {
        get: {
          tags: ['transfers'],
          summary: 'Transfer status and event timeline',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Status, with `expired` and `refundable` reported separately from `status`',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/TransferStatus' } } },
            },
            '404': { $ref: '#/components/responses/NotFound' },
          },
        },
      },
      '/transfers/{id}/receipt': {
        get: {
          tags: ['transfers'],
          summary: 'Settlement receipt (no PII, no claim code)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Receipt' } },
        },
      },
      '/transfers/preflight': {
        post: {
          tags: ['transfers'],
          summary: 'What tier and limits apply to an amount',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['corridorId', 'amount'],
                  properties: { corridorId: { type: 'string' }, amount: moneyString },
                },
              },
            },
          },
          responses: { '200': { description: 'Required tier and daily-limit check' } },
        },
      },
      '/quotes': {
        post: {
          tags: ['quoting'],
          summary: 'Create a signed, short-lived FX quote',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['corridorId', 'amount'],
                  properties: { corridorId: { type: 'string' }, amount: moneyString },
                },
              },
            },
          },
          responses: {
            '201': {
              description:
                'Signed quote. `signature` covers every other field, so a client can prove the rate it was shown is the rate the network quoted.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Quote' } } },
            },
            '503': {
              description: 'Rate source unavailable or stale. Refused rather than served: an old rate is a promise the network cannot keep.',
            },
          },
        },
      },
      '/quotes/verify': {
        post: {
          tags: ['quoting'],
          summary: 'Verify a previously issued quote',
          responses: {
            '200': {
              description: '`signatureValid` and `withinValidityWindow` are reported separately: "expired" and "not ours" are different answers.',
            },
          },
        },
      },
      '/corridors': {
        get: { tags: ['quoting'], summary: 'List corridors', responses: { '200': { description: 'Corridors' } } },
      },
      '/corridors/{id}/compliance-tiers': {
        get: {
          tags: ['compliance'],
          summary: 'Tier bands for a corridor',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Tier bands with the requirement each implies' } },
        },
      },
      '/kyc/preflight': {
        post: {
          tags: ['compliance'],
          summary: 'Which verification an amount will require',
          responses: { '200': { description: 'Required tier' } },
        },
      },
      '/kyc/verifications': {
        post: {
          tags: ['compliance'],
          summary: 'Submit a verification; publishes only the resulting hash',
          responses: {
            '201': { description: 'Approved and published on-chain' },
            '202': { description: 'Pending or awaiting further input' },
          },
        },
      },
      '/kyc/webhooks/{providerId}': {
        post: {
          tags: ['compliance'],
          summary: 'Provider callback (HMAC-signed, raw body)',
          responses: {
            '200': { description: 'Accepted. Unknown references also return 200: providers retry on non-2xx and an unknown reference never becomes known.' },
            '401': { description: 'Signature invalid' },
          },
        },
      },
      '/kyc/attestations': {
        get: { tags: ['compliance'], summary: 'Compliance monitoring feed', responses: { '200': { description: 'Attestations' } } },
      },
      '/agents': {
        get: { tags: ['agents'], summary: 'List agents', responses: { '200': { description: 'Agents' } } },
      },
      '/agents/{id}': {
        get: {
          tags: ['agents'],
          summary: 'Agent detail with bond, exposure and required bond',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Agent' }, '404': { $ref: '#/components/responses/NotFound' } },
        },
      },
      '/agents/liquidity/alerts': {
        get: { tags: ['agents'], summary: 'Open float and collateral alerts', responses: { '200': { description: 'Alerts' } } },
      },
      '/agents/liquidity/sweep': {
        post: { tags: ['agents'], summary: 'Run one monitoring sweep', responses: { '200': { description: 'Sweep result' } } },
      },
      '/agents/liquidity/top-ups': {
        post: { tags: ['agents'], summary: 'Propose a float top-up', responses: { '201': { description: 'Request created' } } },
        get: { tags: ['agents'], summary: 'List top-up requests', responses: { '200': { description: 'Requests' } } },
      },
      '/agents/liquidity/top-ups/{id}/decision': {
        post: {
          tags: ['agents'],
          summary: 'Approve or reject a top-up (human decision, separate from execution)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Decided' } },
        },
      },
      '/agents/liquidity/top-ups/{id}/execute': {
        post: {
          tags: ['agents'],
          summary: 'Execute an approved top-up on-chain',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: {
            '200': { description: 'Executed' },
            '503': { description: 'Chain unavailable, or the pool refused the draw' },
          },
        },
      },
      '/liquidity/regions/{regionId}': {
        get: { tags: ['agents'], summary: 'Pool health for a region', responses: { '200': { description: 'Pool snapshot' } } },
      },
    },
    components: {
      schemas: {
        TransferList: {
          type: 'object',
          properties: {
            transfers: { type: 'array', items: { $ref: '#/components/schemas/Transfer' } },
            indexer: { type: 'object', properties: { lastLedger: { type: ['integer', 'null'] }, updatedAt: { type: ['string', 'null'] } } },
          },
        },
        Transfer: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'On-chain transfer id' },
            amount: { type: 'string' },
            fee: { type: 'string' },
            payout: { type: 'string' },
            status: { enum: ['PENDING', 'CLAIMED', 'REFUNDED', 'CANCELLED'] },
            corridorId: { type: 'string' },
            claimHash: { type: 'string', description: 'sha256 of the claim code. The code itself never appears on-chain.' },
            expiry: { type: 'string', format: 'date-time' },
            createdAt: { type: 'string', format: 'date-time' },
            settledAt: { type: ['string', 'null'], format: 'date-time' },
          },
        },
        TransferStatus: {
          allOf: [
            { $ref: '#/components/schemas/Transfer' },
            {
              type: 'object',
              properties: {
                expired: { type: 'boolean', description: 'Past expiry but not yet refunded. Normal, not an error: anyone may trigger the refund.' },
                refundable: { type: 'boolean' },
                timeline: { type: 'array', items: { type: 'object' } },
              },
            },
          ],
        },
        Quote: {
          type: 'object',
          properties: {
            quoteId: { type: 'string', format: 'uuid' },
            corridorId: { type: 'string' },
            midRate: { type: 'string', description: 'Oracle mid-market rate' },
            spreadBps: { type: 'integer' },
            clientRate: { type: 'string' },
            amount: { type: 'string' },
            fee: { type: 'string' },
            total: { type: 'string' },
            oracleSource: { type: 'string', description: 'Rate provenance. `static-config` means no live feed for this corridor.' },
            validUntil: { type: 'string', format: 'date-time' },
            signature: { type: 'string' },
            algorithm: { type: 'string' },
            signingKey: { type: 'string' },
          },
        },
        Error: errorResponse,
      },
      responses: {
        NotFound: {
          description: 'Not found',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        ValidationFailed: {
          description: 'Request failed validation',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        ComplianceRefused: {
          description: [
            'Refused by the compliance gate. The `details.variant` names the contract error:',
            Object.entries(COMPLIANCE_ERROR_NAMES)
              .map(([code, name]) => `- \`${code}\` ${name}`)
              .join('\n'),
            '',
            '403 means the sender is not yet permitted (complete verification); 429 means retrying later works; 503 means the corridor is paused and the sender cannot fix it.',
          ].join('\n'),
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    },
  };
}
