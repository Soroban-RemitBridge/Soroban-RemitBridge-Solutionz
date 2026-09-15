import { describe, expect, it } from 'vitest';

import { __testing } from '../src/lib/endpoints.js';

/**
 * Tests for the console's response boundary.
 *
 * These are not schema-shape tests for their own sake. Each assertion below
 * corresponds to something the console would render *wrong* rather than fail to
 * render: a truncating amount, a status it does not handle, an exposure figure
 * with no provenance. The distinction matters because the failure mode is silent
 * -- an operator sees a plausible number and acts on it.
 */

const region = {
  id: 'NG_LAG',
  displayName: 'Lagos',
  countryCode: 'NG',
  currency: 'NGN',
  minBond: '50000000000',
  maxAgents: 25,
  active: true,
};

const transfer = {
  id: '42',
  corridorId: 'NGN_LAG',
  amount: '1500000000',
  fee: '7500000',
  payout: '1492500000',
  tokenAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  claimHash: 'aa'.repeat(32),
  status: 'PENDING',
  expiry: '2026-09-16T00:00:00.000Z',
  createdAt: '2026-09-15T00:00:00.000Z',
  settledAt: null,
  claimedBy: null,
};

describe('money is a string, and a number is refused', () => {
  /**
   * The backend sends amounts as strings because a JSON number is parsed as a
   * double before validation runs. If the backend regressed and sent a number,
   * a schema that coerced would accept it and the console would display a
   * rounded figure for the largest transfers -- the ones where it matters most.
   * Rejecting produces an "unavailable" panel instead.
   */
  it('rejects a transfer amount sent as a number', () => {
    const result = __testing.transferSchema.safeParse({ ...transfer, amount: 1_500_000_000 });
    expect(result.success).toBe(false);
  });

  it.each(['amount', 'fee', 'payout'] as const)('rejects %s as a number', (field) => {
    const result = __testing.transferSchema.safeParse({ ...transfer, [field]: 123 });
    expect(result.success).toBe(false);
  });

  it('rejects bond and tier amounts sent as numbers', () => {
    expect(
      __testing.regionSchema.safeParse({ ...region, minBond: 50_000_000_000 }).success,
    ).toBe(false);

    expect(
      __testing.corridorSchema.safeParse({
        id: 'NGN_LAG',
        sourceCurrency: 'USD',
        destCurrency: 'NGN',
        regionId: 'NG_LAG',
        tier1Max: 1_000,
        tier2Max: '50000000000',
        dailyLimit: '200000000000',
        spreadBps: 75,
        active: true,
        region,
      }).success,
    ).toBe(false);
  });
});

describe('undeclared fields are stripped, not rendered', () => {
  /**
   * zod strips unknown keys, so a column added to the backend cannot quietly
   * begin appearing in an operator's browser before anyone has decided it should
   * be there. That is the privacy half of the boundary: this console renders
   * compliance data, and the schema is the list of what it is allowed to show.
   */
  it('drops fields the console does not declare', () => {
    const result = __testing.transferSchema.safeParse({
      ...transfer,
      senderName: 'Ada Lovelace',
      senderDocumentNumber: 'A1234567',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data)).not.toContain('senderName');
      expect(Object.keys(result.data)).not.toContain('senderDocumentNumber');
    }
  });
});

describe('an unknown status fails rather than falling through', () => {
  /**
   * A status the console does not know would render as no badge at all, or worse
   * as whatever the default branch happens to be. A transfer sitting in
   * `DISPUTED` must not look like a pending one.
   */
  it('rejects an unrecognised transfer status', () => {
    expect(
      __testing.transferSchema.safeParse({ ...transfer, status: 'DISPUTED' }).success,
    ).toBe(false);
  });

  it('rejects an unrecognised agent status', () => {
    const agent = {
      id: '1',
      stellarAddress: 'G'.padEnd(56, 'A'),
      settlementAddress: 'G'.padEnd(56, 'B'),
      legalName: 'Kiosk Ltd',
      tradingName: null,
      regionId: 'NG_LAG',
      status: 'ON_HOLD',
      bondAmount: '50000000000',
      registeredAt: '2026-09-15T00:00:00.000Z',
      authorizedAt: null,
      suspendedAt: null,
      revokedAt: null,
      slashCount: 0,
    };
    expect(__testing.agentSchema.safeParse(agent).success).toBe(false);
  });
});

describe('pool health carries its own provenance', () => {
  const health = {
    region,
    pool: {
      totalDeposited: '100000000000',
      totalDrawn: '40000000000',
      available: '60000000000',
      utilizationBps: 4_000,
      utilizationCapBps: 7_000,
      capturedAt: '2026-09-15T00:00:00.000Z',
      stale: false,
    },
    agentExposureTotal: '40000000000',
  };

  /**
   * `stale` and `capturedAt` are required, not optional. A pool figure with no
   * provenance is indistinguishable from a fresh one, and an operator approving
   * a float top-up against a stale number is the specific mistake this field
   * exists to prevent. Making it optional would let the backend omit it and the
   * console would render the figure as current.
   */
  it('requires the staleness flag and the capture time', () => {
    const { pool: _pool, ...withoutPool } = health;
    expect(__testing.poolHealthSchema.safeParse(withoutPool).success).toBe(false);

    const { stale: _stale, ...rest } = health.pool;
    expect(
      __testing.poolHealthSchema.safeParse({ ...health, pool: rest }).success,
    ).toBe(false);
  });

  it('accepts a stale snapshot rather than hiding it', () => {
    const result = __testing.poolHealthSchema.safeParse({
      ...health,
      pool: { ...health.pool, stale: true, capturedAt: null },
    });
    expect(result.success).toBe(true);
  });
});

describe('nested records the console renders are required, not assumed', () => {
  it('requires a corridor to carry its region', () => {
    const corridor = {
      id: 'NGN_LAG',
      sourceCurrency: 'USD',
      destCurrency: 'NGN',
      regionId: 'NG_LAG',
      tier1Max: '10000000000',
      tier2Max: '50000000000',
      dailyLimit: '200000000000',
      spreadBps: 75,
      active: true,
    };

    expect(__testing.corridorSchema.safeParse(corridor).success).toBe(false);
    expect(__testing.corridorSchema.safeParse({ ...corridor, region }).success).toBe(true);
  });

  it('accepts a null agent on a transfer, because an unclaimed one has none', () => {
    const result = __testing.transferSchema.safeParse({ ...transfer, agent: null });
    expect(result.success).toBe(true);
  });

  /**
   * `readinessSchema` is what the console shows on the settings panel, and it
   * exists so an operator can see which four contracts the backend is actually
   * wired to. A version that accepted a partial contract map would render three
   * addresses and imply the fourth, which is the exact confusion the panel
   * exists to remove.
   */
  it('requires all four contract addresses in the readiness payload', () => {
    const readiness = {
      status: 'ok',
      network: 'testnet',
      networkLabel: 'Testnet',
      contracts: {
        escrow: 'C…',
        agentRegistry: 'C…',
        complianceHook: 'C…',
      },
      limits: { maxFeeBps: 500 },
      kycProvider: 'mock',
    };

    expect(__testing.readinessSchema.safeParse(readiness).success).toBe(false);
    expect(
      __testing.readinessSchema.safeParse({
        ...readiness,
        contracts: { ...readiness.contracts, liquidityPool: 'C…' },
      }).success,
    ).toBe(true);
  });
});
