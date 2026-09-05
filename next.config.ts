import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

type SupabaseImagePattern = {
  protocol: "http" | "https";
  hostname: string;
  port?: string;
  pathname: string;
};

/**
 * Allow `next/image` to optimize objects from the Supabase project this build
 * is configured against — including a local stack, which is served over plain
 * `http` on a non-default port. Deployed environments resolve to
 * `https://<ref>.supabase.co` with no port, i.e. the previous behaviour.
 */
function supabaseImagePattern(): SupabaseImagePattern {
  const fallback: SupabaseImagePattern = {
    protocol: "https",
    hostname: "*.supabase.co",
    pathname: "/storage/v1/object/**",
  };
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return fallback;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fallback;
    return {
      protocol: parsed.protocol === "http:" ? "http" : "https",
      hostname: parsed.hostname,
      ...(parsed.port ? { port: parsed.port } : {}),
      pathname: "/storage/v1/object/**",
    };
  } catch {
    return fallback;
  }
}

/**
 * The image optimizer refuses upstreams that resolve to a private IP (an SSRF
 * guard). A local Supabase stack is served from loopback, so optimizing its
 * objects requires opting out — and only then. This stays `false` for every
 * hosted Supabase URL, so the guard is fully intact in deployed environments.
 */
function supabaseIsLoopback(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function supabaseImageSource(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return "";
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function supabaseConnectSources(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return "";
  try {
    const parsed = new URL(url);
    const websocketProtocol = parsed.protocol === "http:" ? "ws:" : "wss:";
    return `${parsed.origin} ${websocketProtocol}//${parsed.host}`;
  } catch {
    return "";
  }
}

/**
 * HSTS is emitted for real builds only. `next dev --experimental-https` (the
 * local HTTPS mode Meta's Embedded Signup / `FB.login` requires — the SDK
 * refuses to run on an `http` page) would otherwise pin HSTS against the
 * `localhost` host, and HSTS is port-agnostic: a single visit to
 * `https://localhost:3000` would force *every* `http://localhost:PORT` project
 * on this machine to HTTPS for two years, with no per-site override.
 *
 * Deployed environments are unaffected — `next build`/`next start` and Vercel
 * both run with NODE_ENV=production, so the header is byte-identical to before.
 */
const isProductionBuild = process.env.NODE_ENV === "production";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Voice notes are recorded only after an explicit Inbox gesture; camera and
  // geolocation remain unavailable everywhere.
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
  ...(isProductionBuild
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://connect.facebook.net",
      "style-src 'self' 'unsafe-inline'",
      // `https:` already covers every deployed Supabase project; the explicit
      // origin is what lets a local `http://127.0.0.1:54321` stack serve the
      // same assets to non-optimized `<img>` tags (print headers).
      `img-src 'self' data: blob: https: ${supabaseImageSource()}`.trim(),
      // Local voice previews are Blob URLs. Persisted outbound audio still uses
      // the private Supabase signed-link path, while inbound audio is served by
      // the same-origin authenticated range endpoint.
      `media-src 'self' blob: ${supabaseImageSource()} https://*.supabase.co`.trim(),
      "font-src 'self' data:",
      // Supabase REST + Storage + Realtime; Sentry error reporting (optional, no-op without DSN)
      `connect-src 'self' ${supabaseConnectSources()} https://*.supabase.co wss://*.supabase.co https://*.sentry.io https://graph.facebook.com https://www.facebook.com https://web.facebook.com`,
      "frame-src 'self' https://www.facebook.com https://web.facebook.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // P7-1: keep the Chromium binary outside the bundled server chunk and trace
  // the exact local document fonts used by the offline PDF renderer.
  serverExternalPackages: ["@sparticuz/chromium"],
  outputFileTracingIncludes: {
    "/*": ["./app/fonts/manrope/*.woff2", "./app/fonts/thmanyah/*.woff2"],
  },
  images: {
    remotePatterns: [supabaseImagePattern()],
    dangerouslyAllowLocalIP: supabaseIsLoopback(),
  },
  experimental: {
    // Future-proofing for Phase 1 Server Actions that hit Supabase.
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

const intlConfig = withNextIntl(nextConfig);

// Sentry is a no-op if NEXT_PUBLIC_SENTRY_DSN is not set.
export default process.env.NEXT_PUBLIC_SENTRY_DSN
  ? withSentryConfig(intlConfig, {
      silent: true,
      disableLogger: true,
      widenClientFileUpload: true,
    })
  : intlConfig;
