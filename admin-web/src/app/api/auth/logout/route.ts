import { NextResponse, type NextRequest } from 'next/server';

import { requestUsesHttps, SESSION_COOKIE, sessionCookieOptions } from '@/lib/auth/session';

/**
 * Sign out.
 *
 * Clearing the cookie is the whole operation, because the session is stateless —
 * there is no server-side record to delete. The cookie is overwritten with an
 * empty value and `maxAge: 0` so every browser drops it, including ones that
 * ignore a bare `Set-Cookie` on the delete path.
 *
 * Deliberately unauthenticated: signing out when you are already signed out is
 * not an error, and requiring a valid session to clear a session would leave a
 * user with a bad cookie unable to get rid of it.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  // The same `secure` derivation as the login route. A mismatched flag here means
  // a cookie that was set and never cleared.
  const secure = requestUsesHttps({
    protocol: request.nextUrl.protocol,
    forwardedProto: request.headers.get('x-forwarded-proto') ?? undefined,
  });
  response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(0, secure));
  return response;
}
