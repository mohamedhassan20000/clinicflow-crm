import "server-only";

import { AI_ASSISTANT_FEATURE } from "@/lib/ai/authorization";
import { checkAiTurn } from "@/lib/ai/usage";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import type { AuthedUser } from "@/lib/rbac";

export type DoctorAssistantSurfaceAccess =
  | { state: "available"; remaining: number; limit: number }
  | { state: "upgrade" }
  | { state: "cap_reached"; limit: number }
  | { state: "subscription_inactive" }
  | { state: "temporarily_unavailable" };

export async function getDoctorAssistantSurfaceAccess(
  user: AuthedUser,
): Promise<DoctorAssistantSurfaceAccess> {
  const entitlements = await getEntitlements(user.clinicId);
  if (!entitlements.subscriptionAllowed) return { state: "subscription_inactive" };
  if (!hasFeature(entitlements, AI_ASSISTANT_FEATURE)) return { state: "upgrade" };

  const usage = await checkAiTurn(user.clinicId);
  if (usage.reason === "lookup_failed") return { state: "temporarily_unavailable" };
  if (usage.reason === "subscription_inactive") return { state: "subscription_inactive" };
  if (!usage.allowed) return { state: "cap_reached", limit: usage.limit };
  return { state: "available", remaining: usage.remaining, limit: usage.limit };
}
