/**
 * Contract-shaped fixtures for the console's end-to-end suite.
 *
 * Two decisions worth stating, because both are the difference between a suite
 * that proves something and one that echoes the app back at itself.
 *
 * The shapes mirror the *backend's* responses, not the console's types. Where the
 * two disagree, this file follows the backend — that is how the suite caught the
 * `/kyc/config` tier-vocabulary mismatch, and it is why the fixtures are not
 * imported from `src/lib/types.ts`, which would make any mismatch invisible.
 *
 * The values are the network configuration the repository actually ships:
 * `scripts/config/testnet.example.json`. Real region and corridor ids, real tier
 * bands, real spreads. A fixture with invented thresholds would exercise the
 * formatters but not the arithmetic an operator is asked to trust.
 *
 * Everything time-relative is built per call, by `buildFixtures()`. Nothing that
 * carries a timestamp is a module-level constant: a run takes a minute or two —
 * the console is built before it is served — and a `capturedAt` frozen at import
 * time would drift from "Snapshot 5m ago" to "6m ago" while the suite ran. That
 * is not a hypothetical; it is the failure this structure exists to prevent.
 */

const SECOND = 1_000;
const DAY = 86_400;

const ago = (seconds) => new Date(Date.now() - seconds * SECOND).toISOString();
const ahead = (seconds) => new Date(Date.now() + seconds * SECOND).toISOString();

/**
 * A 56-character Stellar-shaped address.
 *
 * The filler is drawn from the base32 alphabet (no `0`, `1`, `8`, `9`) so the
 * strings pass the same format checks a real address would, and the readable tail
 * survives `shortId`'s truncation — which is what the assertions match on.
 */
function address(prefix, tail) {
  const filler = 'Q2M7RVXK'.repeat(8).slice(0, 56 - 1 - tail.length);
  return `${prefix}${filler}${tail}`;
}

const AGENT_LAGOS = '11111111-1111-4111-8111-111111111111';
const AGENT_NAIROBI = '22222222-2222-4222-8222-222222222222';
const AGENT_KANO = '33333333-3333-4333-8333-333333333333';

/** The two regions from the shipped deployment config. */
const NG_LAG = {
  id: 'NG_LAG',
  displayName: 'Lagos, Nigeria',
  countryCode: 'NG',
  currency: 'NGN',
  minBond: '5000000000',
  maxAgents: 0,
  active: true,
};

const KE_NBO = {
  id: 'KE_NBO',
  displayName: 'Nairobi, Kenya',
  countryCode: 'KE',
  currency: 'KES',
  minBond: '3000000000',
  maxAgents: 0,
  active: true,
};

const REGIONS = [NG_LAG, KE_NBO];

/** The two corridors from the shipped deployment config, tier bands included. */
const CORRIDORS = [
  {
    id: 'NGN_LAG',
    sourceCurrency: 'USD',
    destCurrency: 'NGN',
    regionId: 'NG_LAG',
    tier1Max: '500000000',
    tier2Max: '5000000000',
    dailyLimit: '15000000000',
    spreadBps: 75,
    active: true,
    region: NG_LAG,
  },
  {
    id: 'KES_NBO',
    sourceCurrency: 'USD',
    destCurrency: 'KES',
    regionId: 'KE_NBO',
    tier1Max: '400000000',
    tier2Max: '4000000000',
    dailyLimit: '12000000000',
    spreadBps: 85,
    active: true,
    region: KE_NBO,
  },
];

/**
 * Three agents covering the three states an operator has to tell apart:
 * healthy and bonded, suspended with slashes, and awaiting authorization.
 */
