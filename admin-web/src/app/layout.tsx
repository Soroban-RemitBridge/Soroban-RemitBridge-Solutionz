import type { Metadata } from 'next';

import { Shell } from '@/components/shell';

import './globals.css';

export const metadata: Metadata = {
  title: 'RemitBridge — operator console',
  description:
    'Anchor-operator console for the RemitBridge agent network: agent onboarding, per-corridor compliance tiers, float and pool health.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
