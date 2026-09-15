import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../api/middleware.js';
import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { notFound, unauthorized, validationFailed } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { toVerificationTier } from './provider.js';
import {
  expireStaleAttestations,
  getProvider,
  revokeForSubject,
  submitVerification,
} from './service.js';

const documentSchema = z.object({
  type: z.enum(['passport', 'national_id', 'drivers_license']),
  number: z.string().min(4).max(64),
  countryCode: z.string().length(2),
  expiresOn: z.string().date(),
});

const addressSchema = z.object({
  line1: z.string().min(1),
  city: z.string().min(1),
  postalCode: z.string().optional(),
  countryCode: z.string().length(2),
});

/**
 * Amounts arrive as decimal strings, never numbers.
 *
 * A JSON number would have been parsed as a double before this schema ever sees
 * it, so precision would already be lost. The schema accepts a string and
 * `toStroops` converts it exactly.
 */
const submitSchema = z.object({
  userId: z.string().uuid(),
  corridorId: z.string().min(2).max(12),
  regionId: z.string().min(2).max(12),
  amount: z.string().regex(/^\d+(\.\d{1,7})?$/, 'expected a decimal string with at most 7 places'),
  fullName: z.string().min(2).max(200),
  dateOfBirth: z.string().date(),
  countryCode: z.string().length(2),
  document: documentSchema.optional(),
  address: addressSchema.optional(),
  sourceOfFunds: z.string().max(500).optional(),
});

