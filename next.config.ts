import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

function supabaseHostname(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return "*.supabase.co";
  try {
    return new URL(url).hostname;
  } catch {
    return "*.supabase.co";
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

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://connect.facebook.net",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
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
    remotePatterns: [
      {
        protocol: "https",
        hostname: supabaseHostname(),
        pathname: "/storage/v1/object/**",
      },
    ],
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
