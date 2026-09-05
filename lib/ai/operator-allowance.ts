import "server-only";

import { aiUsageThreshold } from "@/lib/ai/allowance";
import { AI_LIMIT_KEYS } from "@/lib/ai/commercial-policy";
import {
  loadOperatorAiAllowanceFallbackSources,
  loadOperatorAiAllowanceReport,
} from "@/lib/supabase/admin";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Owner AI-allowance console source, and why it has two legs.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The authoritative source is `operator_ai_allowance_report` (P12 migration
 * 20260831120000): it is the same SQL the reservation transaction enforces, it
 * re-checks platform-admin *inside* the database, and it is what this module
 * asks for first.
 *
 * It is however a migration that a given environment may not have applied yet,
 * and the failure mode observed on the owner console was exactly that —
 * PostgREST answering `PGRST202 … Could not find the function
 * public.operator_ai_allowance_report(p_period_start) in the schema cache`,
 * which the page then swallowed into a generic "report unavailable" box. The
 * cause was invisible precisely because the error was hidden.
 *
 * So this module does two things the old call site did not:
 *
 *  1. It keeps the real diagnostic (`code` + `message`) and hands it back to the
 *     caller, which renders it for the owner instead of discarding it.
 *  2. When — and only when — the RPC is absent from the schema cache, it
 *     recomputes the same figures from the base tables through the service-role
 *     client, so a console the owner needs is not dark until a migration lands.
 *
 * The fallback is a strictly degraded path and says so in the UI. It applies the
 * documented allowance rule verbatim (plan default, optionally replaced by the
 * per-clinic override, plus add-on and contracted overage; committed = spent +
 * reserved), so it cannot quietly disagree with the enforcement path about
 * whether a clinic is over its allowance.
 *
 * No figure here is a token count and no figure here is a price: `micros` are
 * ClinicFlow's internal cost unit, and the owner console is the one place they
 * are allowed to be shown at all — behind a technical-detail disclosure.
 */

export type OperatorAllowanceStatus =
  | "healthy"
  | "warning"
  | "critical"
  | "exhausted"
  | "byok"
  | "unconfigured";

export type OperatorAllowanceRow = {
  clinic_id: string;
  clinic_name: string;
  plan_slug: string;
  plan_included_micros: number;
  override_included_micros: number | null;
  effective_included_micros: number;
  addon_micros: number;
  overage_micros: number;
  total_allowance_micros: number;
  managed_spent_micros: number;
  managed_reserved_micros: number;
  remaining_micros: number;
  used_percent: number;
  byok_spent_micros: number;
  request_used: number;
  request_limit: number;
  period_start: string;
  period_reset_at: string;
  credential_mode: string;
  byok_configured: boolean;
  auto_byok_fallback_enabled: boolean;
  status: OperatorAllowanceStatus;
};

export type OperatorAllowanceReport = {
  rows: OperatorAllowanceRow[];
  /** `rpc` = the enforcement-path SQL answered. `fallback` = recomputed here. */
  source: "rpc" | "fallback";
  /**
   * The real PostgREST/Postgres error when the RPC did not answer, verbatim.
   * Present on both a successful fallback and a total failure — the owner is
   * told what actually went wrong either way.
   */
  diagnostic: { code: string; message: string; hint: string | null } | null;
  /** True when neither the RPC nor the fallback could produce a report. */
  failed: boolean;
};

/** PostgREST's code for "this function is not in the schema cache". */
const MISSING_FUNCTION_CODE = "PGRST202";

