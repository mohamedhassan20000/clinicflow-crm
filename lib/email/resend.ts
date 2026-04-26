import "server-only";
import { Resend } from "resend";

let cached: Resend | null = null;

/**
 * Lazily-initialised Resend client. Throws if RESEND_API_KEY is missing so
 * misconfiguration surfaces at the call site instead of producing a silently
 * broken `Resend("undefined")`.
 */
export function getResend(): Resend {
  if (cached) return cached;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error(
      "RESEND_API_KEY is not set. Add it in .env.local (and the Vercel project envs).",
    );
  }
  cached = new Resend(apiKey);
  return cached;
}

/** Default sender — override per-call when needed. */
export const DEFAULT_FROM =
  process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev";
