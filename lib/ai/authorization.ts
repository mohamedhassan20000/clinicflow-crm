import "server-only";
import { cache } from "react";
import { getAuthedUser, type AuthedUser, type UserRole } from "@/lib/rbac";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { AiToolAuthorizationError } from "@/lib/ai/errors";
import { getPageVisibilityState } from "@/lib/server-page-permissions";
import { LEGACY_AI_ASSISTANT_FEATURE } from "@/lib/ai/commercial-policy";
import { hasAiUserPermission } from "@/lib/ai/permissions";

/** Every normal clinic role may use its role-appropriate Assistant persona. */
export const STAFF_ASSISTANT_ROLES: readonly UserRole[] = [
  "admin",
  "manager",
  "doctor",
  "receptionist",
];

/** Clinical summaries and visit search remain doctor-only tools. */
export const CLINICAL_ASSISTANT_ROLES: readonly UserRole[] = ["doctor"];

export const AI_ASSISTANT_FEATURE = LEGACY_AI_ASSISTANT_FEATURE;

/**
 * Resolves and authorizes the current staff user for the doctor assistant.
 * Called once at the surface boundary (the P4B streaming route) to build the
 * tool context, and reused in tests. It never trusts the model: identity comes
 * from the session, and the ai_assistant entitlement + role are enforced here.
 *
 * Throws AiToolAuthorizationError on any denial (tools run inside the model
 * loop and cannot use redirect()-based guards).
 */
export async function authorizeStaffAssistant(): Promise<AuthedUser> {
  const user = await getAuthedUser();
  if (!user) {
    throw new AiToolAuthorizationError("unauthenticated");
  }
  await assertStaffToolAccess(user);
  return user;
}

/**
 * Per-tool role re-check, mirroring requireRole in actions (§9.1). Every tool
 * calls this before touching data, so a tool can never be exercised by a role
 * outside the doctor-assistant set even if wired incorrectly by a future change.
 */
export function assertStaffRole(user: AuthedUser): void {
  if (!STAFF_ASSISTANT_ROLES.includes(user.role)) {
    throw new AiToolAuthorizationError(
      "role_forbidden",
      `Role "${user.role}" may not use the staff assistant.`,
    );
  }
}

export function assertClinicalRole(user: AuthedUser): void {
  if (!CLINICAL_ASSISTANT_ROLES.includes(user.role)) {
    throw new AiToolAuthorizationError(
      "role_forbidden",
      `Role "${user.role}" may not use clinical assistant tools.`,
    );
  }
}

/**
 * Request-scoped memo for the assistant page-visibility read (L6). A six-step
 * turn calling several tools re-ran this lookup once per tool; `cache` collapses
 * that to one round-trip per request while preserving the semantic that matters
 * — the check is still re-evaluated on the next turn, so a page hidden
 * mid-conversation denies immediately after.
 *
 * `cache` compares arguments by identity, so the memo keys on the user's
 * primitives rather than relying on every caller sharing one `AuthedUser`
 * reference. Those three fields are the entire input `getPageVisibilityState`
 * reads.
 */
const readAssistantVisibilityFor = cache(
  async (id: string, clinicId: string, role: UserRole) =>
    getPageVisibilityState({ id, clinicId, role }, "assistant"),
);

function readAssistantVisibility(user: AuthedUser) {
  return readAssistantVisibilityFor(user.id, user.clinicId, user.role);
}

/**
 * Defense-in-depth authorization performed by every doctor tool before it
 * creates an RLS client. Usage remains a per-model-turn concern (one turn may
 * invoke several tools), but role, subscription, and feature entitlement are
 * re-asserted at the tool boundary so a future surface cannot bypass them.
 */
export async function assertStaffToolAccess(user: AuthedUser): Promise<void> {
  assertStaffRole(user);

  const visibility = await readAssistantVisibility(user);
  if (visibility === "hidden") {
    throw new AiToolAuthorizationError("page_hidden");
  }
  if (visibility === "lookup_failed") {
    throw new AiToolAuthorizationError("lookup_failed");
  }

  const entitlements = await getEntitlements(user.clinicId);
  if (!entitlements.subscriptionAllowed) {
    throw new AiToolAuthorizationError("subscription_inactive");
  }
  if (!hasFeature(entitlements, AI_ASSISTANT_FEATURE)) {
    throw new AiToolAuthorizationError("feature_not_entitled");
  }
}

export async function assertClinicalToolAccess(user: AuthedUser): Promise<void> {
  assertClinicalRole(user);
  await assertStaffToolAccess(user);
}

