import "server-only";
import { getAuthedUser, type AuthedUser, type UserRole } from "@/lib/rbac";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { AiToolAuthorizationError } from "@/lib/ai/errors";

/** Roles permitted to use the doctor assistant and its tools (§6.3). */
export const DOCTOR_ASSISTANT_ROLES: readonly UserRole[] = ["admin", "doctor"];

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
export async function authorizeDoctorAssistant(): Promise<AuthedUser> {
  const user = await getAuthedUser();
  if (!user) {
    throw new AiToolAuthorizationError("unauthenticated");
  }
  await assertDoctorToolAccess(user);
  return user;
}

/**
 * Per-tool role re-check, mirroring requireRole in actions (§9.1). Every tool
 * calls this before touching data, so a tool can never be exercised by a role
 * outside the doctor-assistant set even if wired incorrectly by a future change.
 */
export function assertDoctorRole(user: AuthedUser): void {
  if (!DOCTOR_ASSISTANT_ROLES.includes(user.role)) {
    throw new AiToolAuthorizationError(
      "role_forbidden",
      `Role "${user.role}" may not use the doctor assistant.`,
    );
  }
}

/**
 * Defense-in-depth authorization performed by every doctor tool before it
 * creates an RLS client. Usage remains a per-model-turn concern (one turn may
 * invoke several tools), but role, subscription, and feature entitlement are
 * re-asserted at the tool boundary so a future surface cannot bypass them.
 */
export async function assertDoctorToolAccess(user: AuthedUser): Promise<void> {
  assertDoctorRole(user);

  const entitlements = await getEntitlements(user.clinicId);
  if (!entitlements.subscriptionAllowed) {
    throw new AiToolAuthorizationError("subscription_inactive");
  }
  if (!hasFeature(entitlements, AI_ASSISTANT_FEATURE)) {
    throw new AiToolAuthorizationError("feature_not_entitled");
  }
}
