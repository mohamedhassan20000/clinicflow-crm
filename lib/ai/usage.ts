import "server-only";
import * as Sentry from "@sentry/nextjs";
import { checkUsageLimit, type UsageLimitResolution } from "@/lib/entitlements";
import { AiToolAuthorizationError } from "@/lib/ai/errors";

/**
 * Per-tenant AI usage eligibility (§6.7). P4.5A performs the authoritative
 * compare-and-reserve inside reserve_ai_budget, which atomically claims this
 * legacy request unit together with the managed-cost ceiling.
 */

export const AI_USAGE_METRIC = "ai_messages" as const;

export async function checkAiTurn(clinicId: string): Promise<UsageLimitResolution> {
  return checkUsageLimit(clinicId, AI_USAGE_METRIC);
}

export async function assertAiTurnAllowed(
  clinicId: string,
  now = new Date(),
): Promise<UsageLimitResolution> {
  const resolution = await checkUsageLimit(clinicId, AI_USAGE_METRIC, 1, now);
  if (!resolution.allowed) {
    if (resolution.reason === "lookup_failed") {
      Sentry.captureMessage("AI usage limit lookup failed", {
        level: "error",
        extra: { clinicId },
      });
      throw new AiToolAuthorizationError(
        "lookup_failed",
        "AI usage is temporarily unavailable. Please try again.",
      );
    }
    throw new AiToolAuthorizationError(
      resolution.reason === "subscription_inactive"
        ? "subscription_inactive"
        : "usage_limit_reached",
      `AI usage not permitted (${resolution.reason}).`,
    );
  }
  return resolution;
}