function buildAgents() {
  return [
    {
      id: AGENT_LAGOS,
      stellarAddress: address('G', 'STELLAR1'),
      settlementAddress: address('G', 'SETTLE01'),
      legalName: 'Ada Okafor Ventures Ltd',
      tradingName: 'Mama Ada Cash Point',
      regionId: 'NG_LAG',
      status: 'AUTHORIZED',
      bondAmount: '5000000000',
      registeredAt: ago(90 * DAY),
      authorizedAt: ago(88 * DAY),
      suspendedAt: null,
      revokedAt: null,
      slashCount: 0,
    },
    {
      // No trading name: the list has to fall back to the legal name rather than
      // render an empty cell.
      id: AGENT_NAIROBI,
      stellarAddress: address('G', 'STELLAR2'),
      settlementAddress: address('G', 'SETTLE02'),
      legalName: 'Nairobi Kiosk Collective',
      tradingName: null,
      regionId: 'KE_NBO',
      status: 'SUSPENDED',
      bondAmount: '3000000000',
      registeredAt: ago(60 * DAY),
      authorizedAt: ago(59 * DAY),
      suspendedAt: ago(3 * DAY),
      revokedAt: null,
      slashCount: 2,
    },
    {
      id: AGENT_KANO,
      stellarAddress: address('G', 'STELLAR3'),
      settlementAddress: address('G', 'SETTLE03'),
      legalName: 'Kano Mobile Money Ltd',
      tradingName: 'Kano MMO',
      regionId: 'NG_LAG',
      status: 'PENDING',
      bondAmount: '4000000000',
      registeredAt: ago(2 * DAY),
      authorizedAt: null,
      suspendedAt: null,
      revokedAt: null,
      slashCount: 0,
    },
  ];
}

/**
 * Agent detail adds the collateral arithmetic.
 *
 * The two agents are chosen to make the interesting case visible: Lagos has
 * headroom, Nairobi is *under*-collateralised, which is the state that means the
 * agent's next draw will be refused by the contract. A console that showed both
 * as fine would be showing an operator a green light for a draw that cannot
 * happen.
 */
function buildAgentDetails(agents) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return {
    [AGENT_LAGOS]: {
      ...byId.get(AGENT_LAGOS),
      totalDrawn: '2000000000',
      collateralRatioBps: 15_000,
      requiredBond: '3000000000',
      region: NG_LAG,
      exposure: [{ id: 'exposure-1', regionId: 'NG_LAG', drawnAmount: '2000000000' }],
    },
    [AGENT_NAIROBI]: {
      ...byId.get(AGENT_NAIROBI),
      totalDrawn: '2400000000',
      collateralRatioBps: 15_000,
      // 150% of 2400 = 3600, against a 3000 bond.
      requiredBond: '3600000000',
      region: KE_NBO,
      exposure: [{ id: 'exposure-2', regionId: 'KE_NBO', drawnAmount: '2400000000' }],
    },
    [AGENT_KANO]: {
      ...byId.get(AGENT_KANO),
      totalDrawn: '0',
      collateralRatioBps: 15_000,
      requiredBond: '0',
      region: NG_LAG,
      exposure: [],
    },
  };
}

/**
 * Regional pool health.
 *
 * Lagos has a real snapshot at 60% utilisation — the amber band the console
 * distinguishes from a comfortable one. Nairobi has *no* snapshot yet, which is
 * the case the UI has to render as "unknown, not zero": the pool is deployed and
 * simply has not been captured, and reporting that as 0% utilised would invite an
 * operator to draw float that may not be there.
 */
function buildPoolHealth() {
  return {
    NG_LAG: {
      region: NG_LAG,
      pool: {
        totalDeposited: '20000000000',
        totalDrawn: '12000000000',
        available: '8000000000',
        utilizationBps: 6_000,
        utilizationCapBps: 8_000,
        capturedAt: ago(300),
        stale: false,
      },
      agentExposureTotal: '2000000000',
    },
    KE_NBO: {
      region: KE_NBO,
      pool: {
        totalDeposited: '0',
        totalDrawn: '0',
        available: '0',
        utilizationBps: 0,
        utilizationCapBps: 7_500,
        capturedAt: null,
        stale: true,
      },
      agentExposureTotal: '0',
    },
  };
}

/** One collateral alert (bad) and one float alert (warn), so both tones appear. */
function buildAlerts() {
  return [
    {
      id: 'alert-1',
      agentId: AGENT_NAIROBI,
      regionId: 'KE_NBO',
      kind: 'COLLATERAL_TIGHT',
      thresholdBps: 15_000,
      observedBps: 12_000,
      status: 'OPEN',
      createdAt: ago(1_800),
      agent: {
        id: AGENT_NAIROBI,
        legalName: 'Nairobi Kiosk Collective',
        tradingName: null,
        regionId: 'KE_NBO',
      },
    },
    {
      id: 'alert-2',
      agentId: AGENT_LAGOS,
      regionId: 'NG_LAG',
      kind: 'FLOAT_LOW',
      thresholdBps: 3_000,
      observedBps: 1_800,
      status: 'OPEN',
      createdAt: ago(600),
      agent: {
        id: AGENT_LAGOS,
        legalName: 'Ada Okafor Ventures Ltd',
        tradingName: 'Mama Ada Cash Point',
        regionId: 'NG_LAG',
      },
    },
  ];
}

