import type { Role } from './roles';

/**
 * What an operator is allowed to do, and who the audit trail says did it.
 *
 * Two rules shape this file:
 *
 * 1. **Authorisation is decided server-side, from the session.** The console's
 *    buttons are a usability affordance, not a control: hiding a button changes
 *    nothing about what a request can do. Every decision here is derived from the
 *    verified session on the server, which is why this module contains no React.
 * 2. **An unknown mutation is refused, not allowed.** A route added to the proxy
 *    without a policy does not inherit one by accident — `policyForMutation`
 *    returns `null` and the proxy rejects the request. The alternative default
 *    (allow, and add a rule later) fails open, which for an endpoint that moves
 *    float is the wrong direction to fail in.
 *
 * Edge-safe on purpose: no `node:crypto`, no database. `middleware.ts` imports it.
 */

export const PERMISSIONS = [
  'liquidity:propose',
  'liquidity:decide',
  'liquidity:execute',
  'liquidity:sweep',
  'kyc:revoke',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Reads are gated by authentication alone — every role can see every panel.
 * That is deliberate: the console's screens are the operator's situational
 * awareness, and a console that hides the pool's utilisation from the person
 * approving a top-up is worse than one that shows it to a read-only colleague.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: [],
  operator: ['liquidity:propose', 'liquidity:decide', 'liquidity:execute', 'liquidity:sweep'],
  admin: [
    'liquidity:propose',
    'liquidity:decide',
    'liquidity:execute',
    'liquidity:sweep',
    'kyc:revoke',
  ],
};

export function permissionsFor(roles: readonly Role[]): Set<Permission> {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) granted.add(permission);
  }
  return granted;
}

export function may(roles: readonly Role[], permission: Permission): boolean {
  return permissionsFor(roles).has(permission);
}

/**
 * Fields the console may not let a browser attribute to someone else.
 *
 * The backend records these in its audit trail, so they are the difference
 * between "the operator approved this" and "a browser claimed the operator
 * approved this". The proxy overwrites them from the session.
 */
export const AUDIT_FIELDS = ['requestedBy', 'approvedBy'] as const;

export interface MutationPolicy {
  readonly permission: Permission;
  /** Audit fields this route requires, set from the session rather than the body. */
  readonly auditFields: readonly string[];
  /** For logs and error messages, so a refusal names the operation. */
  readonly operation: string;
}

/**
 * The policy for a mutation, by path.
 *
 * Paths are matched exactly rather than by prefix: `agents/liquidity/top-ups` and
 * `agents/liquidity/top-ups/:id/decision` need different permissions, and a
 * prefix match would silently grant the decision to anyone who can propose.
 */
export function policyForMutation(segments: readonly string[]): MutationPolicy | null {
  const path = segments.join('/');

  if (path === 'agents/liquidity/top-ups') {
    return {
      permission: 'liquidity:propose',
      auditFields: ['requestedBy'],
      operation: 'propose a float top-up',
    };
  }
  if (segments.length === 5 && segments[4] === 'decision' && path.startsWith('agents/liquidity/top-ups/')) {
    return {
      permission: 'liquidity:decide',
      auditFields: ['approvedBy'],
      operation: 'decide a float top-up',
    };
  }
  if (
    segments.length === 5 &&
    segments[4] === 'execute' &&
    path.startsWith('agents/liquidity/top-ups/')
  ) {
    // Releasing float is a separate action from approving it, and the console
    // presents it as one on purpose: a human decides, a machine acts. It has its
    // own permission so that separating the two is a configuration decision rather
    // than something a role inherits by being able to approve.
    return {
      permission: 'liquidity:execute',
      auditFields: [],
      operation: 'execute a float draw',
    };
  }
  if (path === 'agents/liquidity/sweep') {
    return {
      permission: 'liquidity:sweep',
      auditFields: [],
      operation: 'run a liquidity sweep',
    };
  }
  if (path === 'kyc/revocations') {
    return {
      permission: 'kyc:revoke',
      auditFields: [],
      operation: 'revoke attestations',
    };
  }
  return null;
}

/**
 * Replace any client-supplied attribution with the authenticated operator.
 *
 * Returns the body unchanged when the policy carries no audit fields, and when the
 * body is not a JSON object — a malformed body is the backend's to reject, and
 * rewriting it here would turn a validation error into a confusing 400.
 */
export function withOperatorAttribution(
  rawBody: string,
  policy: MutationPolicy,
  actor: { email: string },
): string {
  if (policy.auditFields.length === 0) return rawBody;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rawBody;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return rawBody;

  const body = parsed as Record<string, unknown>;
  // Removed first, then written: a deleted field cannot survive a merge order
  // mistake, and "the browser said so" must never be what the audit log records.
  for (const field of AUDIT_FIELDS) delete body[field];
  for (const field of policy.auditFields) body[field] = actor.email;
  return JSON.stringify(body);
}
