import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // Future-proofing for Phase 1 Server Actions that hit Supabase.
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

// Sentry is a no-op if NEXT_PUBLIC_SENTRY_DSN is not set.
export default process.env.NEXT_PUBLIC_SENTRY_DSN
  ? withSentryConfig(nextConfig, {
      silent: true,
      disableLogger: true,
      widenClientFileUpload: true,
    })
  : nextConfig;
