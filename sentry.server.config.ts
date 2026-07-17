import * as Sentry from "@sentry/nextjs";
import { scrubMessagingSecrets } from "@/lib/messaging/scrub";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    debug: false,
    environment: process.env.NODE_ENV,
    // Per-tenant messaging credentials must never reach Sentry (§9.2).
    beforeSend(event) {
      return scrubMessagingSecrets(event);
    },
  });
}
