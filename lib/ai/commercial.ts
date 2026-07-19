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
  /**
   * False when the clinic has no managed cost allowance configured at all
   * (plan credit limit and operator terms both zero). This is distinct from a
   * configured allowance that has been fully consumed; the UI must not present
   * an unconfigured allowance as "exhausted".
   */
  managedAllowanceConfigured: boolean;
  usedPercent: number;
  requestUsed: number;
  requestLimit: number;
  requestRemaining: number;
  threshold: AiUsageThreshold;
  overageMode: "hard_cap" | "contracted";
  hasAddon: boolean;
  /**
   * Clinic-owned (strict BYOK / hybrid direct) provider usage, kept strictly
   * separate from the managed allowance. The cost is ClinicFlow's internal
   * estimate derived from actual provider token responses and configured model
   * pricing — it is billed by the clinic's own provider and is NOT the provider
   * invoice, nor any statement of the clinic's remaining provider balance.
   */
  byokRequestUsed: number;
  byokEstimatedCostMicros: number;
};

type PeriodRow = {
  budget_limit_micros: number | null;
  reserved_micros: number | null;
  spent_micros: number | null;
} | null;

type RequestCounterRow = {
  used: number | null;
  limit_snapshot: number | null;
} | null;

type CommercialTermsRow = {
  included_budget_override_micros: number | null;
  addon_budget_micros: number | null;
  overage_mode: string | null;
  overage_budget_micros: number | null;
} | null;

function monthStartUtc(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function nextMonthStartUtc(now: Date): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const next = month === 11 ? `${year + 1}-01-01` : `${year}-${String(month + 2).padStart(2, "0")}-01`;
  return next;
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
 * Pure commercial projection. Separates request-count (fair-use) allowance from
 * the cost-weighted managed allowance, and keeps clinic-owned BYOK usage in its
 * own bucket. Extracted from the IO wrapper so the arithmetic — in particular
 * the "unconfigured vs exhausted" distinction — is unit-testable without a
 * database.
 */
export function computeClinicAiCommercialUsage(input: {
  periodStart: string;
  planBudgetMicros: number;
  requestPlanLimit: number;
  period: PeriodRow;
  requestCounter: RequestCounterRow;
  terms: CommercialTermsRow;
  byokRequestUsed: number;
  byokEstimatedCostMicros: number;
}): ClinicAiCommercialUsage {
  const terms = input.terms;
  const planBudget = safeInteger(input.planBudgetMicros);
  const configuredBudget =
    safeInteger(terms?.included_budget_override_micros ?? planBudget) +
    safeInteger(terms?.addon_budget_micros) +
    safeInteger(terms?.overage_budget_micros);
  const budgetLimitMicros = Math.max(
    configuredBudget,
    safeInteger(input.period?.budget_limit_micros),
  );
  const managedAllowanceConfigured = budgetLimitMicros > 0;
  const managedSpentMicros = safeInteger(input.period?.spent_micros);
  const reservedMicros = safeInteger(input.period?.reserved_micros);
  const committedMicros = managedSpentMicros + reservedMicros;
  // An unconfigured managed allowance reads as 0% / "not configured", never as
  // a false 100% "exhausted". A configured allowance still saturates at 100%.
  const usedPercent = managedAllowanceConfigured
    ? Math.min(100, Math.round((committedMicros / budgetLimitMicros) * 100))
    : 0;
  const requestUsed = safeInteger(input.requestCounter?.used);
  const requestLimit = Math.max(
    safeInteger(input.requestPlanLimit),
    safeInteger(input.requestCounter?.limit_snapshot),
  );

  return {
    periodStart: input.periodStart,
    managedSpentMicros,
    reservedMicros,
    budgetLimitMicros,
    managedAllowanceConfigured,
    usedPercent,
    requestUsed,
    requestLimit,
    requestRemaining: Math.max(0, requestLimit - requestUsed),
    threshold: managedAllowanceConfigured ? aiUsageThreshold(usedPercent) : "normal",
    overageMode: terms?.overage_mode === "contracted" ? "contracted" : "hard_cap",
    hasAddon: safeInteger(terms?.addon_budget_micros) > 0,
    byokRequestUsed: safeInteger(input.byokRequestUsed),
    byokEstimatedCostMicros: safeInteger(input.byokEstimatedCostMicros),
  };
}

/**
 * Safe clinic-facing commercial projection. It reads only plan limits, monthly
 * aggregates, operator-entered commercial terms, and content-free BYOK cost/
 * count from the immutable ledger; no prompt, actor, patient, provider
 * credential, or conversation content is returned.
 */
export async function getClinicAiCommercialUsage(
  clinicId: string,
  now = new Date(),
): Promise<ClinicAiCommercialUsage> {
  const periodStart = monthStartUtc(now);
  const periodEnd = nextMonthStartUtc(now);
  const entitlements = await getEntitlements(clinicId);
  const db = createClinicScopedAdminClient(clinicId);
  const [periodResult, requestResult, termsResult, byokResult] = await Promise.all([
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
    // Content-free BYOK usage: only the direct-billed provider attempts for the
    // current period. Aggregated in-process because it is a single clinic/month.
    db
      .from("ai_usage_events")
      .select("request_id, final_cost_micros")
      .eq("clinic_id", clinicId)
      .eq("billing_disposition", "byok_provider_direct")
      .gte("created_at", periodStart)
      .lt("created_at", periodEnd),
  ]);
  if (periodResult.error || requestResult.error || termsResult.error || byokResult.error) {
    throw new Error("AI commercial usage is temporarily unavailable.");
  }

  const byokRows = byokResult.data ?? [];
  const byokEstimatedCostMicros = byokRows.reduce(
    (sum, row) => sum + safeInteger(row.final_cost_micros),
    0,
  );
  const byokRequestUsed = new Set(
    byokRows.map((row) => row.request_id).filter((id): id is string => typeof id === "string"),
  ).size;

  return computeClinicAiCommercialUsage({
    periodStart,
    planBudgetMicros: safeInteger(entitlements.limits[AI_LIMIT_KEYS.creditsMonth]),
    requestPlanLimit: resolveAiRequestLimit(entitlements),
    period: periodResult.data,
    requestCounter: requestResult.data,
    terms: termsResult.data,
    byokRequestUsed,
    byokEstimatedCostMicros,
  });
}
