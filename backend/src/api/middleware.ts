import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { AppError, isAppError, validationFailed } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/** Attach a correlation id so a log line can be tied back to a client report. */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', requestId);
  (req as Request & { requestId: string }).requestId = requestId;
  next();
}

/**
 * Error handler.
 *
 * Internal errors return an opaque body. A stack trace from a service that holds
 * KYC documents and signing keys routinely contains a query with a name and a
 * date of birth in the parameters, and a 500 response is the single most likely
 * place for that to escape. The full error goes to the log with the request id
 * instead, which is enough to debug and not enough to leak.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  void next;
  const requestId = (req as Request & { requestId?: string }).requestId ?? 'unknown';

  if (isAppError(error)) {
    logger.warn({ requestId, code: error.code, status: error.status }, error.message);
    res.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details, requestId } });
    return;
  }

  if (error instanceof ZodError) {
    const appError = validationFailed({ issues: error.issues });
    res.status(appError.status).json({ error: { code: appError.code, message: appError.message, details: appError.details, requestId } });
    return;
  }

  logger.error(
    { requestId, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined },
    'unhandled error',
  );
  res.status(500).json({
    error: { code: 'INTERNAL', message: 'An internal error occurred.', requestId },
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` },
  });
}

/**
 * Fixed-window rate limiter.
 *
 * In-process and therefore per-instance, which is the honest limitation: behind a
 * load balancer each replica allows the full budget. It is sized to stop a single
 * client hammering a quote endpoint — the cheap way to drain an oracle quota —
 * rather than to be a security control, and the comment says so rather than
 * implying a guarantee it does not provide.
 */
export function rateLimit(options: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + options.windowMs });
      res.setHeader('x-ratelimit-remaining', String(options.max - 1));
      next();
      return;
    }

    entry.count += 1;
    if (entry.count > options.max) {
      res.setHeader('retry-after', String(Math.ceil((entry.resetAt - now) / 1_000)));
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests.',
          details: { windowMs: options.windowMs, max: options.max },
        },
      });
      return;
    }

    res.setHeader('x-ratelimit-remaining', String(options.max - entry.count));
    next();
  };
}

/** Terminate requests that hang, so a stuck upstream cannot hold a worker. */
export function timeout(ms: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        res.status(504).json({ error: { code: 'TIMEOUT', message: 'Request timed out.' } });
      }
    }, ms);
    res.on('finish', () => clearTimeout(timer));
    res.on('close', () => clearTimeout(timer));
    next();
  };
}

export { AppError };