export function monthStartUtc(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export function nextMonthStartUtc(now: Date): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return month === 11
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 2).padStart(2, "0")}-01`;
}

function safeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function jsonNumber(source: unknown, key: string): number {
  if (!source || typeof source !== "object" || Array.isArray(source)) return 0;
  const value = (source as Record<string, unknown>)[key];
  if (typeof value === "number") return safeInteger(Math.trunc(value));
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  }
  return 0;
}

function jsonBoolean(source: unknown, key: string): boolean {
  if (!source || typeof source !== "object" || Array.isArray(source)) return false;
  return (source as Record<string, unknown>)[key] === true;
}

/**
 * The one place the status band is decided, shared by both legs so the fallback
 * cannot label a clinic differently from the SQL.
 */
export function resolveAllowanceStatus(input: {
  credentialMode: string;
  totalAllowanceMicros: number;
  committedMicros: number;
}): OperatorAllowanceStatus {
  if (input.credentialMode === "byok_strict") return "byok";
  if (input.totalAllowanceMicros <= 0) return "unconfigured";
  const percent = (input.committedMicros / input.totalAllowanceMicros) * 100;
  const band = aiUsageThreshold(percent);
  return band === "normal" ? "healthy" : band;
}

type FallbackClinicRow = {
  clinic_id: string;
  clinic_name: string;
  plan_slug: string;
  plan_included_micros: number;
  ai_assistant: boolean;
};

/**
 * Recomputes the console from the base tables. The rows come from the reviewed
 * service-role boundary in `lib/supabase/admin`; nothing here reads a patient,
 * appointment, message, document, or credential.
 */
async function computeFallbackReport(input: {
  periodStart: string;
  periodReset: string;
  clinicId?: string;
}): Promise<OperatorAllowanceRow[]> {
  const sources = await loadOperatorAiAllowanceFallbackSources({
    periodStart: input.periodStart,
    clinicId: input.clinicId,
  });

  const clinics: FallbackClinicRow[] = sources.subscriptions
    .map((row) => ({
      clinic_id: row.clinic_id,
      clinic_name: row.clinics?.name ?? "",
      plan_slug: row.plans?.slug ?? "",
      plan_included_micros: jsonNumber(row.plans?.limits, AI_LIMIT_KEYS.creditsMonth),
      ai_assistant: jsonBoolean(row.plans?.features, "ai_assistant"),
    }))
    // The SQL restricts the console to plans that actually carry the assistant;
    // a clinic that cannot use AI has no allowance to report on.
    .filter((row) => row.ai_assistant && row.clinic_name !== "");
  if (clinics.length === 0) return [];

  const termsByClinic = new Map(sources.terms.map((row) => [row.clinic_id, row]));
  const periodByClinic = new Map(sources.periods.map((row) => [row.clinic_id, row]));
  const counterByClinic = new Map(sources.counters.map((row) => [row.clinic_id, row]));
  const policyByClinic = new Map(sources.policies.map((row) => [row.clinic_id, row]));
  const byokClinics = new Set(sources.byokClinicIds);
  const byokSpendByClinic = new Map(
    sources.byokSpend.map((row) => [row.clinic_id, safeInteger(row.byok_spent_micros)]),
  );
  const autoFallbackByClinic = new Map(
    sources.autoFallback.map((row) => [row.clinic_id, row.auto_byok_fallback_enabled !== false]),
  );

  return clinics
    .map((clinic): OperatorAllowanceRow => {
      const term = termsByClinic.get(clinic.clinic_id);
      const period = periodByClinic.get(clinic.clinic_id);
      const counter = counterByClinic.get(clinic.clinic_id);
      const override = term?.included_budget_override_micros ?? null;
      const effective = override === null ? clinic.plan_included_micros : safeInteger(override);
      const addon = safeInteger(term?.addon_budget_micros);
      const overage = term?.overage_mode === "contracted" ? safeInteger(term?.overage_budget_micros) : 0;
      const totalAllowance = effective + addon + overage;
      const spent = safeInteger(period?.spent_micros);
      const reserved = safeInteger(period?.reserved_micros);
      const committed = spent + reserved;
      const credentialMode = policyByClinic.get(clinic.clinic_id)?.credential_mode ?? "managed";
      return {
        clinic_id: clinic.clinic_id,
        clinic_name: clinic.clinic_name,
        plan_slug: clinic.plan_slug,
        plan_included_micros: clinic.plan_included_micros,
        override_included_micros: override === null ? null : safeInteger(override),
        effective_included_micros: effective,
        addon_micros: addon,
        overage_micros: overage,
        total_allowance_micros: totalAllowance,
        managed_spent_micros: spent,
        managed_reserved_micros: reserved,
        remaining_micros: Math.max(totalAllowance - committed, 0),
        used_percent:
          totalAllowance <= 0 ? 0 : Math.min(100, Math.floor((committed / totalAllowance) * 100)),
        byok_spent_micros: byokSpendByClinic.get(clinic.clinic_id) ?? 0,
        request_used: safeInteger(counter?.used),
        request_limit: safeInteger(counter?.limit_snapshot),
        period_start: input.periodStart,
        period_reset_at: input.periodReset,
        credential_mode: credentialMode,
        byok_configured: byokClinics.has(clinic.clinic_id),
        auto_byok_fallback_enabled: autoFallbackByClinic.get(clinic.clinic_id) ?? true,
        status: resolveAllowanceStatus({
          credentialMode,
          totalAllowanceMicros: totalAllowance,
          committedMicros: committed,
        }),
      };
    })
    .sort((a, b) => a.clinic_name.localeCompare(b.clinic_name));
}

/**
 * Loads the owner allowance console. Callers must already have passed
 * requirePlatformAdmin(); the RPC re-checks it in the database regardless.
 */
export async function loadOperatorAllowanceReport(input: {
  periodStart: string;
  periodReset: string;
  clinicId?: string;
}): Promise<OperatorAllowanceReport> {
  const rpc = await loadOperatorAiAllowanceReport({
    periodStart: input.periodStart,
    clinicId: input.clinicId,
  });
  if (!rpc.error) {
    const rows = Array.isArray(rpc.data) ? (rpc.data as OperatorAllowanceRow[]) : [];
    return { rows, source: "rpc", diagnostic: null, failed: false };
  }

  const diagnostic = {
    code: rpc.error.code ?? "unknown",
    message: rpc.error.message,
    hint: rpc.error.hint ?? null,
  };
  console.error("Operator AI allowance RPC failed", {
    code: diagnostic.code,
    message: diagnostic.message,
    periodStart: input.periodStart,
  });

  // Anything other than a missing function is a real fault (authorization,
  // an invalid period, a database error) and must surface as one — recomputing
  // around it would hide exactly the class of bug this console has to show.
  if (diagnostic.code !== MISSING_FUNCTION_CODE) {
    return { rows: [], source: "rpc", diagnostic, failed: true };
  }

  try {
    const rows = await computeFallbackReport(input);
    return { rows, source: "fallback", diagnostic, failed: false };
  } catch (error) {
    console.error("Operator AI allowance fallback failed", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return { rows: [], source: "fallback", diagnostic, failed: true };
  }
}
