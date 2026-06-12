/** @type {import('next').NextConfig} */

// Where the existing Express API lives. Override with API_ORIGIN if needed.
const API_ORIGIN = process.env.API_ORIGIN || "http://localhost:3000";

const nextConfig = {
  reactStrictMode: true,
  // This frontend has its own lockfile; pin the tracing root to silence the
  // multi-lockfile workspace-root inference warning.
  outputFileTracingRoot: import.meta.dirname,
  // Proxy all /api/* calls to the Express backend so the frontend can use
  // same-origin relative URLs (no CORS) exactly like the legacy app did.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` },
      // team logos are served by Express from /img
      { source: "/img/:path*", destination: `${API_ORIGIN}/img/:path*` },
    ];
  },
};

export default nextConfig;
