import "server-only";

import { AI_LIMIT_KEYS } from "@/lib/ai/commercial-policy";
import { getEntitlements, resolveAiRequestLimit } from "@/lib/entitlements";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";

export type AiUsageThreshold = "normal" | "seventy" | "ninety" | "exhausted";

export type ClinicAiCommercialUsage = {
  periodStart: string;
  managedSpentMicros: number;
  reservedMicros: number;
  budgetLimitMicros: number;
  usedPercent: number;
  requestUsed: number;
  requestLimit: number;
  requestRemaining: number;
  threshold: AiUsageThreshold;
  overageMode: "hard_cap" | "contracted";
  hasAddon: boolean;
};

function monthStartUtc(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function safeInteger(value: number | null | undefined): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : 0;
}

export function aiUsageThreshold(percent: number): AiUsageThreshold {
  if (percent >= 100) return "exhausted";
  if (percent >= 90) return "ninety";
  if (percent >= 70) return "seventy";
  return "normal";
}

/**
 * Safe clinic-facing commercial projection. It reads only plan limits, monthly
 * aggregates, and operator-entered commercial terms; no usage event, prompt,
 * actor, patient, provider credential, or conversation content is returned.
 */
export async function getClinicAiCommercialUsage(
  clinicId: string,
  now = new Date(),
): Promise<ClinicAiCommercialUsage> {
  const periodStart = monthStartUtc(now);
  const entitlements = await getEntitlements(clinicId);
  const db = createClinicScopedAdminClient(clinicId);
  const [periodResult, requestResult, termsResult] = await Promise.all([
    db
      .from("ai_budget_periods")
      .select("budget_limit_micros, reserved_micros, spent_micros")
      .eq("clinic_id", clinicId)
      .eq("period_start", periodStart)
      .maybeSingle(),
    db
      .from("usage_counters")
      .select("used, limit_snapshot")
      .eq("clinic_id", clinicId)
      .eq("period_start", periodStart)
      .eq("metric", "ai_messages")
      .maybeSingle(),
    db
      .from("ai_commercial_terms")
      .select(
        "included_budget_override_micros, addon_budget_micros, overage_mode, overage_budget_micros",
      )
      .eq("clinic_id", clinicId)
      .maybeSingle(),
  ]);
  if (periodResult.error || requestResult.error || termsResult.error) {
    throw new Error("AI commercial usage is temporarily unavailable.");
  }

  const terms = termsResult.data;
  const planBudget = safeInteger(entitlements.limits[AI_LIMIT_KEYS.creditsMonth]);
  const configuredBudget =
    safeInteger(terms?.included_budget_override_micros ?? planBudget) +
    safeInteger(terms?.addon_budget_micros) +
    safeInteger(terms?.overage_budget_micros);
  const budgetLimitMicros = Math.max(
    configuredBudget,
    safeInteger(periodResult.data?.budget_limit_micros),
  );
  const managedSpentMicros = safeInteger(periodResult.data?.spent_micros);
  const reservedMicros = safeInteger(periodResult.data?.reserved_micros);
  const committedMicros = managedSpentMicros + reservedMicros;
  const usedPercent = budgetLimitMicros > 0
    ? Math.min(100, Math.round((committedMicros / budgetLimitMicros) * 100))
    : 100;
  const requestUsed = safeInteger(requestResult.data?.used);
  const requestLimit = Math.max(
    resolveAiRequestLimit(entitlements),
    safeInteger(requestResult.data?.limit_snapshot),
  );

  return {
    periodStart,
    managedSpentMicros,
    reservedMicros,
    budgetLimitMicros,
    usedPercent,
    requestUsed,
    requestLimit,
    requestRemaining: Math.max(0, requestLimit - requestUsed),
    threshold: aiUsageThreshold(usedPercent),
    overageMode: terms?.overage_mode === "contracted" ? "contracted" : "hard_cap",
    hasAddon: safeInteger(terms?.addon_budget_micros) > 0,
  };
}
