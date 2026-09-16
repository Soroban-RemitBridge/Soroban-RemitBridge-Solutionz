import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { Shell } from '@/components/shell';
import { SESSION_COOKIE, sessionSecret, verifySession } from '@/lib/auth/session';

/**
 * The authenticated shell.
 *
 * This is a route group rather than a wrapper on each page, so a page added under
 * `(console)/` is inside the console chrome — and inside the session check —
 * without its author having to remember anything. URLs are unchanged: `(console)`
 * is a grouping folder, not a path segment.
 *
 * The `redirect` here is a second line of defence behind the middleware, and it is
 * not redundant. The middleware decides by path (`matcher`), and a matcher is a
 * routing convenience; this decides by *what is being rendered*, from the same
 * verified session. If the matcher is ever narrowed, this still holds.
 *
 * The operator is read here and passed down rather than fetched again in the
 * header component, so the name on screen and the identity in the audit log come
 * from one verification of one cookie.
 */
export const dynamic = 'force-dynamic';

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;

  let session = null;
  try {
    session = await verifySession(token, sessionSecret());
  } catch {
    // A missing or too-short OPERATOR_SESSION_SECRET. Treated as "not signed in"
    // here; the middleware answers those requests with an explicit 500 first, so
    // this path is only reached in a test or a direct render.
    session = null;
  }

  if (session === null) redirect('/login');

  return (
    <Shell operator={{ name: session.name, email: session.sub, roles: [...session.roles] }}>
      {children}
    </Shell>
  );
}
