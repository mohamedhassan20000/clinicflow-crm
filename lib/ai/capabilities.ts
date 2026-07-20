import "server-only";

import * as Sentry from "@sentry/nextjs";
import {
  AI_FINANCIAL_INSIGHTS_FEATURE,
  AI_STAFF_ANALYTICS_FEATURE,
  FINANCIAL_ASSISTANT_ROLES,
} from "@/lib/ai/authorization";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import {
  AI_FINANCIAL_INSIGHTS_PERMISSION,
  hasAiUserPermission,
} from "@/lib/ai/permissions";
import { resolveToolMount } from "@/lib/ai/tools";
import type { AuthedUser } from "@/lib/rbac";

/**
 * Why the financial group is absent, when it is. The distinction is the whole
 * point: "your plan does not include this" and "your admin has not enabled this
 * for you" are different problems with different remedies, and collapsing them
 * into one message sends managers to the wrong person. The chat route already
 * separates `feature_not_entitled` from `permission_not_granted` for the same
 * reason (P4.6A review I2); this is the pre-turn half of that contract.
 */
export type FinancialCapabilityState =
  | "available"
  /** The role is never offered financial tools (receptionist, doctor). */
  | "not_applicable"
  /** The clinic's plan lacks ai.financial_insights. */
  | "not_entitled"
  /** Entitled, but the admin-granted per-user permission is off. */
  | "not_granted"
  /**
   * Role-eligible, entitled, and granted — yet nothing mounted. Its own state
   * because it is not a plan problem and not a permission problem, and calling
   * it "not_entitled" sent the user to the wrong person to fix it. Rare by
   * construction (the surface gate has already passed by the time capabilities
   * resolve), so the copy says "unavailable", not "upgrade" and not "ask your
   * admin".
   */
  | "unavailable";

export type AssistantCapabilities = {
  /** Tool names actually mounted for this user — the model's own resolution. */
  toolNames: readonly string[];
  /** Clinic-wide aggregate distributions (admin/manager). */
  clinicAnalytics: boolean;
  /** Bounded operational lists, counts, and reports. */
  operational: boolean;
  financial: FinancialCapabilityState;
};

const CLINIC_ANALYTICS_TOOLS = [
  "get_clinic_summary",
  "get_patient_stats",
  "get_appointment_stats",
] as const;

const OPERATIONAL_TOOLS = [
  "list_appointments",
  "count_new_patients",
  "list_pending_followups",
  "run_clinic_report",
] as const;

export const FINANCIAL_TOOL_NAMES = [
  "get_revenue_summary",
  "compare_revenue_periods",
  "list_outstanding_invoices",
] as const;

const EMPTY: AssistantCapabilities = {
  toolNames: [],
  clinicAnalytics: false,
  operational: false,
  financial: "not_applicable",
};

/**
 * Resolves what the assistant can actually do for this user, for **display
 * only** — suggestion chips, the financial "not enabled" notice, and how a
 * result is framed.
 *
 * It reads the mount from `resolveToolMount`, the same function that builds the
 * model's tool array, rather than re-deriving the rules from the role matrix.
 * That is deliberate: a second copy of the matrix is a second thing to keep
 * correct, and the failure mode of a drifted copy is an affordance that offers
 * a capability the user does not have (or hides one they do).
 *
 * `taskClass` is intentionally omitted, so this returns the union across the
 * task classes the role can run rather than one turn's narrower mount. The
 * per-turn mount stays authoritative for what the model may call; this is the
 * superset the UI describes. Nothing here is an authorization decision — every
 * tool re-asserts role, entitlement, permission, and RLS inside `execute()`,
 * and the route denies independently of anything the client was shown.
 */
export async function resolveAssistantCapabilities(
  user: AuthedUser,
): Promise<AssistantCapabilities> {
  try {
    const { definitions } = await resolveToolMount({ user, locale: "en" });
    const toolNames = definitions.map((definition) => definition.name);
    const mounted = new Set(toolNames);

    return {
      toolNames,
      clinicAnalytics: CLINIC_ANALYTICS_TOOLS.some((name) => mounted.has(name)),
      operational: OPERATIONAL_TOOLS.some((name) => mounted.has(name)),
      financial: FINANCIAL_TOOL_NAMES.some((name) => mounted.has(name))
        ? "available"
        : await explainFinancialAbsence(user),
    };
  } catch (error) {
    // Capabilities are presentation data. A failure here must degrade the
    // affordances, never the chat itself — the assistant is fully usable with
    // no suggestion chips.
    Sentry.captureException(error, {
      tags: { area: "assistant-capabilities" },
      extra: { clinicId: user.clinicId, role: user.role },
    });
    return EMPTY;
  }
}

/**
 * Only reached when no financial tool mounted, and only to choose which
 * sentence to show. It re-reads the entitlement and the grant instead of
 * inferring from the mount, because the mount collapses the two causes into a
 * single absence.
 */
async function explainFinancialAbsence(
  user: AuthedUser,
): Promise<Exclude<FinancialCapabilityState, "available">> {
  if (!FINANCIAL_ASSISTANT_ROLES.includes(user.role)) return "not_applicable";

  const entitlements = await getEntitlements(user.clinicId);
  if (
    !hasFeature(entitlements, AI_STAFF_ANALYTICS_FEATURE) ||
    !hasFeature(entitlements, AI_FINANCIAL_INSIGHTS_FEATURE)
  ) {
    return "not_entitled";
  }
  return (await hasAiUserPermission(user, AI_FINANCIAL_INSIGHTS_PERMISSION))
    ? // Entitled and granted, yet nothing mounted. The blocker is upstream (the
      // assistant feature or page visibility) — but `resolveStaffAssistantPage`
      // only resolves capabilities once access is "available", so the surface
      // gate has by definition already passed here and will not report it
      // either. Reporting "your plan does not include this" would be a claim
      // about the plan that is not true.
      "unavailable"
    : "not_granted";
}