/** A pending request awaiting a decision, one approved but unexecuted, one done. */
function buildTopUps() {
  return [
    {
      id: '44444444-4444-4444-8444-444444444444',
      agentId: AGENT_LAGOS,
      regionId: 'NG_LAG',
      amountRequested: '2500000000',
      reason: 'Cash demand above forecast for the holiday week',
      status: 'PENDING',
      requestedBy: 'ops@remitbridge.example',
      approvedBy: null,
      decisionNote: null,
      txHash: null,
      failureReason: null,
      createdAt: ago(600),
      decidedAt: null,
      executedAt: null,
      agent: {
        id: AGENT_LAGOS,
        legalName: 'Ada Okafor Ventures Ltd',
        tradingName: 'Mama Ada Cash Point',
      },
    },
    {
      id: '55555555-5555-4555-8555-555555555555',
      agentId: AGENT_LAGOS,
      regionId: 'NG_LAG',
      amountRequested: '1500000000',
      reason: 'Weekend float replenishment',
      status: 'APPROVED',
      requestedBy: 'ops@remitbridge.example',
      approvedBy: 'operator-console',
      decisionNote: 'Within the region cap',
      txHash: null,
      failureReason: null,
      createdAt: ago(2_400),
      decidedAt: ago(120),
      executedAt: null,
      agent: {
        id: AGENT_LAGOS,
        legalName: 'Ada Okafor Ventures Ltd',
        tradingName: 'Mama Ada Cash Point',
      },
    },
    {
      id: '66666666-6666-4666-8666-666666666666',
      agentId: AGENT_NAIROBI,
      regionId: 'KE_NBO',
      amountRequested: '900000000',
      reason: 'Agent reported a shortfall at the counter',
      status: 'EXECUTED',
      requestedBy: 'ops@remitbridge.example',
      approvedBy: 'operator-console',
      decisionNote: 'Approved against the regional bond',
      txHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      failureReason: null,
      createdAt: ago(5 * DAY),
      decidedAt: ago(5 * DAY),
      executedAt: ago(5 * DAY - 300),
      agent: {
        id: AGENT_NAIROBI,
        legalName: 'Nairobi Kiosk Collective',
        tradingName: null,
      },
    },
  ];
}

/**
 * Attestation references.
 *
 * No payload, no name, no document number: that is the endpoint's contract, and
 * a fixture that carried one would be testing a console that should not exist.
 * The Nairobi row is already past its expiry while still marked ACTIVE, which is
 * the state the compliance page exists to surface.
 */
function buildAttestations() {
  return [
    {
      id: '77777777-7777-4777-8777-777777777777',
      userId: address('G', 'SUBJ0001'),
      tier: 'STANDARD',
      status: 'ACTIVE',
      regionId: 'NG_LAG',
      providerId: 'mock',
      issuedAt: ago(10 * DAY),
      expiresAt: ahead(20 * DAY),
      revokedAt: null,
    },
    {
      id: '88888888-8888-4888-8888-888888888888',
      userId: address('G', 'SUBJ0002'),
      tier: 'ENHANCED',
      status: 'ACTIVE',
      regionId: 'KE_NBO',
      providerId: 'mock',
      issuedAt: ago(40 * DAY),
      expiresAt: ago(3_600),
      revokedAt: null,
    },
  ];
}

/**
 * Transfers.
 *
 * `1042` is the one that matters: pending, past expiry and unclaimed, so it is
 * `refund_expired`'s job to sweep it and nobody has. A gap here is the signal
 * that the refund path is not being watched.
 */
