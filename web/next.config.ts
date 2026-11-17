import type { NextConfig } from 'next';

// Static export (decision 2): `next build` writes a fully static site to
// web/out which the Fastify server serves at /ui (api/routes/ui.ts) with the
// bridge's cache semantics. The app is a pure client-side dashboard — no SSR
// data fetching, no Server Actions, no db access — so the export works.
//
// basePath '/ui' (decision 2 URL parity): without it the export emits
// root-absolute asset refs (/_next/...) which 404 behind the /ui mount. With
// it, the export references /ui/_next/... — served by the Fastify /ui/* route.
// Client fetches stay origin-rooted relative URLs (/api/...), so the API is
// NOT under the base path.
//
// Dev ergonomics: `next dev` proxies the legacy-compatible API paths to the
// new Fastify server (default 127.0.0.1:3006, decision 5) so the dashboard
// and the backend run as two processes with same-origin relative URLs —
// exactly the URL shape the statically-served /ui uses at cutover. Rewrites
// are dev-only (meaningless in a static export) and marked basePath:false —
// they match the origin-rooted fetch URLs, not the /ui-prefixed page routes.
const apiTarget = process.env.LOBBY_API_TARGET ?? 'http://127.0.0.1:3006';

const nextConfig: NextConfig = {
  output: 'export',
  basePath: '/ui',
  ...(process.env.NODE_ENV === 'development'
    ? {
        async rewrites() {
          return [
            { source: '/api/:path*', destination: `${apiTarget}/api/:path*`, basePath: false },
            { source: '/send', destination: `${apiTarget}/send`, basePath: false },
            { source: '/prompt', destination: `${apiTarget}/prompt`, basePath: false },
          ];
        },
      }
    : {}),
};

export default nextConfig;
