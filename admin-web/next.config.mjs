/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: {
    // Linting is a separate, explicitly-run step (`npm run lint`, and a dedicated
    // CI job), so a lint error does not hide behind a build failure and vice
    // versa. `next build` should fail for build reasons only.
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        // The console shows recipient-adjacent and compliance data. Keep it out
        // of any index even if it is ever deployed without auth in front.
        source: '/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
