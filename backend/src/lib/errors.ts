/**
 * Error taxonomy.
 *
 * Contract error codes are mapped to HTTP responses here, in one table, because
 * the mapping is a *product* decision rather than a transport detail: the sender
 * app has to distinguish "complete your verification" from "split the transfer"
 * from "the network is down", and it can only do that if the API keeps the
 * distinction the contract made.
 */

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'COMPLIANCE_REFUSED'
  | 'INSUFFICIENT_COLLATERAL'
  | 'REGION_UNAVAILABLE'
  | 'CHAIN_UNAVAILABLE'
  | 'PROVIDER_UNAVAILABLE'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const validationFailed = (details: Record<string, unknown>): AppError =>
  new AppError('VALIDATION_FAILED', 'Request failed validation', 400, details);

export const notFound = (what: string, id: string): AppError =>
  new AppError('NOT_FOUND', `${what} not found`, 404, { id });

export const conflict = (message: string, details: Record<string, unknown> = {}): AppError =>
  new AppError('CONFLICT', message, 409, details);

export const unauthorized = (message: string): AppError =>
  new AppError('UNAUTHORIZED', message, 401);

export const providerUnavailable = (provider: string, cause: string): AppError =>
  new AppError('PROVIDER_UNAVAILABLE', `Identity provider unavailable`, 503, {
    provider,
    cause,
  });

export const chainUnavailable = (operation: string, cause: string): AppError =>
  new AppError('CHAIN_UNAVAILABLE', 'Soroban RPC unavailable', 503, { operation, cause });

/**
 * Compliance refusals, keyed by the `ComplianceError` variant name emitted by the
 * compliance hook contract.
 *
 * `attestationMissing` and `tierTooLow` are 403 rather than 400: the request was
 * well-formed, the *sender* is not yet permitted, and the client should route to
 * the verification flow rather than let the user retype the amount.
 * `dailyLimitExceeded` is 429 because retrying later genuinely works.
 */
const COMPLIANCE_STATUS: Record<string, number> = {
  AttestationMissing: 403,
  AttestationExpired: 403,
  AttestationRevoked: 403,
  TierTooLow: 403,
  DailyLimitExceeded: 429,
  TransfersPaused: 503,
  UnknownCorridor: 400,
  InvalidAmount: 400,
  InvalidThresholds: 400,
  NotInitialized: 500,
  EscrowNotSet: 500,
};

export function complianceRefused(variant: string, message: string): AppError {
  const status = COMPLIANCE_STATUS[variant] ?? 403;
  return new AppError('COMPLIANCE_REFUSED', message, status, { variant });
}

/** Truthy check used by the error middleware before falling back to 500. */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