export function kycRouter(): Router {
  const router = Router();

  /**
   * Preflight: what would this transfer require?
   *
   * Exists so the sender app can render "this needs ID" *before* the sender has
   * entered a passport number, and so the answer comes from the same tier logic
   * the submission path uses rather than a client-side copy of it.
   */
  router.post('/kyc/preflight', asyncHandler(async (req: Request, res: Response) => {
    const body = submitSchema.pick({ corridorId: true, amount: true }).safeParse(req.body);
    if (!body.success) throw validationFailed({ issues: body.error.issues });

    const corridor = await prisma.corridor.findUnique({ where: { id: body.data.corridorId } });
    if (!corridor) throw notFound('corridor', body.data.corridorId);

    const { toStroops } = await import('../lib/money.js');
    const amount = toStroops(body.data.amount);
    const tier1Max = BigInt(corridor.tier1Max.toString());
    const tier2Max = BigInt(corridor.tier2Max.toString());

    const requiredTier = amount <= tier1Max ? 'NONE' : amount <= tier2Max ? 'STANDARD' : 'ENHANCED';
    res.json({
      corridorId: corridor.id,
      requiredTier,
      // Deliberately not a boolean: the caller needs to know *which* tier, both
      // so it can start the right flow and so the UI can explain the difference
      // between "no check" and "enhanced due diligence".
      tiers: {
        tier1Max: tier1Max.toString(),
        tier2Max: tier2Max.toString(),
        dailyLimit: corridor.dailyLimit.toString(),
      },
    });
  }));

  /** Submit a verification. Returns the outcome; publishing happens inside. */
  router.post('/kyc/verifications', asyncHandler(async (req: Request, res: Response) => {
    const body = submitSchema.safeParse(req.body);
    if (!body.success) throw validationFailed({ issues: body.error.issues });

    const { toStroops } = await import('../lib/money.js');
    const output = await submitVerification({
      userId: body.data.userId,
      corridorId: body.data.corridorId,
      regionId: body.data.regionId,
      amount: toStroops(body.data.amount),
      fullName: body.data.fullName,
      dateOfBirth: body.data.dateOfBirth,
      countryCode: body.data.countryCode,
      ...(body.data.document ? { document: body.data.document } : {}),
      ...(body.data.address
        ? {
            address: {
              line1: body.data.address.line1,
              city: body.data.address.city,
              countryCode: body.data.address.countryCode,
              // `exactOptionalPropertyTypes` is on, so an explicit `undefined` is
              // not the same as an absent key. Spreading the parsed object
              // straight through would fail to typecheck, and silently dropping
              // the field would lose data a provider may require.
              ...(body.data.address.postalCode !== undefined
                ? { postalCode: body.data.address.postalCode }
                : {}),
            },
          }
        : {}),
      ...(body.data.sourceOfFunds ? { sourceOfFunds: body.data.sourceOfFunds } : {}),
    });

    res.status(output.outcome === 'APPROVED' ? 201 : 202).json(output);
  }));

  /**
   * Provider webhook.
   *
   * The raw body is required for signature verification, so this route is
   * mounted with `express.text()` rather than the JSON parser — a parsed-then-
   * reserialised body has different bytes and would fail every signature check.
   */
  router.post('/kyc/webhooks/:providerId', asyncHandler(async (req: Request, res: Response) => {
    const providerId = req.params.providerId ?? '';
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    const provider = getProvider(providerId);
    if (!provider.verifyWebhookSignature(req.headers as Record<string, string | undefined>, rawBody)) {
      // 401 rather than 400: an unsigned or mis-signed webhook is an
      // authentication failure, and it should be visible as one in metrics.
      throw unauthorized('invalid webhook signature');
    }

    const event = provider.parseWebhook(rawBody);
    logger.info({ providerId, providerRef: event.providerRef, outcome: event.outcome }, 'kyc webhook');

    const record = await prisma.kycAttestation.findFirst({
      where: { providerRef: event.providerRef },
      orderBy: { createdAt: 'desc' },
    });
    if (!record) {
      // Acknowledge rather than 404: providers retry on non-2xx, and an unknown
      // reference will never become known. Retrying only amplifies the traffic.
      logger.warn({ providerRef: event.providerRef }, 'webhook for an unknown reference');
      res.json({ accepted: true, matched: false });
      return;
    }

    await prisma.kycAttestation.update({
      where: { id: record.id },
      data: {
        status: event.outcome === 'APPROVED' ? 'ACTIVE' : event.outcome === 'REJECTED' ? 'REVOKED' : 'PENDING',
        ...(event.outcome === 'REJECTED' ? { revokedAt: new Date(), revokeReason: event.reasons.join(',') } : {}),
      },
    });

    res.json({ accepted: true, matched: true, outcome: event.outcome });
  }));

  /** Operator: revoke every attestation belonging to a subject. */
  router.post('/kyc/revocations', asyncHandler(async (req: Request, res: Response) => {
    const body = z
      .object({ subjectAddress: z.string().startsWith('G'), reason: z.string().min(2).max(64) })
      .safeParse(req.body);
    if (!body.success) throw validationFailed({ issues: body.error.issues });

    const result = await revokeForSubject(body.data.subjectAddress, body.data.reason);
    res.json(result);
  }));

  /** Operator: the compliance-monitoring feed. */
  router.get('/kyc/attestations', asyncHandler(async (req: Request, res: Response) => {
    const query = z
      .object({
        status: z.enum(['PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED']).optional(),
        regionId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .safeParse(req.query);
    if (!query.success) throw validationFailed({ issues: query.error.issues });

    const rows = await prisma.kycAttestation.findMany({
      where: {
        ...(query.data.status ? { status: query.data.status } : {}),
        ...(query.data.regionId ? { regionId: query.data.regionId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.data.limit,
      select: {
        // Explicit projection with no `providerRef` and no `raw`: this endpoint is
        // the one an operator dashboard calls, and it should be impossible for a
        // provider reference to leak through a `select *` added later.
        id: true,
        userId: true,
        tier: true,
        status: true,
        regionId: true,
        providerId: true,
        issuedAt: true,
        expiresAt: true,
        revokedAt: true,
      },
    });

    res.json({ attestations: rows, expiresSweepable: await expireStaleAttestations() });
  }));

  router.get('/kyc/config', (_req: Request, res: Response) => {
    const provider = getProvider();
    res.json({
      provider: provider.id,
      // Translated out of the provider's vocabulary: this response is read by the
      // dashboard, and the dashboard's contract is `VerificationTier`.
      supportedTiers: provider.supportedTiers.map(toVerificationTier),
      enhancedDueDiligence: provider.supportsEnhancedDueDiligence,
      attestationTtlDays: env.KYC_ATTESTATION_TTL_DAYS,
      webhookSignatureRequired: env.KYC_PROVIDER_WEBHOOK_SECRET !== undefined,
    });
  });

  return router;
}
