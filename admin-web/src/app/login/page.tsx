import type { Metadata } from 'next';

import { operatorAccounts } from '@/lib/auth/accounts';
import { safeNextPath } from '@/lib/auth/navigation';

import { LoginForm } from './login-form';

/**
 * Sign in.
 *
 * Outside the `(console)` route group on purpose: this page is the public face of
 * an otherwise protected app, so it renders without the console navigation and
 * without an operator identity in the header.
 *
 * The page reads whether any operators are configured and says so plainly. The
 * alternative — "email or password is incorrect" against an empty account list —
 * sends someone to look for a typo in a password that was never the problem.
 */

export const metadata: Metadata = {
  title: 'Sign in — RemitBridge operator console',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

function configuredOperatorCount(): number {
  try {
    return operatorAccounts().length;
  } catch {
    // A malformed OPERATOR_ACCOUNTS is reported by the form rather than crashing
    // the page, so the person deploying it can still reach the console to fix it.
    return -1;
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const count = configuredOperatorCount();

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-12">
      <div className="mb-6">
        <h1 className="text-lg font-semibold tracking-tight text-ink-900">
          RemitBridge operator console
        </h1>
        <p className="mt-1 text-sm text-ink-600">
          Every action in this console is recorded against the operator who took it, so sign in with
          your own account.
        </p>
      </div>

      {count === 0 && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          No operators are configured, so nobody can sign in. Set{' '}
          <code className="font-mono">OPERATOR_ACCOUNTS</code> and{' '}
          <code className="font-mono">OPERATOR_SESSION_SECRET</code> — see the console section of
          the README.
        </div>
      )}
      {count < 0 && (
        <div className="mb-4 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-900">
          <code className="font-mono">OPERATOR_ACCOUNTS</code> is not valid JSON, so no operator can
          be looked up. The boot log names the offending entry.
        </div>
      )}

      <LoginForm next={safeNextPath(next)} />
    </main>
  );
}
