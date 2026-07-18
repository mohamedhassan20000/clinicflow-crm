import "server-only";
import * as Sentry from "@sentry/nextjs";
import { checkUsageLimit, type UsageLimitResolution } from "@/lib/entitlements";
import { incrementClinicUsage, releaseClinicUsage } from "@/lib/supabase/admin";
import { AiToolAuthorizationError } from "@/lib/ai/errors";

/**
 * Per-tenant AI usage gating (§6.7). The surface (P4B route) calls
 * reserveAiTurn atomically increments before the model call. Failed and aborted
 * streams compensate through releaseAiTurn; successful streams retain the
 * reservation as their counted usage unit.
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

export type AiTurnReservation = {
  used: number;
  limit: number;
  remaining: number;
  periodStart: string;
};

function isUsageLimitError(error: { message?: string } | null): boolean {
  return error?.message?.includes("USAGE_LIMIT_EXCEEDED") === true;
}

/**
 * Atomically claims one unit before generation. assertAiTurnAllowed provides
 * the typed subscription/limit result; increment_usage is the database-backed
 * compare-and-increment that closes the concurrent-request race.
 */
export async function reserveAiTurn(clinicId: string): Promise<AiTurnReservation> {
  const now = new Date();
  const periodStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const resolution = await assertAiTurnAllowed(clinicId, now);
  try {
    const { data, error } = await incrementClinicUsage(
      clinicId,
      AI_USAGE_METRIC,
      1,
      periodStart,
    );
    if (error) {
      if (isUsageLimitError(error)) {
        throw new AiToolAuthorizationError("usage_limit_reached");
      }
      Sentry.captureMessage("AI usage reservation failed", {
        level: "error",
        extra: { clinicId, error: error.message },
      });
      throw new AiToolAuthorizationError(
        "lookup_failed",
        "AI usage is temporarily unavailable. Please try again.",
      );
    }
    const used = typeof data === "number" ? data : resolution.used + 1;
    return {
      used,
      limit: resolution.limit,
      remaining: Math.max(0, resolution.limit - used),
      periodStart,
    };
  } catch (error) {
    if (error instanceof AiToolAuthorizationError) throw error;
    Sentry.captureException(error, {
      tags: { area: "ai-usage-reservation" },
      extra: { clinicId },
    });
    throw new AiToolAuthorizationError(
      "lookup_failed",
      "AI usage is temporarily unavailable. Please try again.",
    );
  }
}

/** Compensates one failed/aborted reservation without masking the stream error. */
export async function releaseAiTurn(clinicId: string, periodStart: string): Promise<void> {
  try {
    const { error } = await releaseClinicUsage(
      clinicId,
      AI_USAGE_METRIC,
      1,
      periodStart,
    );
    if (error) {
      Sentry.captureMessage("AI usage reservation release failed", {
        level: "error",
        extra: { clinicId, error: error.message },
      });
    }
  } catch (error) {
    Sentry.captureException(error, {
      tags: { area: "ai-usage-release" },
      extra: { clinicId },
    });
  }
}
