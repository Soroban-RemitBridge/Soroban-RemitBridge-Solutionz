import { type Keypair } from '@stellar/stellar-sdk';

import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { conflict, providerUnavailable, validationFailed } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { keypairFromSecret } from '../soroban/rpc.js';
import { publishAttestation, revokeAttestation } from '../soroban/contracts.js';
import { HttpIdVerificationProvider } from './http-provider.js';
import { MockIdVerificationProvider } from './mock-provider.js';
import {
  attestationHashOf,
  tierSatisfies,
  toContractTier,
  type IdVerificationProvider,
  type VerificationRequest,
  type VerificationResult,
} from './provider.js';

/**
 * KYC orchestration.
 *
 * The pipeline is: resolve the required tier from the *chain*, ask the provider,
 * derive a hash from the provider's payload, and publish only that hash. The
 * ordering matters — reading the tier from the corridor config rather than from
 * the request means a caller cannot ask for a weaker check than the corridor
 * demands by simply claiming a lower amount.
 *
 * Everything in the database below is PII. Nothing above `attestationHashOf`
 * crosses into the chain module.
 */

const providerCache = new Map<string, IdVerificationProvider>();

export function getProvider(id: string = env.KYC_PROVIDER): IdVerificationProvider {
  const existing = providerCache.get(id);
  if (existing) return existing;

  switch (id) {
    case 'mock':
      providerCache.set(id, new MockIdVerificationProvider());
      break;
    case 'http': {
      const baseUrl = env.KYC_PROVIDER_BASE_URL;
      if (baseUrl === undefined) {
        // Boot error rather than a per-request failure: a service that starts up
        // configured for a real provider it cannot reach would accept KYC
        // submissions and fail them one at a time.
        throw new Error(
          'KYC_PROVIDER=http requires KYC_PROVIDER_BASE_URL. Set it to the provider\'s API root.',
        );
      }
      providerCache.set(
        id,
        new HttpIdVerificationProvider({
          baseUrl,
          ...(env.KYC_PROVIDER_API_KEY !== undefined
            ? { apiKey: env.KYC_PROVIDER_API_KEY }
            : {}),
          ...(env.KYC_PROVIDER_WEBHOOK_SECRET !== undefined
            ? { webhookSecret: env.KYC_PROVIDER_WEBHOOK_SECRET }
            : {}),
        }),
      );
      break;
    }
    case 'sumsub':
    case 'onfido':
      // Throwing a *named* error here rather than falling back to the mock is the
      // point: silently downgrading to a mock provider in a compliance path would
      // mean shipping unverified transfers under a production-looking config.
      throw new Error(
        `No ${id}-specific adapter is shipped. Set KYC_PROVIDER=http and KYC_PROVIDER_BASE_URL ` +
          `to the vendor's API root — see kyc-orchestration/http-provider.ts for the contract ` +
          `it must speak — or add an adapter implementing IdVerificationProvider here.`,
      );
    default:
      throw new Error(`Unknown KYC provider: ${id}`);
  }

  const provider = providerCache.get(id);
  if (!provider) throw new Error(`Failed to initialise provider ${id}`);
  return provider;
}

/** Resolve the tier a corridor demands for a given amount, from the database
 * mirror of the on-chain threshold config. */
export async function requiredTierFor(
  corridorId: string,
  amount: bigint,
): Promise<'NONE' | 'STANDARD' | 'ENHANCED'> {
  const corridor = await prisma.corridor.findUnique({ where: { id: corridorId } });
  if (!corridor) throw validationFailed({ corridorId: 'unknown corridor' });

  const tier2Max = BigInt(corridor.tier2Max.toString());
  const tier1Max = BigInt(corridor.tier1Max.toString());

  if (amount <= tier1Max) return 'NONE';
  if (amount <= tier2Max) return 'STANDARD';
  return 'ENHANCED';
}

export interface SubmitVerificationInput {
  userId: string;
  regionId: string;
  amount: bigint;
  corridorId: string;
  fullName: string;
  dateOfBirth: string;
  countryCode: string;
  document?: VerificationRequest['document'];
  address?: VerificationRequest['address'];
  sourceOfFunds?: string;
}

export interface SubmitVerificationOutput {
  attestationId: string;
  outcome: VerificationResult['outcome'];
  tier: VerificationResult['tier'];
  reasons: string[];
  requiredInput?: string[];
  /** Present only when the attestation was actually published. */
  txHash?: string;
  attestationHash?: string;
}

