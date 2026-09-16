import { z } from 'zod';

/**
 * The deployment configuration: the regions, corridors and tier bands that a
 * network is deployed with.
 *
 * It lives here rather than inside `prisma/seed.ts` because two very different
 * callers need the same validation: the seed script that populates the read model
 * from a checkout, and the container that populates it from `DEPLOY_CONFIG_JSON`
 * in an environment where no checkout exists. A second hand-written schema would
 * drift from the first, and the drift would show up as an operator console
 * explaining tier bands the compliance hook enforces differently.
 *
 * The contract remains the authority. This describes the read model's starting
 * point, which is the same object the contracts were deployed from.
 */

export const regionSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  countryCode: z.string(),
  currency: z.string(),
  minBond: z.string(),
  maxAgents: z.number(),
  utilizationCapBps: z.number(),
});

export const corridorSchema = z.object({
  id: z.string(),
  regionId: z.string(),
  sourceCurrency: z.string(),
  destCurrency: z.string(),
  tier1Max: z.string(),
  tier2Max: z.string(),
  dailyLimit: z.string(),
  spreadBps: z.number(),
});

export const deployConfigSchema = z.object({
  regions: z.array(regionSchema),
  corridors: z.array(corridorSchema),
});

export type DeployConfig = z.infer<typeof deployConfigSchema>;

/** Render the zod issues as `path: message` pairs, for an error a human can act on. */
export function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

/**
 * Parse the configuration passed as *data* (`DEPLOY_CONFIG_JSON`).
 *
 * Returns `undefined` when the variable is unset or blank, so the caller can fall
 * back to the file on disk. Throws — rather than returning `undefined` — when the
 * variable is present but wrong: a deployment that sets it has decided the
 * database is populated from it, and quietly falling back to a different source
 * would seed bands nobody reviewed.
 */
export function parseDeployConfigJson(raw: string | undefined): DeployConfig | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`DEPLOY_CONFIG_JSON is not valid JSON: ${String(cause)}`);
  }

  const parsed = deployConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`DEPLOY_CONFIG_JSON is invalid: ${describeIssues(parsed.error)}`);
  }
  return parsed.data;
}
