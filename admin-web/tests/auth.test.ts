import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  findOperator,
  hashPassword,
  parseOperatorAccounts,
  verifyPassword,
  type OperatorAccount,
} from '../src/lib/auth/accounts';
import { safeNextPath } from '../src/lib/auth/navigation';
import {
  may,
  permissionsFor,
  policyForMutation,
  withOperatorAttribution,
} from '../src/lib/auth/policy';
import {
  buildSessionPayload,
  requestUsesHttps,
  sessionCookieOptions,
  sessionSecret,
  sessionTtlMinutes,
  signSession,
  verifySession,
} from '../src/lib/auth/session';
import { LoginThrottle } from '../src/lib/auth/throttle';

/**
 * The console's authentication, tested where it is decided.
 *
 * Everything here is pure or takes its inputs as arguments — no Next runtime, no
 * request objects — which is what makes the interesting assertions possible: a
 * forged signature, an expired session, a role that cannot approve, and a body
 * that tries to name somebody else as the approver.
 *
 * The Playwright suite covers the browser path (redirect to the login page, the
 * action being refused). These are the cases a browser test cannot produce.
 */

const SECRET = 'a'.repeat(48);

const OPERATOR: OperatorAccount = {
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  passwordHash: hashPassword('correct horse battery staple', {
    salt: Buffer.alloc(16, 7),
  }),
  roles: ['operator'],
};

