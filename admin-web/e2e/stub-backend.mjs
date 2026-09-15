/**
 * A stub backend for the console's end-to-end suite.
 *
 * Why a stub rather than the real API: the console reads server-side, so the
 * browser never issues the requests a Playwright route handler could intercept.
 * To exercise a page's data path at all, something has to answer the Next server,
 * and standing up Postgres plus a Soroban node for a UI suite would make the suite
 * slow, flaky and unrunnable on a laptop. So this speaks the backend's HTTP
 * contract from fixtures.
 *
 * What that costs, stated plainly: this proves the console against a *model* of
 * the backend, not against the backend. The model is only as good as
 * `e2e/fixtures.mjs`, which is why that file follows the backend's response
 * shapes rather than the console's types, and why the one place the two genuinely
 * disagreed — the tier vocabulary of `/kyc/config` — is now pinned by a test on
 * the real route in `backend/tests/kyc-config.test.ts`. Anything about real
 * persistence, real contract calls or the indexer remains unproven here, as the
 * README's verification table says.
 *
 * `POST /__control` switches the failure mode a page should render:
 *
 *   healthy    everything answers (default)
 *   down       every read is a 503 — the backend is not there
 *   malformed  responses arrive *wrong*: money as a JSON number, an unknown enum
 *   empty      every collection is legitimately empty
 *
 * The distinction between the last two is the point. `empty` and `malformed` must
 * not look the same on a compliance screen, and only a real page render can prove
 * they don't.
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

import { buildFixtures } from './fixtures.mjs';

const PORT = Number(process.env['STUB_PORT'] ?? 4010);
const HOST = '127.0.0.1';

const MODES = new Set(['healthy', 'down', 'malformed', 'empty']);

let mode = 'healthy';

/** Every request the console made, so a test can assert on what left the browser. */
let recorded = [];

/** Mutable: a decision or an execution has to be visible on the next page load. */
let topUps = buildFixtures().topUps;

