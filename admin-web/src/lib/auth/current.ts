import { cookies } from 'next/headers';

import { may, type Permission } from './policy';
import { SESSION_COOKIE, sessionSecret, verifySession, type SessionPayload } from './session';

/**
 * The signed-in operator, for server components.
 *
 * Used by the pages to decide which controls to render. That decision is an
 * *affordance*, not a control: the proxy refuses every mutation from the session
 * regardless of what the page drew. Rendering an Approve button to someone whose
 * role cannot approve produces a confusing 403 after a confirmation dialog, which
 * is why the console does not do it — but the security property lives in the proxy.
 *
 * Server-only: `next/headers`. Nothing in `lib/auth` besides this and
 * `accounts.ts` reaches for the Next runtime, which is what keeps the session
 * checks testable.
 */

export async function currentSession(): Promise<SessionPayload | null> {
  let secret: string;
  try {
    secret = sessionSecret();
  } catch {
    // Unconfigured. The proxy answers those requests with an explicit 500 before
    // any page renders, so arriving here means "not signed in".
    return null;
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return verifySession(token, secret);
}

/** Whether the signed-in operator holds a permission. */
export async function currentOperatorCan(permission: Permission): Promise<boolean> {
  const session = await currentSession();
  return session !== null && may(session.roles, permission);
}