describe('password hashing', () => {
  it('verifies a password it hashed', () => {
    const hash = hashPassword('s3cret-passphrase');
    expect(verifyPassword('s3cret-passphrase', hash)).toBe(true);
  });

  it('rejects the wrong password', () => {
    const hash = hashPassword('s3cret-passphrase');
    expect(verifyPassword('s3cret-passphras', hash)).toBe(false);
    expect(verifyPassword('', hash)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', () => {
    const first = hashPassword('same-password');
    const second = hashPassword('same-password');
    expect(first).not.toBe(second);
    expect(verifyPassword('same-password', first)).toBe(true);
    expect(verifyPassword('same-password', second)).toBe(true);
  });

  it('records its parameters, so the cost can be raised without invalidating hashes', () => {
    expect(hashPassword('x', { salt: Buffer.alloc(16) })).toMatch(
      /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/,
    );
  });

  it('refuses a malformed stored hash instead of throwing', () => {
    // Configuration is allowed to be wrong; a broken entry should refuse that
    // operator rather than take the login route down for everyone.
    for (const stored of ['', 'plaintext', 'bcrypt$1$2$3$4$5', 'scrypt$a$b$c$d$e', 'scrypt$16384$8$1$s$']) {
      expect(verifyPassword('anything', stored)).toBe(false);
    }
  });

  it('refuses an absurd scrypt cost rather than allocating for it', () => {
    expect(verifyPassword('x', 'scrypt$99999999$8$1$AAAA$AAAA')).toBe(false);
    // N must be a power of two for scrypt.
    expect(verifyPassword('x', 'scrypt$16383$8$1$AAAA$AAAA')).toBe(false);
  });
});

describe('parseOperatorAccounts', () => {
  it('parses a valid list and lower-cases the email', () => {
    const accounts = parseOperatorAccounts(
      JSON.stringify([
        { email: 'Ada@Example.COM', name: 'Ada', passwordHash: OPERATOR.passwordHash, roles: ['admin'] },
      ]),
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.email).toBe('ada@example.com');
    expect(accounts[0]?.roles).toEqual(['admin']);
  });

  it('treats an absent list as no operators rather than an error', () => {
    expect(parseOperatorAccounts(undefined)).toEqual([]);
    expect(parseOperatorAccounts('   ')).toEqual([]);
  });

  it('fails loudly on a malformed list instead of dropping entries', () => {
    // A silently dropped operator is indistinguishable from a wrong password,
    // which is the least debuggable failure this module could produce.
    const bad: [string, RegExp][] = [
      ['not json', /not valid JSON/],
      ['{"email":"a@b.c"}', /must be a JSON array/],
      ['[42]', /must be an object/],
      ['[{"email":"nope","name":"n","passwordHash":"scrypt$1$8$1$a$b","roles":["admin"]}]', /must be an email/],
      [
        `[{"email":"a@b.c","name":"n","passwordHash":"${OPERATOR.passwordHash}","roles":["admin"]},{"email":"A@B.C","name":"n","passwordHash":"${OPERATOR.passwordHash}","roles":["admin"]}]`,
        /duplicate entry/,
      ],
      [`[{"email":"a@b.c","name":"","passwordHash":"${OPERATOR.passwordHash}","roles":["admin"]}]`, /name must be a non-empty/],
      ['[{"email":"a@b.c","name":"n","passwordHash":"hunter2","roles":["admin"]}]', /scrypt/],
      [`[{"email":"a@b.c","name":"n","passwordHash":"${OPERATOR.passwordHash}","roles":[]}]`, /non-empty array/],
      [
        `[{"email":"a@b.c","name":"n","passwordHash":"${OPERATOR.passwordHash}","roles":["superuser"]}]`,
        /not one of viewer, operator, admin/,
      ],
    ];
    for (const [raw, pattern] of bad) {
      expect(() => parseOperatorAccounts(raw)).toThrowError(pattern);
    }
  });

  it('finds an operator regardless of the case typed at the login form', () => {
    expect(findOperator([OPERATOR], '  ADA@example.com ')?.name).toBe('Ada Lovelace');
    expect(findOperator([OPERATOR], 'grace@example.com')).toBeUndefined();
  });
});

describe('the hash generator script', () => {
  const script = fileURLToPath(new URL('../scripts/operator-hash.mjs', import.meta.url));

  it('produces a hash this module verifies', () => {
    // The script and `accounts.ts` both implement the format on purpose — it has
    // to run without a build step. This is what stops them drifting: a drift is a
    // red build here rather than a lockout against a live deployment.
    const printed = execFileSync(process.execPath, [script, 'a-passphrase'], {
      encoding: 'utf8',
    }).trim();
    expect(verifyPassword('a-passphrase', printed)).toBe(true);
    expect(verifyPassword('a-passphras', printed)).toBe(false);
  });

  it('emits a ready-to-paste OPERATOR_ACCOUNTS entry with --json', () => {
    const printed = execFileSync(process.execPath, [script, 'a-passphrase', '--json'], {
      encoding: 'utf8',
    });
    const entry = parseOperatorAccounts(`[${printed.trim()}]`);
    expect(entry).toHaveLength(1);
    expect(entry[0]?.roles).toEqual(['operator']);
    expect(verifyPassword('a-passphrase', entry[0]?.passwordHash ?? '')).toBe(true);
  });

  it('explains itself and fails when given no password', () => {
    let failed = false;
    try {
      execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      failed = true;
      const stderr = (error as { stderr?: string }).stderr ?? '';
      expect(stderr).toMatch(/Usage: node scripts\/operator-hash\.mjs/);
    }
    expect(failed).toBe(true);
  });
});

describe('session signing', () => {
  const payload = buildSessionPayload({
    email: 'Ada@Example.com',
    name: 'Ada Lovelace',
    roles: ['operator'],
    now: 1_700_000_000_000,
    ttlMinutes: 60,
  });

  it('round-trips a session, normalising the subject', async () => {
    const token = await signSession(payload, SECRET);
    const verified = await verifySession(token, SECRET, 1_700_000_100_000);
    expect(verified).toEqual({ ...payload, sub: 'ada@example.com' });
  });

  it('rejects a tampered payload', async () => {
    const token = await signSession(payload, SECRET);
    const [body, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    decoded['roles'] = ['admin'];
    const forgedBody = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    expect(await verifySession(`${forgedBody}.${signature ?? ''}`, SECRET)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signSession(payload, 'b'.repeat(48));
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it('rejects an expired session', async () => {
    const token = await signSession(payload, SECRET);
    // exp is iat + 3600, so one second past it is out.
    expect(await verifySession(token, SECRET, 1_700_003_601_000)).toBeNull();
    expect(await verifySession(token, SECRET, 1_700_003_599_000)).not.toBeNull();
  });

  it('rejects a session issued in the future', async () => {
    const future = buildSessionPayload({
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      roles: ['operator'],
      now: Date.now() + 10 * 60_000,
    });
    expect(await verifySession(await signSession(future, SECRET), SECRET)).toBeNull();
  });

  it('rejects anything that is not a token', async () => {
    for (const token of [undefined, '', 'no-dot', '.signature', 'body.', 'body.!!!not-base64!!!']) {
      expect(await verifySession(token, SECRET)).toBeNull();
    }
  });

  it('rejects a correctly signed payload that is not a session', async () => {
    const body = Buffer.from(JSON.stringify({ sub: 'x' }), 'utf8').toString('base64url');
    const signature = await crypto.subtle.sign(
      'HMAC',
      await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      ),
      new TextEncoder().encode(body),
    );
    const token = `${body}.${Buffer.from(signature).toString('base64url')}`;
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it('builds a payload whose expiry follows the TTL', () => {
    const built = buildSessionPayload({
      email: 'ada@example.com',
      name: 'Ada',
      roles: ['viewer'],
      now: 1_000_000,
      ttlMinutes: 30,
    });
    expect(built.exp - built.iat).toBe(30 * 60);
  });

  it('derives the Secure flag from the request, not from NODE_ENV', () => {
    // Behind a TLS-terminating proxy the process sees http while the operator is
    // on https, so `NODE_ENV` would answer the wrong question in both directions.
    expect(requestUsesHttps({ protocol: 'http:', forwardedProto: 'https' })).toBe(true);
    expect(requestUsesHttps({ protocol: 'http:', forwardedProto: 'https, http' })).toBe(true);
    expect(requestUsesHttps({ protocol: 'http:', forwardedProto: 'http' })).toBe(false);
    expect(requestUsesHttps({ protocol: 'http:' })).toBe(false);
    expect(requestUsesHttps({ protocol: 'https:' })).toBe(true);
    expect(requestUsesHttps({ protocol: 'http:', forwardedProto: '' })).toBe(false);
  });

  it('sets cookie attributes that cannot be changed by a script', () => {
    expect(sessionCookieOptions(480, false)).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: false,
      maxAge: 480 * 60,
    });
    expect(sessionCookieOptions(480, true).secure).toBe(true);
  });

  it('refuses to run without a strong secret', () => {
    expect(() => sessionSecret({})).toThrowError(/OPERATOR_SESSION_SECRET/);
    expect(() => sessionSecret({ OPERATOR_SESSION_SECRET: 'too-short' })).toThrowError(
      /at least 32 characters/,
    );
    expect(sessionSecret({ OPERATOR_SESSION_SECRET: SECRET })).toBe(SECRET);
  });

  it('falls back to the default TTL rather than trusting nonsense', () => {
    expect(sessionTtlMinutes({})).toBe(480);
    expect(sessionTtlMinutes({ OPERATOR_SESSION_TTL_MINUTES: '0' })).toBe(480);
    expect(sessionTtlMinutes({ OPERATOR_SESSION_TTL_MINUTES: '-5' })).toBe(480);
    expect(sessionTtlMinutes({ OPERATOR_SESSION_TTL_MINUTES: 'abc' })).toBe(480);
    expect(sessionTtlMinutes({ OPERATOR_SESSION_TTL_MINUTES: '15' })).toBe(15);
  });
});

describe('permissions', () => {
  it('gives a viewer no mutations at all', () => {
    expect([...permissionsFor(['viewer'])]).toEqual([]);
    expect(may(['viewer'], 'liquidity:propose')).toBe(false);
  });

  it('lets an operator move float, but not revoke a compliance record', () => {
    // Deciding and executing are separate permissions on purpose, so a deployment
    // that wants four-eyes on execution can say so without touching code.
    expect(may(['operator'], 'liquidity:propose')).toBe(true);
    expect(may(['operator'], 'liquidity:decide')).toBe(true);
    expect(may(['operator'], 'liquidity:execute')).toBe(true);
    expect(may(['operator'], 'liquidity:sweep')).toBe(true);
    expect(may(['operator'], 'kyc:revoke')).toBe(false);
  });

  it('lets an admin do everything, and unions multiple roles', () => {
    expect(may(['admin'], 'kyc:revoke')).toBe(true);
    expect(may(['viewer', 'operator'], 'liquidity:decide')).toBe(true);
  });
});

describe('mutation policy', () => {
  it('maps each mutation to the permission it needs', () => {
    expect(policyForMutation(['agents', 'liquidity', 'top-ups'])).toMatchObject({
      permission: 'liquidity:propose',
      auditFields: ['requestedBy'],
    });
    expect(
      policyForMutation(['agents', 'liquidity', 'top-ups', 'tp_1', 'decision']),
    ).toMatchObject({
      permission: 'liquidity:decide',
      auditFields: ['approvedBy'],
    });
    expect(policyForMutation(['agents', 'liquidity', 'top-ups', 'tp_1', 'execute'])).toMatchObject({
      permission: 'liquidity:execute',
      auditFields: [],
    });
    expect(policyForMutation(['agents', 'liquidity', 'sweep'])).toMatchObject({
      permission: 'liquidity:sweep',
      auditFields: [],
    });
    expect(policyForMutation(['kyc', 'revocations'])).toMatchObject({
      permission: 'kyc:revoke',
      auditFields: [],
    });
  });

  it('does not let a sub-path inherit a broader policy', () => {
    // A prefix match would have granted `decide` to anyone who can `propose`,
    // which is the whole separation between asking for float and releasing it.
    expect(policyForMutation(['agents', 'liquidity', 'top-ups', 'tp_1'])).toBeNull();
    expect(policyForMutation(['agents', 'liquidity', 'top-ups', 'tp_1', 'decision', 'extra'])).toBeNull();
  });

  it('fails closed on an action nobody has declared a policy for', () => {
    expect(policyForMutation(['agents', 'GABC', 'revoke'])).toBeNull();
    expect(policyForMutation([])).toBeNull();
  });
});

describe('audit attribution', () => {
  const actor = { email: 'ada@example.com' };
  const propose = policyForMutation(['agents', 'liquidity', 'top-ups']);
  const decide = policyForMutation(['agents', 'liquidity', 'top-ups', 'tp_1', 'decision']);
  const revoke = policyForMutation(['kyc', 'revocations']);

  it('writes the signed-in operator into the field the route records', () => {
    const body = withOperatorAttribution('{"amount":"2500"}', propose!, actor);
    expect(JSON.parse(body)).toEqual({ amount: '2500', requestedBy: 'ada@example.com' });
  });

  it('discards a client-supplied attribution, including for the other field', () => {
    // This is the point of the whole exercise: before, the browser sent
    // `requestedBy: 'operator-console'` and could have sent any name at all.
    const body = withOperatorAttribution(
      '{"amount":"1","requestedBy":"grace@example.com","approvedBy":"grace@example.com"}',
      decide!,
      actor,
    );
    expect(JSON.parse(body)).toEqual({ amount: '1', approvedBy: 'ada@example.com' });
  });

  it('leaves a route with no audit fields untouched', () => {
    const raw = '{"subjectAddress":"GABC","reason":"sanctions_match"}';
    expect(withOperatorAttribution(raw, revoke!, actor)).toBe(raw);
  });

  it('leaves a body it cannot understand to the backend to reject', () => {
    // Rewriting a malformed body here would turn the backend's validation error
    // into a confusing failure in the proxy.
    for (const raw of ['not json', '[1,2,3]', '"a string"', 'null']) {
      expect(withOperatorAttribution(raw, propose!, actor)).toBe(raw);
    }
  });
});

describe('post-login destination', () => {
  it('accepts a relative path', () => {
    expect(safeNextPath('/liquidity?regionId=NG_LAG')).toBe('/liquidity?regionId=NG_LAG');
  });

  it('refuses anything that would leave the site', () => {
    // An accepted absolute URL turns the sign-in page into a phishing vector.
    for (const value of ['https://evil.example/login', 'http://evil.example', '//evil.example', 'javascript:alert(1)']) {
      expect(safeNextPath(value)).toBe('/');
    }
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath(undefined, '/agents')).toBe('/agents');
  });
});

describe('login throttle', () => {
  const key = 'ada@example.com|203.0.113.7';

  it('allows attempts until the window fills, then locks the key', () => {
    const throttle = new LoginThrottle({ maxFailures: 3, windowMs: 60_000 });
    const now = 1_000_000;

    expect(throttle.isLockedOut(key, now)).toBe(false);
    throttle.recordFailure(key, now);
    throttle.recordFailure(key, now);
    expect(throttle.isLockedOut(key, now)).toBe(false);
    throttle.recordFailure(key, now);

    expect(throttle.isLockedOut(key, now)).toBe(true);
    expect(throttle.retryAfterSeconds(key, now)).toBe(60);
  });

  it('forgets failures once the window has passed', () => {
    const throttle = new LoginThrottle({ maxFailures: 2, windowMs: 60_000 });
    throttle.recordFailure(key, 1_000_000);
    throttle.recordFailure(key, 1_000_000);
    expect(throttle.isLockedOut(key, 1_000_000)).toBe(true);
    expect(throttle.isLockedOut(key, 1_060_001)).toBe(false);
  });

  it('keys separately, so one locked operator does not lock another', () => {
    const throttle = new LoginThrottle({ maxFailures: 1, windowMs: 60_000 });
    throttle.recordFailure(key, 1_000);
    expect(throttle.isLockedOut(key, 1_000)).toBe(true);
    expect(throttle.isLockedOut('grace@example.com|203.0.113.7', 1_000)).toBe(false);
  });

  it('clears a key on success, so one typo does not count toward a lockout', () => {
    const throttle = new LoginThrottle({ maxFailures: 2, windowMs: 60_000 });
    throttle.recordFailure(key, 1_000);
    throttle.recordSuccess(key);
    throttle.recordFailure(key, 1_000);
    expect(throttle.isLockedOut(key, 1_000)).toBe(false);
  });

  it('reports no delay for a key that is not locked', () => {
    const throttle = new LoginThrottle({ maxFailures: 3, windowMs: 60_000 });
    expect(throttle.retryAfterSeconds('unused|1.2.3.4', 1_000)).toBe(0);
  });
});
