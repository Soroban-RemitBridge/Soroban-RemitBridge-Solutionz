import { NextResponse, type NextRequest } from 'next/server';

import { safeNextPath } from '@/lib/auth/navigation';
import { may, policyForMutation } from '@/lib/auth/policy';
import { SESSION_COOKIE, sessionSecret, verifySession } from '@/lib/auth/session';

/**
 * The console's gate.
 *
 * Next 16 renamed this file convention from `middleware.ts` to `proxy.ts` (and the
 * export from `middleware` to `proxy`), because "middleware" invited confusion
 * with Express middleware. The name is more accurate here anyway: this sits at the
 * network boundary in front of the app and decides whether a request reaches it.
 *
 * Before this existed, the console could authorise an agent, approve a float move
 * and publish a KYC revocation with no credential at all — it was `noindex` and
 * expected to sit behind network-level access control, which is a deployment
 * assumption rather than a control. This is the control.
 *
 * Three things are true here that are worth being explicit about:
 *
 * - **It runs on every request, including the ones the browser makes for data.**
 *   The pages read server-side, so a guard that only wrapped the page components
 *   would still let `/api/backend/*` through.
 * - **It is not the only check.** The mutation route re-verifies the session and
 *   re-derives the operator's identity before it forwards anything, because a
 *   `matcher` is a routing convenience and the route handler is what actually
 *   handles the request. Both use `lib/auth/session.ts`.
 * - **It fails closed when unconfigured.** With no `OPERATOR_SESSION_SECRET` the
 *   console refuses every request with an explanation, rather than treating
 *   "no secret" as "no session required" and serving an unauthenticated console
 *   that looks configured.
 */

const PUBLIC_PATHS = new Set(['/login', '/api/auth/login', '/api/auth/logout']);

export const config = {
  // Everything except Next's own static output. A matcher that tried to enumerate
  // the protected paths would fail open for the next route someone adds.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};

// Note: `src/lib/auth/*` is imported by this file, which Next runs in the Edge
// runtime. Nothing reachable from here may import `node:crypto`; that is why the
// role vocabulary lives in `lib/auth/roles.ts` rather than beside the password
// hashing in `lib/auth/accounts.ts`.

function jsonError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

function loginRedirect(request: NextRequest): NextResponse {
  const url = request.nextUrl.clone();
  const destination = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  url.pathname = '/login';
  url.search = '';
  if (destination !== '/') url.searchParams.set('next', destination);
  return NextResponse.redirect(url);
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith('/api/');

  let secret: string;
  try {
    secret = sessionSecret();
  } catch (cause) {
    return jsonError(
      'CONSOLE_MISCONFIGURED',
      cause instanceof Error ? cause.message : 'Console authentication is not configured.',
      500,
    );
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifySession(token, secret);

  if (PUBLIC_PATHS.has(pathname)) {
    // A signed-in operator landing on the login page is sent back to where they
    // were going, rather than being asked to sign in to a session they have.
    if (pathname === '/login' && session !== null) {
      const url = request.nextUrl.clone();
      const next = safeNextPath(request.nextUrl.searchParams.get('next'));
      url.pathname = next.split('?')[0] ?? '/';
      url.search = '';
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  if (session === null) {
    if (isApi) {
      return jsonError('UNAUTHORIZED', 'Sign in to use the operator console.', 401);
    }
    return loginRedirect(request);
  }

  // Mutations are authorised per action. Reads have already been authorised by the
  // session check above.
  if (request.method === 'POST' && pathname.startsWith('/api/backend/')) {
    const segments = pathname.split('/').filter(Boolean).slice(2);
    const policy = policyForMutation(segments);
    if (policy === null) {
      return jsonError(
        'FORBIDDEN',
        'This action has no authorisation policy, so it is refused.',
        403,
      );
    }
    if (!may(session.roles, policy.permission)) {
      return jsonError(
        'FORBIDDEN',
        `Your role cannot ${policy.operation}. Ask an administrator for the ${policy.permission} permission.`,
        403,
      );
    }
  }

  // Note what does *not* happen here: the session is not forwarded to the route
  // handler on a request header. A header would be one more thing to trust, and
  // the handler can verify the cookie itself with the same module for the cost of
  // one HMAC. Passing identity through a header the client can also send is how
  // "trusted header" bugs start.
  return NextResponse.next();
}
