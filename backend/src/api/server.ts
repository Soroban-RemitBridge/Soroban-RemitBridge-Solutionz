import express, { type Express } from 'express';
import pinoHttp from 'pino-http';

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
   * Webhooks are mounted *before* the JSON body parser, with their own raw
   * parser. Signature verification runs over the exact bytes the provider sent; a
   * body that has been parsed and reserialised has different bytes and would fail
   * every check, which presents as a provider outage rather than a middleware
   * ordering bug.
   */
  app.use('/api/v1', express.text({ type: 'application/json', limit: '1mb' }), kycRouter());

  app.use(express.json({ limit: '1mb' }));

  app.use('/api/v1', rateLimit({ windowMs: 60_000, max: 300 }));
  app.use('/api/v1', transfersRouter(), quotingRouter(), agentLiquidityRouter());

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
