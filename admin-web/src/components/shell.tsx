'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';

/**
 * The console chrome.
 *
 * A client component because `usePathname` marks the active section and the
 * sign-out button is interactive — nothing else here is, and the pages themselves
 * stay server-rendered.
 *
 * The operator's identity arrives as a prop from `(console)/layout.tsx`, verified
 * there from the session cookie. It is displayed because the audit trail records
 * that same name against every action, and an operator should be able to see who
 * the console thinks they are before approving a float move.
 */

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/agents', label: 'Agents' },
  { href: '/liquidity', label: 'Liquidity' },
  { href: '/compliance', label: 'Compliance' },
  { href: '/corridors', label: 'Corridors' },
] as const;

export interface ShellOperator {
  name: string;
  email: string;
  roles: string[];
}

function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut(): Promise<void> {
    setPending(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      // A full navigation rather than a client-side route change: the cookie has
      // just changed, and the middleware should evaluate the next request from
      // scratch rather than from a cached client-side router state.
      router.replace('/login');
      router.refresh();
    }
  }

  return (
    <button
      type="button"
      onClick={() => void signOut()}
      disabled={pending}
      className="rounded-md border border-ink-300 px-2.5 py-1 text-xs text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900 disabled:text-ink-400"
    >
      {pending ? 'Signing out…' : 'Sign out'}
    </button>
  );
}

export function Shell({ children, operator }: { children: ReactNode; operator: ShellOperator }) {
  const pathname = usePathname();
  const environment = process.env['NEXT_PUBLIC_ENVIRONMENT_LABEL'] ?? 'local';

  return (
    <div className="min-h-screen">
      <header className="border-b border-ink-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
          <Link href="/" className="flex items-baseline gap-2">
            <span className="text-sm font-semibold tracking-tight text-ink-900">RemitBridge</span>
            <span className="text-xs text-ink-500">operator console</span>
          </Link>

          <nav className="flex flex-wrap items-center gap-1" aria-label="Sections">
            {NAV.map((item) => {
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={clsx(
                    'rounded-md px-3 py-1.5 text-sm transition-colors',
                    active
                      ? 'bg-ink-900 text-white'
                      : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {/* The environment is always on screen. "Which contracts am I about to
              authorise an agent against" is a question that should never need a
              second tab to answer. */}
          <span className="ml-auto rounded-full border border-ink-200 bg-ink-50 px-3 py-1 font-mono text-xs text-ink-600">
            env: {environment}
          </span>

          <div className="flex items-center gap-3">
            {/* Name, address and roles: the address is the value the backend's
                audit trail actually records, so an operator can confirm it before
                approving a float move rather than inferring it from their name. */}
            <span className="text-xs text-ink-600" data-testid="operator-identity">
              <span className="font-medium text-ink-900">{operator.name}</span>{' '}
              <span className="text-ink-500">
                &lt;{operator.email}&gt; ({operator.roles.join(', ')})
              </span>
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-5 py-6">{children}</main>

      <footer className="mx-auto max-w-7xl px-5 pb-10 pt-2">
        <p className="text-xs text-ink-500">
          Off-chain by design: names, documents and travel-rule data stay in the backend database.
          Only attestation hashes and amounts are ever written to the ledger.
        </p>
      </footer>
    </div>
  );
}
