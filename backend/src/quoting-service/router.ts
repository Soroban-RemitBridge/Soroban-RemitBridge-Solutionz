import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../api/middleware.js';
import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { validationFailed } from '../lib/errors.js';
import { isQuoteLive, verifyQuote, type SignedQuote } from './signer.js';
import { createQuote, signingKeypair } from './service.js';

const quoteSchema = z.object({
  corridorId: z.string().min(2).max(12),
  // Decimal string, never a number: see lib/money.ts.
  amount: z.string().regex(/^\d+(\.\d{1,7})?$/),
});

export function quotingRouter(): Router {
  const router = Router();

  router.post('/quotes', asyncHandler(async (req: Request, res: Response) => {
    const body = quoteSchema.safeParse(req.body);
    if (!body.success) throw validationFailed({ issues: body.error.issues });

    const quote = await createQuote(body.data);
    // 201 with a short-lived resource: the Location header points at the
    // verification endpoint, so a client that wants to double-check has one.
    res.status(201).location(`/quotes/${quote.quoteId}`).json(quote);
  }));

  /**
   * Self-verification endpoint.
   *
   * Exists so a reviewer — or an auditor — can take a quote from a previous
   * session and confirm the backend actually issued it, without access to the
   * signing secret. That is the whole value of signing: the claim becomes
   * checkable by someone who does not trust the issuer.
   */
  router.post('/quotes/verify', (req: Request, res: Response) => {
    const body = z.object({ quote: z.record(z.unknown()) }).safeParse(req.body);
    if (!body.success) throw validationFailed({ issues: body.error.issues });

    const quote = body.data.quote as unknown as SignedQuote;
    const signedOk = verifyQuote(quote, env.QUOTE_SIGNING_SECRET_KEY, signingKeypair().publicKey());
    const live = isQuoteLive(quote);

    res.json({
      signatureValid: signedOk,
      withinValidityWindow: live,
      // Both are reported separately. "The signature is fine but it expired" and
      // "this signature never came from us" are different answers, and a single
      // boolean would collapse a forgery into a lapse.
      validUntil: quote.validUntil,
      signingKey: quote.signingKey,
    });
  });

  router.get('/quotes/:id', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id ?? '';
    const row = await prisma.quote.findUnique({ where: { id } });
    if (!row) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'quote not found' } });
      return;
    }
    res.json({
      ...row,
      consumed: row.consumedByTransfer !== null,
      live: row.validUntil.getTime() > Date.now(),
    });
  }));

  /** Corridor configuration, including the tier bands the sender app explains. */
  router.get('/corridors', asyncHandler(async (_req: Request, res: Response) => {
    const corridors = await prisma.corridor.findMany({ include: { region: true } });
    res.json({
      corridors: corridors.map((corridor) => ({
        ...corridor,
        tier1Max: corridor.tier1Max.toString(),
        tier2Max: corridor.tier2Max.toString(),
        dailyLimit: corridor.dailyLimit.toString(),
      })),
    });
  }));

  router.get('/corridors/:id/compliance-tiers', asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id ?? '';
    const corridor = await prisma.corridor.findUnique({ where: { id } });
    if (!corridor) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'corridor not found' } });
      return;
    }
    res.json({
      corridorId: corridor.id,
      tiers: [
        { tier: 'NONE', upTo: corridor.tier1Max.toString(), description: 'No verification required' },
        {
          tier: 'STANDARD',
          upTo: corridor.tier2Max.toString(),
          description: 'Government-ID verification required',
        },
        {
          tier: 'ENHANCED',
          upTo: corridor.dailyLimit.toString(),
          description: 'Enhanced due diligence: source of funds',
        },
      ],
      dailyLimit: corridor.dailyLimit.toString(),
      spreadBps: corridor.spreadBps,
    });
  }));

  return router;
}