/**
 * P4.6 analytics matrix. Doctors keep their own self-scoped P4 tools, so they
 * are excluded from every scope here rather than given a narrowed clinic view.
 *
 * The two role sets are deliberately separate rather than one shared list.
 * Collapsing them made this layer weaker than the registry it exists to back
 * up: `get_clinic_summary` / `get_patient_stats` / `get_appointment_stats` are
 * registered for admin/manager only, but a single shared assert that admitted
 * receptionists meant the registry's `roles` array was the *only* thing denying
 * them — so a one-token registry edit could have handed a receptionist the
 * clinic-wide blood-type distribution with nothing else objecting. Each layer
 * must deny independently or it is not defense in depth.
 *
 * These mirror the `p_scope` values of the `ai_assert_analytics_caller` guard in
 * the database, which enforces the same split a third time.
 */
export const OPERATIONAL_ASSISTANT_ROLES: readonly UserRole[] = [
  "admin",
  "manager",
  "receptionist",
];

/** Clinic-wide aggregate distributions, including patient attributes. */
export const CLINIC_ANALYTICS_ASSISTANT_ROLES: readonly UserRole[] = ["admin", "manager"];

/** Financial analytics never mount for receptionists or doctors. */
export const FINANCIAL_ASSISTANT_ROLES: readonly UserRole[] = ["admin", "manager"];

/**
 * @deprecated Ambiguous name retained only so existing imports keep compiling.
 * Prefer {@link OPERATIONAL_ASSISTANT_ROLES} or
 * {@link CLINIC_ANALYTICS_ASSISTANT_ROLES} — picking one is the point.
 */
export const ANALYTICS_ASSISTANT_ROLES = OPERATIONAL_ASSISTANT_ROLES;

export const AI_STAFF_ANALYTICS_FEATURE = "ai.staff_analytics" as const;
export const AI_FINANCIAL_INSIGHTS_FEATURE = "ai.financial_insights" as const;

/**
 * Per-tool re-check for the bounded operational list/count tools
 * (`list_appointments`, `count_new_patients`, `list_pending_followups`,
 * non-financial `run_clinic_report`): the full staff spine plus the operational
 * role matrix and the ai.staff_analytics entitlement.
 */
export async function assertAnalyticsToolAccess(user: AuthedUser): Promise<void> {
  if (!OPERATIONAL_ASSISTANT_ROLES.includes(user.role)) {
    throw new AiToolAuthorizationError(
      "role_forbidden",
      `Role "${user.role}" may not use clinic operational tools.`,
    );
  }
  await assertStaffToolAccess(user);

  const entitlements = await getEntitlements(user.clinicId);
  if (!hasFeature(entitlements, AI_STAFF_ANALYTICS_FEATURE)) {
    throw new AiToolAuthorizationError("feature_not_entitled");
  }
}

/**
 * Per-tool re-check for the clinic-wide aggregate tools. Strictly narrower than
 * {@link assertAnalyticsToolAccess}: receptionists are refused here even though
 * they may run the operational lists.
 */
export async function assertClinicAnalyticsToolAccess(user: AuthedUser): Promise<void> {
  if (!CLINIC_ANALYTICS_ASSISTANT_ROLES.includes(user.role)) {
    throw new AiToolAuthorizationError(
      "role_forbidden",
      `Role "${user.role}" may not use clinic-wide analytics tools.`,
    );
  }
  await assertAnalyticsToolAccess(user);
}

/**
 * Financial gate (§P4.6). Entitlement is necessary but not sufficient: an
 * admin-granted per-user permission must also pass, because RLS already allows
 * manager reads of the underlying financial tables. Both checks live here and
 * are re-run on every tool invocation, not only at registration time.
 */
export async function assertFinancialInsightsAccess(user: AuthedUser): Promise<void> {
  if (!FINANCIAL_ASSISTANT_ROLES.includes(user.role)) {
    throw new AiToolAuthorizationError(
      "role_forbidden",
      `Role "${user.role}" may not use financial analytics tools.`,
    );
  }
  await assertAnalyticsToolAccess(user);

  const entitlements = await getEntitlements(user.clinicId);
  if (!hasFeature(entitlements, AI_FINANCIAL_INSIGHTS_FEATURE)) {
    throw new AiToolAuthorizationError("feature_not_entitled");
  }
  if (!(await hasAiUserPermission(user, "ai.financial_insights"))) {
    throw new AiToolAuthorizationError("permission_not_granted");
  }
}

/** Backwards-compatible name for the existing clinical tools. */
export const assertDoctorToolAccess = assertClinicalToolAccess;

/** Backwards-compatible route export for callers migrating to the staff name. */
export const authorizeDoctorAssistant = authorizeStaffAssistant;
