import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

import { may, policyForMutation, withOperatorAttribution } from '@/lib/auth/policy';
import { SESSION_COOKIE, sessionSecret, verifySession } from '@/lib/auth/session';

/**
 * Server-side proxy to the backend.
 *
 * Browser mutations go through here rather than straight to the API, for four
 * reasons worth stating:
 *
 * 1. The backend address stays server-only, so it is not inlined into a client
 *    bundle — a bundle is public even when the console is not.
 * 2. No CORS, so the backend can keep a restrictive origin policy instead of
 *    opening up to whichever host the console happens to be deployed on.
 * 3. There is exactly one place browser-originated state changes leave the app,
 *    which is what makes them auditable.
 * 4. It is where an action is authorised and where the audit trail's actor is
 *    decided, both from the *verified session* rather than from the request body.
 *
 * The last point is the one that matters most. Before this, the console sent
 * `requestedBy: 'operator-console'` from the browser — a fixed deployment-wide
 * placeholder that any client could set to anything. Now the actor is the signed-in
 * operator, written here, and any client-supplied value is discarded first. A
 * browser cannot name someone else as the approver of a float move.
 *
 * The path is joined onto the configured base rather than taken from the request,
 * so this cannot be turned into an open proxy.
 */

const API_BASE = (process.env['REMITBRIDGE_API_URL'] ?? 'http://localhost:4000').replace(/\/+$/, '');

interface AuthorisedCaller {
  email: string;
}

/**
 * Resolve the caller from the session cookie.
 *
 * Re-verified here even though the middleware already did it: the middleware is
 * reached through a `matcher`, and this handler is reached by an HTTP request to a
 * route. Authorising on the basis of "something upstream must have checked" is how
 * an endpoint ends up unprotected the day the matcher changes.
 */
async function authorisedCaller(): Promise<AuthorisedCaller | null> {
  let secret: string;
  try {
    secret = sessionSecret();
  } catch {
    return null;
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySession(token, secret);
  return session === null ? null : { email: session.sub };
}

function jsonError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await context.params;

  // Reads are authorised by authentication alone; the session check is what keeps
  // KYC attestation references and agent balances off an unauthenticated screen.
  if ((await authorisedCaller()) === null) {
    return jsonError('UNAUTHORIZED', 'Sign in to use the operator console.', 401);
  }

  return forward(`/api/v1/${path.join('/')}${request.nextUrl.search}`, 'GET', undefined, null);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await context.params;

  const caller = await authorisedCaller();
  if (caller === null) {
    return jsonError('UNAUTHORIZED', 'Sign in to use the operator console.', 401);
  }

  const policy = policyForMutation(path);
  if (policy === null) {
    // Fail closed on an action with no declared policy. The alternative —
    // forwarding anything a signed-in operator asks for — means the authorisation
    // model is documentation rather than a control.
    return jsonError('FORBIDDEN', 'This action has no authorisation policy, so it is refused.', 403);
  }

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySession(token, sessionSecret());
  if (session === null || !may(session.roles, policy.permission)) {
    return jsonError(
      'FORBIDDEN',
      `Your role cannot ${policy.operation}. Ask an administrator for the ${policy.permission} permission.`,
      403,
    );
  }

  const body = withOperatorAttribution(await request.text(), policy, caller);
  return forward(`/api/v1/${path.join('/')}${request.nextUrl.search}`, 'POST', body, caller);
}

async function forward(
  path: string,
  method: 'GET' | 'POST',
  body: string | undefined,
  caller: AuthorisedCaller | null,
): Promise<NextResponse> {
  const target = `${API_BASE}${path}`;

  try {
    const response = await fetch(target, {
      method,
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        // The console's own provenance, for the backend's request log. This is the
        // authenticated operator rather than a fixed placeholder, which is what
        // makes a backend log line traceable to a person.
        ...(caller !== null ? { 'x-operator': caller.email } : {}),
      },
      ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(15_000),
    });

    const text = await response.text();
    return new NextResponse(text, {
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') ?? 'application/json',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: 'UPSTREAM_UNREACHABLE',
          message: error instanceof Error ? error.message : 'Backend unreachable.',
        },
      },
      { status: 502 },
    );
  }
}
