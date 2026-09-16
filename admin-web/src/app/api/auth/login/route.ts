import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { findOperator, hashPassword, operatorAccounts, verifyPassword } from '@/lib/auth/accounts';
import {
  buildSessionPayload,
  requestUsesHttps,
  SESSION_COOKIE,
  sessionCookieOptions,
  sessionSecret,
  sessionTtlMinutes,
  signSession,
} from '@/lib/auth/session';
import { loginThrottle } from '@/lib/auth/throttle';

/**
 * Sign in.
 *
 * Node runtime, not Edge: `scrypt` verification needs `node:crypto`, which is why
 * this is a route handler rather than something the middleware does itself.
 *
 * Three details are deliberate:
 *
 * - **An unknown email is verified against a dummy hash anyway.** Returning early
 *   would make "no such operator" measurably faster than "wrong password", which
 *   turns the login form into an oracle for who has an account.
 * - **The failure message is identical for both cases**, for the same reason.
 * - **Failures are throttled by email and address**, so a script cannot work
 *   through a password list at scrypt speed. See `lib/auth/throttle.ts` for what
 *   that does and does not cover.
 */

// Computed once so the dummy verification costs the same as a real one.
const DUMMY_HASH = hashPassword('not-a-real-password');

const credentialsSchema = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
});

function failure(message: string, status = 401): NextResponse {
  return NextResponse.json({ error: { code: 'INVALID_CREDENTIALS', message } }, { status });
}

function clientKey(request: NextRequest, email: string): string {
  // `x-forwarded-for` is only as trustworthy as the proxy in front of it, which is
  // why this keys on both the address and the email and why the throttle is
  // documented as a speed bump rather than a control.
  const forwarded = request.headers.get('x-forwarded-for') ?? '';
  const address = forwarded.split(',')[0]?.trim() ?? '';
  return `${email.trim().toLowerCase()}|${address}`;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const parsed = credentialsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_FAILED', message: 'An email and a password are required.' } },
      { status: 400 },
    );
  }

  const { email, password } = parsed.data;
  const throttle = loginThrottle();
  const key = clientKey(request, email);

  if (throttle.isLockedOut(key)) {
    const response = NextResponse.json(
      {
        error: {
          code: 'TOO_MANY_ATTEMPTS',
          message: 'Too many failed attempts. Try again shortly.',
        },
      },
      { status: 429 },
    );
    response.headers.set('retry-after', String(throttle.retryAfterSeconds(key)));
    return response;
  }

  const accounts = operatorAccounts();
  const account = findOperator(accounts, email);

  // Both branches do the same work: the dummy hash keeps an unknown email from
  // being distinguishable by how long the answer took.
  const passwordOk = verifyPassword(password, account?.passwordHash ?? DUMMY_HASH);
  if (account === undefined || !passwordOk) {
    throttle.recordFailure(key);
    return failure('Email or password is incorrect.');
  }

  let secret: string;
  try {
    secret = sessionSecret();
  } catch (cause) {
    return NextResponse.json(
      {
        error: {
          code: 'CONSOLE_MISCONFIGURED',
          message: cause instanceof Error ? cause.message : 'Session signing is not configured.',
        },
      },
      { status: 500 },
    );
  }

  const ttlMinutes = sessionTtlMinutes();
  const payload = buildSessionPayload({
    email: account.email,
    name: account.name,
    roles: account.roles,
    ttlMinutes,
  });
  const token = await signSession(payload, secret);

  throttle.recordSuccess(key);

  const response = NextResponse.json({
    operator: { email: payload.sub, name: payload.name, roles: payload.roles },
  });
  const secure = requestUsesHttps({
    protocol: request.nextUrl.protocol,
    forwardedProto: request.headers.get('x-forwarded-proto') ?? undefined,
  });
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(ttlMinutes, secure));
  return response;
}
