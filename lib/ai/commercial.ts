import "server-only";

import { aiUsageThreshold, type AiUsageThreshold } from "@/lib/ai/allowance";
import { AI_LIMIT_KEYS } from "@/lib/ai/commercial-policy";
import { getEntitlements, resolveAiRequestLimit } from "@/lib/entitlements";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";

export { aiUsageThreshold };
export type { AiUsageThreshold };

/**
 * What the clinic is actually running on right now.
 *
 *  * `managed`   — ClinicFlow's own Anthropic key, funded by the plan allowance.
 *  * `byok`      — the clinic configured its own Anthropic key and chose it.
 *  * `auto_byok` — the clinic is on a managed plan whose allowance is spent, and
 *                  its own key is carrying AI so nothing stopped.
 */
export type ClinicAiProviderState = "managed" | "byok" | "auto_byok";

export type ClinicAiCommercialUsage = {
  periodStart: string;
  /** First day of the next billing period: when the included allowance resets. */
  resetDate: string;
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
  /** Allowance left after committed (spent + in-flight) usage. Never negative. */
  remainingMicros: number;
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
  /** Whether a healthy clinic-owned Anthropic credential exists at all. */
  byokConfigured: boolean;
  providerState: ClinicAiProviderState;
};

type PeriodRow = {
  budget_limit_micros: number | null;
  reserved_micros: number | null;
  spent_micros: number | null;
  byok_spent_micros?: number | null;
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

/**
 * Pure commercial projection. Separates request-count (fair-use) allowance from
 * the cost-weighted managed allowance, and keeps clinic-owned BYOK usage in its
 * own bucket. Extracted from the IO wrapper so the arithmetic — in particular
 * the "unconfigured vs exhausted" distinction — is unit-testable without a
 * database.
 */
export function computeClinicAiCommercialUsage(input: {
  periodStart: string;
  resetDate: string;
  planBudgetMicros: number;
  requestPlanLimit: number;
  period: PeriodRow;
  requestCounter: RequestCounterRow;
  terms: CommercialTermsRow;
  byokRequestUsed: number;
  byokEstimatedCostMicros: number;
  byokConfigured: boolean;
  credentialMode: "managed" | "byok_strict" | "hybrid";
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

  const remainingMicros = Math.max(0, budgetLimitMicros - committedMicros);
  const threshold = managedAllowanceConfigured ? aiUsageThreshold(usedPercent) : "normal";
  // The state the clinic is *actually* in, which is not always the state it
  // configured: a managed clinic whose allowance is spent and whose own key is
  // carrying the load must be shown that, not a stale "ClinicFlow Managed AI".
  const providerState: ClinicAiProviderState =
    input.credentialMode !== "managed"
      ? "byok"
      : managedAllowanceConfigured && threshold === "exhausted" && input.byokConfigured
        ? "auto_byok"
        : "managed";

  return {
    periodStart: input.periodStart,
    resetDate: input.resetDate,
    managedSpentMicros,
    reservedMicros,
    budgetLimitMicros,
    managedAllowanceConfigured,
    usedPercent,
    remainingMicros,
    requestUsed,
    requestLimit,
    requestRemaining: Math.max(0, requestLimit - requestUsed),
    threshold,
    overageMode: terms?.overage_mode === "contracted" ? "contracted" : "hard_cap",
    hasAddon: safeInteger(terms?.addon_budget_micros) > 0,
    byokRequestUsed: safeInteger(input.byokRequestUsed),
    byokEstimatedCostMicros: safeInteger(input.byokEstimatedCostMicros),
    byokConfigured: input.byokConfigured,
    providerState,
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
  const [periodResult, requestResult, termsResult, byokResult, providerResult, connectionResult] =
    await Promise.all([
    db
      .from("ai_budget_periods")
      .select("budget_limit_micros, reserved_micros, spent_micros, byok_spent_micros")
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
    db
      .from("ai_clinic_provider_policies")
      .select("credential_mode")
      .eq("clinic_id", clinicId)
      .maybeSingle(),
    // Metadata only: never the ciphertext, key version, or fingerprint.
    db
      .from("ai_provider_connections")
      .select("health_status")
      .eq("clinic_id", clinicId)
      .eq("lifecycle_status", "active")
      .maybeSingle(),
  ]);
  if (
    periodResult.error ||
    requestResult.error ||
    termsResult.error ||
    byokResult.error ||
    providerResult.error ||
    connectionResult.error
  ) {
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

  const rawMode = providerResult.data?.credential_mode;
  const credentialMode =
    rawMode === "byok_strict" || rawMode === "hybrid" ? rawMode : "managed";

  return computeClinicAiCommercialUsage({
    periodStart,
    resetDate: periodEnd,
    planBudgetMicros: safeInteger(entitlements.limits[AI_LIMIT_KEYS.creditsMonth]),
    requestPlanLimit: resolveAiRequestLimit(entitlements),
    period: periodResult.data,
    requestCounter: requestResult.data,
    terms: termsResult.data,
    byokRequestUsed,
    // The period aggregate is authoritative once it exists; the per-event sum
    // stays as the fallback for periods that predate `byok_spent_micros`.
    byokEstimatedCostMicros: Math.max(
      byokEstimatedCostMicros,
      safeInteger(periodResult.data?.byok_spent_micros),
    ),
    byokConfigured: connectionResult.data?.health_status === "valid",
    credentialMode,
  });
}