function reset() {
  mode = 'healthy';
  recorded = [];
  topUps = buildFixtures().topUps;
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

/** Mirrors the backend's error envelope, so the console's parsing path is real. */
function failure(response, status, code, message) {
  json(response, status, { error: { code, message } });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return {};
  return JSON.parse(text);
}

/**
 * Decimal string → stroops, without ever touching a float.
 *
 * The console sends `"2500.00"`; the wire contract carries stroops as a string.
 * Reproducing that conversion here is what lets the suite assert that the browser
 * sent a *string* — the moment one of these screens does arithmetic on money, the
 * number that arrives stops being exact.
 */
function toStroops(value) {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(String(value));
  if (match === null) return null;
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  return `${whole}${fraction.padEnd(7, '0')}`.replace(/^0+(?=\d)/, '');
}

function findTopUp(id) {
  return topUps.find((request) => request.id === id);
}

/** The collections an `empty` deployment would answer with. */
function handleEmptyRead(pathname, response, fixtures) {
  switch (pathname) {
    case '/api/v1/agents':
      return json(response, 200, { agents: [] });
    case '/api/v1/agents/liquidity/alerts':
      return json(response, 200, { alerts: [] });
    case '/api/v1/agents/liquidity/top-ups':
      return json(response, 200, { requests: [] });
    case '/api/v1/kyc/attestations':
      return json(response, 200, { attestations: [], expiresSweepable: 0 });
    case '/api/v1/transfers':
      return json(response, 200, { transfers: [], indexer: { lastLedger: null, updatedAt: null } });
    case '/api/v1/corridors':
      return json(response, 200, { corridors: [] });
    case '/readyz':
      return json(response, 200, fixtures.readiness);
    case '/api/v1/kyc/config':
      return json(response, 200, fixtures.kycConfig);
    default:
      return null;
  }
}

function handleRead(pathname, search, response) {
  const fixtures = buildFixtures();
  const status = search.get('status') ?? undefined;
  const regionId = search.get('regionId') ?? undefined;

  if (mode === 'empty') {
    const empty = handleEmptyRead(pathname, response, fixtures);
    if (empty !== null) return empty;
  }

  if (pathname === '/readyz') return json(response, 200, fixtures.readiness);

  if (pathname === '/api/v1/kyc/config') return json(response, 200, fixtures.kycConfig);

  if (pathname === '/api/v1/corridors') {
    return json(response, 200, { corridors: fixtures.corridors });
  }

  const tiers = /^\/api\/v1\/corridors\/([^/]+)\/compliance-tiers$/.exec(pathname);
  if (tiers !== null) {
    const corridor = fixtures.corridors.find((candidate) => candidate.id === tiers[1]);
    if (corridor === undefined) {
      return failure(response, 404, 'NOT_FOUND', `corridor ${tiers[1]} not found`);
    }
    return json(response, 200, fixtures.complianceTiersFor(corridor));
  }

  // Matched before `/agents/:id`, which would otherwise read `liquidity` as an id.
  if (pathname === '/api/v1/agents/liquidity/alerts') {
    if (mode === 'malformed') {
      // An alert kind the console does not know. Rendering it as a neutral badge
      // would tell an operator "nothing unusual" about an unrecognised condition.
      const [first] = fixtures.alerts;
      return json(response, 200, { alerts: [{ ...first, kind: 'SOMETHING_NEW' }] });
    }
    return json(response, 200, {
      alerts: fixtures.alerts.filter((alert) => status === undefined || alert.status === status),
    });
  }

  if (pathname === '/api/v1/agents/liquidity/top-ups') {
    return json(response, 200, {
      requests: topUps.filter(
        (request) => status === undefined || request.status === status,
      ),
    });
  }

  const pool = /^\/api\/v1\/liquidity\/regions\/([^/]+)$/.exec(pathname);
  if (pool !== null) {
    const health = fixtures.poolHealth[pool[1]];
    if (health === undefined) {
      return failure(response, 404, 'NOT_FOUND', `region ${pool[1]} not found`);
    }
    return json(response, 200, health);
  }

  if (pathname === '/api/v1/kyc/attestations') {
    if (mode === 'malformed') {
      const [first] = fixtures.attestations;
      // A tier the console cannot rank. Shown as-is, an operator cannot tell
      // whether the subject cleared the bar for the transfer in front of them.
      return json(response, 200, {
        attestations: [{ ...first, tier: 'STANDARD_PLUS' }],
        expiresSweepable: 0,
      });
    }
    const attestations = fixtures.attestations.filter(
      (row) => status === undefined || row.status === status,
    );
    return json(response, 200, {
      attestations,
      expiresSweepable: attestations.filter(
        (row) => new Date(row.expiresAt).getTime() < Date.now(),
      ).length,
    });
  }

  if (pathname === '/api/v1/transfers') {
    return json(response, 200, { transfers: fixtures.transfers, indexer: fixtures.indexer });
  }

  if (pathname === '/api/v1/agents') {
    if (mode === 'malformed') {
      // Money as a JSON number, which is the defect the console's schemas exist to
      // catch: `500` is indistinguishable from `500.00` once it is a double, and
      // the precision is already gone by the time anything validates it.
      const agents = fixtures.agents.map((agent) => ({
        ...agent,
        bondAmount: Number(agent.bondAmount) / 10_000_000,
      }));
      return json(response, 200, { agents });
    }
    return json(response, 200, {
      agents: fixtures.agents.filter(
        (agent) =>
          (status === undefined || agent.status === status) &&
          (regionId === undefined || agent.regionId === regionId),
      ),
    });
  }

  const agent = /^\/api\/v1\/agents\/([^/]+)$/.exec(pathname);
  if (agent !== null) {
    const detail = fixtures.agentDetails[agent[1]];
    if (detail === undefined) {
      return failure(response, 404, 'NOT_FOUND', `agent ${agent[1]} not found`);
    }
    return json(response, 200, detail);
  }

  return failure(response, 404, 'NOT_FOUND', `no stub route for ${pathname}`);
}

function handleWrite(pathname, body, response) {
  const fixtures = buildFixtures();

  if (pathname === '/api/v1/agents/liquidity/top-ups') {
    const amountRequested = toStroops(body.amount);
    if (amountRequested === null) {
      return failure(response, 400, 'VALIDATION_FAILED', 'amount must be a decimal string');
    }
    const created = {
      id: randomUUID(),
      agentId: String(body.agentId),
      regionId: String(body.regionId),
      amountRequested,
      reason: String(body.reason),
      status: 'PENDING',
      requestedBy: String(body.requestedBy),
      approvedBy: null,
      decisionNote: null,
      txHash: null,
      failureReason: null,
      createdAt: new Date().toISOString(),
      decidedAt: null,
      executedAt: null,
      agent: {
        id: String(body.agentId),
        legalName: 'Ada Okafor Ventures Ltd',
        tradingName: 'Mama Ada Cash Point',
      },
    };
    topUps = [created, ...topUps];
    return json(response, 201, created);
  }

  const decision = /^\/api\/v1\/agents\/liquidity\/top-ups\/([^/]+)\/decision$/.exec(pathname);
  if (decision !== null) {
    const target = findTopUp(decision[1]);
    if (target === undefined) {
      return failure(response, 404, 'NOT_FOUND', 'top-up request not found');
    }
    const updated = {
      ...target,
      status: body.approved === true ? 'APPROVED' : 'REJECTED',
      approvedBy: String(body.approvedBy),
      decisionNote: typeof body.note === 'string' ? body.note : null,
      decidedAt: new Date().toISOString(),
    };
    topUps = topUps.map((candidate) => (candidate.id === target.id ? updated : candidate));
    return json(response, 200, updated);
  }

  const execute = /^\/api\/v1\/agents\/liquidity\/top-ups\/([^/]+)\/execute$/.exec(pathname);
  if (execute !== null) {
    const target = findTopUp(execute[1]);
    if (target === undefined) {
      return failure(response, 404, 'NOT_FOUND', 'top-up request not found');
    }
    const executed = {
      ...target,
      status: 'EXECUTED',
      executedAt: new Date().toISOString(),
      txHash: 'f0e1d2c3b4a5968778695a4b3c2d1e0f12345678',
    };
    topUps = topUps.map((candidate) => (candidate.id === target.id ? executed : candidate));
    return json(response, 200, executed);
  }

  if (pathname === '/api/v1/agents/liquidity/sweep') {
    return json(response, 200, {
      regionId: String(body.regionId),
      scanned: fixtures.agents.length,
      alertsRaised: 0,
    });
  }

  if (pathname === '/api/v1/kyc/revocations') {
    return json(response, 200, {
      subjectAddress: String(body.subjectAddress),
      reason: String(body.reason),
      revoked: 1,
    });
  }

  return failure(response, 404, 'NOT_FOUND', `no stub route for POST ${pathname}`);
}

function handleControl(method, body, response) {
  if (method === 'GET') {
    return json(response, 200, { mode, requests: recorded });
  }

  if (body.reset === true) reset();
  if (typeof body.mode === 'string') {
    if (!MODES.has(body.mode)) {
      return failure(response, 400, 'VALIDATION_FAILED', `unknown mode ${body.mode}`);
    }
    mode = body.mode;
  }
  return json(response, 200, { mode, requests: recorded });
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);
    const method = request.method ?? 'GET';

    try {
      // The body is read exactly once: a stream consumed here would arrive empty
      // at the route handler below.
      const body = method === 'POST' ? await readJson(request) : null;

      if (url.pathname === '/__control') {
        handleControl(method, body ?? {}, response);
        return;
      }

      if (url.pathname === '/healthz') {
        json(response, 200, { status: 'ok' });
        return;
      }

      recorded.push({
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
      });

      if (mode === 'down') {
        failure(response, 503, 'SERVICE_UNAVAILABLE', 'The read model is unreachable.');
        return;
      }

      if (method === 'GET') {
        handleRead(url.pathname, url.searchParams, response);
        return;
      }

      handleWrite(url.pathname, body ?? {}, response);
    } catch (error) {
      failure(
        response,
        500,
        'STUB_FAILURE',
        error instanceof Error ? error.message : 'the stub itself failed',
      );
    }
  })();
});

server.listen(PORT, HOST, () => {
  // Printed so a failed run shows which backend the console was pointed at.
  process.stdout.write(`stub backend listening on http://${HOST}:${PORT}\n`);
});
