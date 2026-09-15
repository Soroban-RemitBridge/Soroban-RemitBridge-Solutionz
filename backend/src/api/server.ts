import express, { type Express } from 'express';
import { pinoHttp } from 'pino-http';

import { agentLiquidityRouter } from '../agent-liquidity/router.js';
import { env } from '../config/env.js';
import { NETWORK_LABELS, MAX_FEE_BPS, COMPLIANCE_ERROR_NAMES } from '../config/constants.js';
import { kycRouter } from '../kyc-orchestration/router.js';
import { logger } from '../lib/logger.js';
import { quotingRouter } from '../quoting-service/router.js';
import { transfersRouter } from '../transfers/router.js';
import { errorHandler, notFoundHandler, rateLimit, requestContext, timeout } from './middleware.js';
import { openApiDocument } from './openapi.js';

export function createServer(): Express {
  const app = express();

  // Behind a load balancer the client address arrives in X-Forwarded-For; without
  // this the rate limiter keys every request on the proxy's address and rations
  // the whole world as one client.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestContext);
  app.use(pinoHttp({ logger }));
  app.use(timeout(30_000));

  /**
   * Webhooks get their own raw body parser, and the scope is the *route*, not the
   * `/api/v1` prefix.
   *
   * Signature verification runs over the exact bytes the provider sent; a body
   * that has been parsed and reserialised has different bytes and would fail
   * every check, which presents as a provider outage rather than a middleware
   * ordering bug.
   *
   * Mounting this on the whole `/api/v1` prefix is the obvious mistake and a
   * expensive one: `express.text` marks the body as consumed, so the JSON parser
   * below silently skips, and every POST in the service receives a *string*
   * where it expects an object. The symptom is a validation error reading
   * "Expected object, received string" on routes that have nothing to do with
   * webhooks.
   */
  app.use(
    '/api/v1/kyc/webhooks/:providerId',
    express.text({ type: 'application/json', limit: '1mb' }),
  );

  app.use(express.json({ limit: '1mb' }));

  app.use('/api/v1', rateLimit({ windowMs: 60_000, max: 300 }));
  app.use('/api/v1', kycRouter(), transfersRouter(), quotingRouter(), agentLiquidityRouter());

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

  /** Readiness reports configuration provenance, not just liveness: an operator
   * looking at a misbehaving deployment needs to know which contracts it is
   * actually pointed at before anything else. */
  app.get('/readyz', (_req, res) => {
    res.json({
      status: 'ready',
      network: env.STELLAR_NETWORK,
      networkLabel: NETWORK_LABELS[env.STELLAR_NETWORK] ?? env.STELLAR_NETWORK,
      contracts: {
        escrow: env.CONTRACT_ESCROW,
        agentRegistry: env.CONTRACT_AGENT_REGISTRY,
        complianceHook: env.CONTRACT_COMPLIANCE_HOOK,
        liquidityPool: env.CONTRACT_LIQUIDITY_POOL,
      },
      limits: { maxFeeBps: MAX_FEE_BPS },
      kycProvider: env.KYC_PROVIDER,
    });
  });

  app.get('/openapi.json', (_req, res) => res.json(openApiDocument()));

  app.use(notFoundHandler);
  app.use(errorHandler);

  logger.debug({ errors: Object.keys(COMPLIANCE_ERROR_NAMES).length }, 'server configured');
  return app;
}
