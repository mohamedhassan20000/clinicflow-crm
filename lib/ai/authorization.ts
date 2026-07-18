import "server-only";
import { getAuthedUser, type AuthedUser, type UserRole } from "@/lib/rbac";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { AiToolAuthorizationError } from "@/lib/ai/errors";
import { getPageVisibilityState } from "@/lib/server-page-permissions";

/** Every normal clinic role may use its role-appropriate Assistant persona. */
export const STAFF_ASSISTANT_ROLES: readonly UserRole[] = [
  "admin",
  "manager",
  "doctor",
  "receptionist",
];

/** Clinical summaries and visit search remain doctor-only tools. */
export const CLINICAL_ASSISTANT_ROLES: readonly UserRole[] = ["doctor"];

export const AI_ASSISTANT_FEATURE = "ai_assistant";

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
 * Defense-in-depth authorization performed by every doctor tool before it
 * creates an RLS client. Usage remains a per-model-turn concern (one turn may
 * invoke several tools), but role, subscription, and feature entitlement are
 * re-asserted at the tool boundary so a future surface cannot bypass them.
 */
export async function assertStaffToolAccess(user: AuthedUser): Promise<void> {
  assertStaffRole(user);

  const visibility = await getPageVisibilityState(user, "assistant");
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

/** Backwards-compatible name for the existing clinical tools. */
export const assertDoctorToolAccess = assertClinicalToolAccess;

/** Backwards-compatible route export for callers migrating to the staff name. */
export const authorizeDoctorAssistant = authorizeStaffAssistant;
