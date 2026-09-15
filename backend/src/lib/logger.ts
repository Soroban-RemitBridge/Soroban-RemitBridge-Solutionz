import pino from 'pino';

import { SECRET_ENV_KEYS, env, isTest } from '../config/env.js';

/**
 * Structured logger.
 *
 * The redaction list is the important part. The realistic way a secret escapes is
 * not an attacker reading memory — it is a developer logging `env` or a request
 * body while debugging, and that landing in a log aggregator that is replicated,
 * snapshotted and shared with support tooling. Redacting by key name makes that
 * mistake survivable.
 *
 * KYC payloads are redacted by field name too. A provider webhook containing a
 * document reference must never be logged verbatim, even at debug level.
 */
const REDACTED_PATHS = [
  ...SECRET_ENV_KEYS.map((key) => key),
  ...SECRET_ENV_KEYS.map((key) => `*.${key}`),
  'req.headers.authorization',
  'req.headers["x-provider-signature"]',
  'req.body.documentNumber',
  'req.body.document_number',
  'req.body.dateOfBirth',
  'res.headers["set-cookie"]',
  'fullName',
  'full_name',
  'dob',
  'taxId',
  '*.documentNumber',
  '*.fullName',
];

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  base: { service: 'remitbridge-backend', env: env.NODE_ENV },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;

/** Child logger carrying a correlation id through a request or indexer tick. */
export function withContext(context: Record<string, unknown>): Logger {
  return logger.child(context);
}
