'use client';

import clsx from 'clsx';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * The console chrome.
 *
 * A client component only because `usePathname` needs to mark the active
 * section — nothing else here is interactive, and the pages themselves stay
 * server-rendered.
 */

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/agents', label: 'Agents' },
  { href: '/liquidity', label: 'Liquidity' },
  { href: '/compliance', label: 'Compliance' },
  { href: '/corridors', label: 'Corridors' },
] as const;

export function Shell({ children }: { children: ReactNode }) {
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
