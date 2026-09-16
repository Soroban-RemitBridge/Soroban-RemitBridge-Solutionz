import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'RemitBridge — operator console',
  description:
    'Anchor-operator console for the RemitBridge agent network: agent onboarding, per-corridor compliance tiers, float and pool health.',
  robots: { index: false, follow: false },
};

/**
 * The document root.
 *
 * The console chrome lives in `(console)/layout.tsx` rather than here, because the
 * sign-in screen is not part of the console and should not render its navigation.
 * Anything wrapped in this layout is public; anything under `(console)/` is not.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
