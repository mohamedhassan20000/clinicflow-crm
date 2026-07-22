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
import {
  presentationFor,
  type AssistantToolGroup,
} from "@/lib/ai/tool-presentation";
import type { PromptLocale } from "@/lib/ai/prompts/doctor";
import type { AuthedUser } from "@/lib/rbac";
import {
  allowedClinicReports,
  type ClinicReportId,
} from "@/lib/ai/clinic-reports";

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

/**
 * One capability, as the panel and the `list_my_capabilities` tool present it
 * (P4.7B).
 *
 * `description` is the registry's own `capabilityDescription[locale]` — the same
 * text placed in the model's context when the tool is mounted — so the panel and
 * the model describe a capability with one wording, resolved from one place. The
 * `group` reuses the presentation grouping the chat already renders tool activity
 * with, so a financial capability reads as financial in the panel too.
 */
export type AssistantCapabilityItem = {
  /** The registry tool name; a stable id, not shown to the user. */
  name: string;
  group: AssistantToolGroup;
  description: string;
};

export type AssistantCapabilities = {
  /** Authorized union across the task classes supported for this user's role. */
  toolNames: readonly string[];
  /**
   * The authorized union rendered as localized, grouped descriptions — the
   * capability panel's content and the `list_my_capabilities` payload, from the
   * same resolution as `toolNames` (P4.7B). Order is group-then-registry so the
   * panel is stable across requests.
   */
  items: readonly AssistantCapabilityItem[];
  /** Clinic-wide aggregate distributions (admin/manager). */
  clinicAnalytics: boolean;
  /** Bounded operational lists, counts, and reports. */
  operational: boolean;
  financial: FinancialCapabilityState;
  /** Exact report ids the shared report policy authorizes for this user. */
  allowedReportIds: readonly ClinicReportId[];
};

/**
 * The order the panel lists groups in. Guidance sits last because "how to use
 * the app" and "what can I ask" are meta-capabilities framing the rest, not
 * clinic work; clinical/operational/financial mirror the chat's own visual
 * ordering of tool activity.
 */
const GROUP_ORDER: readonly AssistantToolGroup[] = [
  "clinical",
  "operational",
  "financial",
  "guidance",
];

/**
 * Maps the resolved authorized union to localized, grouped capability items.
 *
 * Deliberately derived from `resolveToolMount` definitions rather than a second
 * list. An active turn passes a task class and receives a narrower mount; this
 * unscoped resolution receives the union of the classes supported for the role.
 * Tests require every active mount to be a subset of this union and require the
 * union to equal the set union of those mounts.
 */
function capabilityItems(
  definitions: readonly {
    name: string;
    capabilityDescription?: { en: string; ar: string };
  }[],
  locale: PromptLocale,
): AssistantCapabilityItem[] {
  const items = definitions.map((definition) => ({
    name: definition.name,
    group: presentationFor(definition.name).group,
    // Every real registry entry carries a description; the fallback only guards
    // the degrade paths (and the synthetic mounts tests force) so a missing one
    // renders as an empty string rather than throwing the whole resolution away.
    description: definition.capabilityDescription?.[locale] ?? "",
  }));
  return items.sort((a, b) => {
    const byGroup = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
    if (byGroup !== 0) return byGroup;
    // Preserve registry order within a group (map above kept it), so equal-group
    // items keep the deliberate ordering of AI_TOOL_REGISTRY.
    return 0;
  });
}

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
  items: [],
  clinicAnalytics: false,
  operational: false,
  financial: "not_applicable",
  allowedReportIds: [],
};

/**
 * Resolves what the assistant can actually do for this user, for **display
 * only** — suggestion chips, the financial "not enabled" notice, and how a
 * result is framed.
 *
 * It reads the authorized union from `resolveToolMount`, the same function that
 * builds each active model tool array, rather than re-deriving tool rules.
 * That is deliberate: a second copy of the matrix is a second thing to keep
 * correct, and the failure mode of a drifted copy is an affordance that offers
 * a capability the user does not have (or hides one they do).
 *
 * `taskClass` is intentionally omitted, so this returns the exact set union
 * across the certified task classes the router supports for the role, rather
 * than one turn's narrower mount. The per-turn mount stays authoritative for
 * what the model may call; this is the cross-turn authorization contract the UI
 * describes. Nothing here is an authorization decision — every
 * tool re-asserts role, entitlement, permission, and RLS inside `execute()`,
 * and the route denies independently of anything the client was shown.
 */
export async function resolveAssistantCapabilities(
  user: AuthedUser,
  locale: PromptLocale = "en",
): Promise<AssistantCapabilities> {
  try {
    // Locale is passed to the mount so `capabilityDescription` is read in the
    // right language for the panel; it does not change *which* tools mount.
    const { definitions, grantedPermissions } = await resolveToolMount({
      user,
      locale,
    });
    const toolNames = definitions.map((definition) => definition.name);
    const mounted = new Set(toolNames);

    return {
      toolNames,
      items: capabilityItems(definitions, locale),
      clinicAnalytics: CLINIC_ANALYTICS_TOOLS.some((name) => mounted.has(name)),
      operational: OPERATIONAL_TOOLS.some((name) => mounted.has(name)),
      financial: FINANCIAL_TOOL_NAMES.some((name) => mounted.has(name))
        ? "available"
        : await explainFinancialAbsence(user),
      allowedReportIds: mounted.has("run_clinic_report")
        ? allowedClinicReports(user.role, {
            financialGranted:
              grantedPermissions?.has(AI_FINANCIAL_INSIGHTS_PERMISSION) ?? false,
          })
        : [],
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