function buildTransfers() {
  return [
    {
      id: '1042',
      corridorId: 'NGN_LAG',
      amount: '750000000',
      fee: '15000000',
      payout: '735000000',
      tokenAddress: address('C', 'TOKEN001'),
      claimHash: 'ab'.repeat(32),
      status: 'PENDING',
      expiry: ago(7_200),
      createdAt: ago(2 * DAY),
      settledAt: null,
      claimedBy: null,
      corridor: { id: 'NGN_LAG', destCurrency: 'NGN' },
      agent: null,
    },
    {
      id: '1043',
      corridorId: 'KES_NBO',
      amount: '1200000000',
      fee: '24000000',
      payout: '1176000000',
      tokenAddress: address('C', 'TOKEN001'),
      claimHash: 'cd'.repeat(32),
      status: 'CLAIMED',
      expiry: ahead(3_600),
      createdAt: ago(4 * 3_600),
      settledAt: ago(2 * 3_600),
      claimedBy: AGENT_NAIROBI,
      corridor: { id: 'KES_NBO', destCurrency: 'KES' },
      agent: {
        id: AGENT_NAIROBI,
        legalName: 'Nairobi Kiosk Collective',
        tradingName: null,
      },
    },
    {
      id: '1044',
      corridorId: 'NGN_LAG',
      amount: '50000000',
      fee: '1000000',
      payout: '49000000',
      tokenAddress: address('C', 'TOKEN001'),
      claimHash: 'ef'.repeat(32),
      status: 'PENDING',
      expiry: ahead(3_600),
      createdAt: ago(3_600),
      settledAt: null,
      claimedBy: null,
      corridor: { id: 'NGN_LAG', destCurrency: 'NGN' },
      agent: null,
    },
  ];
}

/** What the backend is actually wired to. Served by `/readyz`, outside `/api/v1`. */
const READINESS = {
  status: 'ready',
  network: 'testnet',
  networkLabel: 'Stellar Testnet',
  contracts: {
    escrow: address('C', 'ESCROWCA'),
    agentRegistry: address('C', 'REGISTRY'),
    complianceHook: address('C', 'HOOKXXXX'),
    liquidityPool: address('C', 'POOLXXXX'),
  },
  limits: { maxFeeBps: 200 },
  kycProvider: 'mock',
};

/**
 * KYC configuration.
 *
 * `supportedTiers` is the canonical upper-case vocabulary. The provider interface
 * speaks `'None' | 'Standard' | 'Enhanced'`, and an endpoint that returned that
 * verbatim is rejected by the console's schema — this fixture follows the
 * contract, and `backend/tests/kyc-config.test.ts` keeps the endpoint honest.
 */
const KYC_CONFIG = {
  provider: 'mock',
  supportedTiers: ['NONE', 'STANDARD', 'ENHANCED'],
  enhancedDueDiligence: true,
  attestationTtlDays: 365,
  webhookSignatureRequired: false,
};

/** Tier bands as the compliance hook enforces them, per corridor. */
function complianceTiersFor(corridor) {
  return {
    corridorId: corridor.id,
    tiers: [
      {
        tier: 'NONE',
        upTo: corridor.tier1Max,
        description: 'No verification required',
      },
      {
        tier: 'STANDARD',
        upTo: corridor.tier2Max,
        description: 'Government-ID verification required',
      },
      {
        tier: 'ENHANCED',
        upTo: corridor.dailyLimit,
        description: 'Enhanced due diligence: source of funds',
      },
    ],
    dailyLimit: corridor.dailyLimit,
    spreadBps: corridor.spreadBps,
  };
}

/**
 * A fresh dataset, with timestamps relative to now.
 *
 * Called per request rather than once at import: a server that has been up for a
 * couple of minutes must not start answering with "9m ago" where the assertion
 * expects "5m ago".
 */
export function buildFixtures() {
  const agents = buildAgents();
  return {
    regions: REGIONS,
    corridors: CORRIDORS,
    agents,
    agentDetails: buildAgentDetails(agents),
    poolHealth: buildPoolHealth(),
    alerts: buildAlerts(),
    topUps: buildTopUps(),
    attestations: buildAttestations(),
    transfers: buildTransfers(),
    indexer: { lastLedger: 1_234_567, updatedAt: ago(30) },
    readiness: READINESS,
    kycConfig: KYC_CONFIG,
    complianceTiersFor,
  };
}

export { address, ago, ahead };
