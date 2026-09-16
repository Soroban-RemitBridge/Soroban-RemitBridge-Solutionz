import { z } from 'zod';

import { ROLES, type Role } from './roles';

/**
 * Signed session cookies.
 *
 * Written against WebCrypto rather than `node:crypto` so that the *same*
 * implementation verifies a session in two very different runtimes: the Edge
 * middleware that gates every route, and the Node route handlers that authorise a
 * specific action. Two implementations of a signature check is two things to keep
 * in step, and the one that drifts is the one nobody tests.
 *
 * This is a stateless signed cookie, not a server-side session:
 *
 * - There is no session store, so there is no revocation list. A session is valid
 *   for its whole TTL, and the only ways to end one early are rotating
 *   `OPERATOR_SESSION_SECRET` (which ends *all* of them) or removing the operator
 *   from `OPERATOR_ACCOUNTS` — which stops the next login but not an existing
 *   cookie, because the cookie carries the roles it was issued with.
 * - That is an accepted trade-off for a console whose threat model is "an
 *   operator's laptop", and it is written down here rather than discovered. A
 *   console that can authorise agents against real money is the reason this
 *   module exists at all, and the reason the TTL is hours rather than days.
 *
 * The cookie is `httpOnly`, `sameSite=lax` and `secure` outside development:
 * `httpOnly` because no script needs to read it, and `lax` because the console
 * makes no cross-site state-changing requests.
 */

export const SESSION_COOKIE = 'remitbridge_operator';

/** Eight hours: one shift. Long enough to be usable, short enough to expire. */
export const DEFAULT_SESSION_TTL_MINUTES = 480;

const MIN_SECRET_LENGTH = 32;

export const sessionPayloadSchema = z.object({
  /** Operator email. The audit trail's actor. */
  sub: z.string().min(1),
  name: z.string().min(1),
  roles: z.array(z.enum(ROLES)),
  /** Issued at, epoch seconds. */
  iat: z.number().int().nonnegative(),
  /** Expires at, epoch seconds. */
  exp: z.number().int().nonnegative(),
});

export type SessionPayload = z.infer<typeof sessionPayloadSchema>;

/**
 * The signing secret.
 *
 * Throws when it is missing or too short. Both the middleware and the auth routes
 * fail closed on this rather than falling back to a default: a hardcoded fallback
 * secret is worse than an outage, because it is invisible.
 */
export function sessionSecret(env: Record<string, string | undefined> = process.env): string {
  const secret = env['OPERATOR_SESSION_SECRET'];
  if (secret === undefined || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `OPERATOR_SESSION_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters. ` +
        'The console refuses to issue or accept sessions without it.',
    );
  }
  return secret;
}

export function sessionTtlMinutes(env: Record<string, string | undefined> = process.env): number {
  const raw = env['OPERATOR_SESSION_TTL_MINUTES'];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_TTL_MINUTES;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padding = (4 - (normalized.length % 4)) % 4;
    const binary = atob(normalized + '='.repeat(padding));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

/**
 * Constant-time byte comparison.
 *
 * The signature is a MAC over data the attacker controls, and `===` on the hex
 * would leak how much of a guessed MAC matched. WebCrypto has no `timingSafeEqual`,
 * so this is the same construction `node:crypto` provides.
 */
function equalsConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

export async function signSession(
  payload: SessionPayload,
  secret: string,
): Promise<string> {
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret, 'sign'),
    new TextEncoder().encode(body),
  );
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verify a session token.
 *
 * Returns `null` for every failure — bad shape, bad signature, expired, wrong
 * secret — deliberately. A caller that can distinguish "expired" from "forged" is
 * a caller that will eventually branch on it, and there is no branch here that is
 * not "refuse".
 */
export async function verifySession(
  token: string | undefined,
  secret: string,
  now: number = Date.now(),
): Promise<SessionPayload | null> {
  if (token === undefined || token.length === 0) return null;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;
  const body = token.slice(0, separator);
  const providedSignature = base64UrlDecode(token.slice(separator + 1));
  if (providedSignature === null) return null;

  const expectedSignature = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), new TextEncoder().encode(body)),
  );
  // Signature first: parsing an unauthenticated payload would mean running zod on
  // attacker-chosen input, which is the exact place not to find out what a
  // malformed payload does.
  if (!equalsConstantTime(providedSignature, expectedSignature)) return null;

  const decoded = base64UrlDecode(body);
  if (decoded === null) return null;

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    return null;
  }

  const parsed = sessionPayloadSchema.safeParse(parsedBody);
  if (!parsed.success) return null;

  const nowSeconds = Math.floor(now / 1000);
  if (parsed.data.exp <= nowSeconds) return null;
  // A token issued in the future means a clock skew or a hand-built token; either
  // way it is not a session this server issued.
  if (parsed.data.iat > nowSeconds + 60) return null;

  return parsed.data;
}

export interface NewSessionOptions {
  email: string;
  name: string;
  roles: readonly Role[];
  ttlMinutes?: number;
  now?: number;
}

export function buildSessionPayload(options: NewSessionOptions): SessionPayload {
  const nowMs = options.now ?? Date.now();
  const ttlMinutes = options.ttlMinutes ?? DEFAULT_SESSION_TTL_MINUTES;
  return {
    sub: options.email.trim().toLowerCase(),
    name: options.name,
    roles: [...options.roles],
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + ttlMinutes * 60,
  };
}

/**
 * Whether this request arrived over HTTPS.
 *
 * Not `NODE_ENV === 'production'`. A production console almost always sits behind
 * a TLS-terminating proxy, so the process sees plain HTTP on the loopback while
 * the operator is on HTTPS — and the two mistakes that produces are both bad in
 * opposite directions: flag a cookie `Secure` when the browser is on HTTP and the
 * browser silently never sends it, so nobody can sign in; omit the flag on real
 * HTTPS and the session can leak onto a plaintext connection.
 *
 * So the answer comes from the request: `x-forwarded-proto` when a proxy set it,
 * otherwise the URL's own protocol.
 */
export function requestUsesHttps(input: {
  protocol: string;
  forwardedProto?: string | undefined;
}): boolean {
  if (input.forwardedProto !== undefined && input.forwardedProto.length > 0) {
    // A chain of proxies appends, so the first entry is the client's hop.
    return input.forwardedProto.split(',')[0]?.trim().toLowerCase() === 'https';
  }
  return input.protocol.toLowerCase() === 'https:';
}

/** Cookie attributes, in one place so the login route cannot drift from the check. */
export function sessionCookieOptions(
  ttlMinutes: number,
  isProduction: boolean,
): {
  httpOnly: true;
  sameSite: 'lax';
  path: '/';
  secure: boolean;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isProduction,
    maxAge: ttlMinutes * 60,
  };
}