export async function submitVerification(
  input: SubmitVerificationInput,
): Promise<SubmitVerificationOutput> {
  const provider = getProvider();
  const requiredTier = await requiredTierFor(input.corridorId, input.amount);

  if (requiredTier === 'NONE') {
    // No verification needed at this amount. Returning early is a compliance
    // decision as much as a performance one: collecting a passport scan for a
    // transfer that does not require one is data the business has no lawful
    // basis to hold.
    return { attestationId: '', outcome: 'APPROVED', tier: 'None', reasons: ['NOT_REQUIRED'] };
  }

  const subject = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!subject) throw validationFailed({ userId: 'unknown user' });

  const result = await provider.submit({
    userId: input.userId,
    requiredTier,
    regionId: input.regionId,
    countryCode: input.countryCode,
    fullName: input.fullName,
    dateOfBirth: input.dateOfBirth,
    ...(input.document ? { document: input.document } : {}),
    ...(input.address ? { address: input.address } : {}),
    ...(input.sourceOfFunds ? { sourceOfFunds: input.sourceOfFunds } : {}),
  });

  if (result.outcome === 'NEEDS_INPUT') {
    return {
      attestationId: '',
      outcome: result.outcome,
      tier: result.tier,
      reasons: result.reasons,
      ...(result.requiredInput ? { requiredInput: result.requiredInput } : {}),
    };
  }

  const expiresAt = new Date(Date.now() + env.KYC_ATTESTATION_TTL_DAYS * 86_400_000);
  const attestationHash = result.outcome === 'APPROVED' ? attestationHashOf(result) : null;

  const record = await prisma.kycAttestation.create({
    data: {
      userId: input.userId,
      tier: toPrismaTier(result.tier),
      providerId: result.providerId,
      // A rejected verification has no attestation to anchor, but the attempt
      // still has to be recorded: an auditor asking "did you screen this person"
      // needs the negative answer as much as the positive one.
      attestationHash: attestationHash ? attestationHash.toString('hex') : `rejected:${result.providerRef}`,
      regionId: input.regionId,
      status: result.outcome === 'APPROVED' ? 'ACTIVE' : result.outcome === 'PENDING' ? 'PENDING' : 'REVOKED',
      expiresAt,
      providerRef: result.providerRef,
    },
  });

  if (result.outcome !== 'APPROVED' || !attestationHash) {
    logger.info(
      { userId: input.userId, outcome: result.outcome, reasons: result.reasons },
      'verification did not produce an attestation',
    );
    return {
      attestationId: record.id,
      outcome: result.outcome,
      tier: result.tier,
      reasons: result.reasons,
    };
  }

  if (!tierSatisfies(result.tier, requiredTier)) {
    // Defence in depth: the provider says approved, but not at the depth the
    // corridor asked for. Publishing would silently under-verify the sender.
    throw providerUnavailable(
      result.providerId,
      `provider returned tier ${result.tier} for a ${requiredTier} requirement`,
    );
  }

  const attester = keypairFromSecret(env.ATTESTER_SECRET_KEY);
  const attesterAddress = attester.publicKey();
  const subjectAddress = subject.stellarAddress ?? attesterAddress;

  const publication = await publishAttestation({
    attester,
    subject: subjectAddress,
    tier: toContractTier(result.tier),
    attestationHash,
    regionId: input.regionId,
    providerId: result.providerId,
    expiresAt: BigInt(Math.floor(expiresAt.getTime() / 1000)),
  });

  await prisma.kycAttestation.update({
    where: { id: record.id },
    data: {
      publishTxHash: publication.hash ?? null,
    },
  });

  logger.info(
    { userId: input.userId, tier: result.tier, txHash: publication.hash, provider: result.providerId },
    'attestation published',
  );

  return {
    attestationId: record.id,
    outcome: result.outcome,
    tier: result.tier,
    reasons: result.reasons,
    ...(publication.hash ? { txHash: publication.hash } : {}),
    attestationHash: attestationHash.toString('hex'),
  };
}

/**
 * Revoke an attestation. Both the database and the chain must agree, so the
 * chain call happens first: if it fails, the record still reads `ACTIVE` and no
 * consumer believes a revocation that never landed.
 */
export async function revokeForSubject(
  subjectAddress: string,
  reason: string,
): Promise<{ txHash?: string; affected: number }> {
  const attester: Keypair = keypairFromSecret(env.ATTESTER_SECRET_KEY);

  const revoked = await revokeAttestation(attester, subjectAddress, reason);

  const result = await prisma.kycAttestation.updateMany({
    where: {
      status: 'ACTIVE',
      user: { stellarAddress: subjectAddress },
    },
    data: { status: 'REVOKED', revokedAt: new Date(), revokeReason: reason, revokeTxHash: revoked.hash ?? null },
  });

  logger.warn({ subjectAddress, reason, affected: result.count }, 'attestation revoked');
  return { ...(revoked.hash ? { txHash: revoked.hash } : {}), affected: result.count };
}

/**
 * Expire attestations whose validity window has closed.
 *
 * Expiry is a status transition, not a chain write: the contract compares
 * `expires_at` against the ledger clock on every check, so a lapsed attestation
 * is already refused on-chain. This sweep exists so the dashboard and any
 * database-driven preflight agree with the chain.
 */
export async function expireStaleAttestations(now = new Date()): Promise<number> {
  const result = await prisma.kycAttestation.updateMany({
    where: { status: 'ACTIVE', expiresAt: { lte: now } },
    data: { status: 'EXPIRED' },
  });
  if (result.count > 0) {
    logger.info({ count: result.count }, 'expired lapsed attestations');
  }
  return result.count;
}

function toPrismaTier(tier: VerificationResult['tier']): 'NONE' | 'STANDARD' | 'ENHANCED' {
  switch (tier) {
    case 'None':
      return 'NONE';
    case 'Standard':
      return 'STANDARD';
    case 'Enhanced':
      return 'ENHANCED';
  }
}

/** Guard used by the admin API: refusing a tier change that would strand agents. */
export function assertTierDowngradeAllowed(current: 'NONE' | 'STANDARD' | 'ENHANCED', next: 'NONE' | 'STANDARD' | 'ENHANCED'): void {
  const rank = { NONE: 0, STANDARD: 1, ENHANCED: 2 } as const;
  if (rank[next] < rank[current]) {
    throw conflict('Downgrading a stored tier requires an explicit revocation', { current, next });
  }
}
