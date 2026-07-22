import "server-only";

import * as Sentry from "@sentry/nextjs";
import { AI_ASSISTANT_FEATURE } from "@/lib/ai/authorization";
import {
  resolveAssistantCapabilities,
  type AssistantCapabilities,
} from "@/lib/ai/capabilities";
import { checkAiTurn } from "@/lib/ai/usage";
import {
  loadLatestDoctorConversation,
  type LoadedDoctorConversation,
} from "@/lib/ai/conversations";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import type { AuthedUser } from "@/lib/rbac";
import { getPageVisibilityState } from "@/lib/server-page-permissions";
import { createClient } from "@/lib/supabase/server";
import type { PromptLocale } from "@/lib/ai/prompts/doctor";

export type StaffAssistantSurfaceAccess =
  | { state: "available"; remaining: number; limit: number }
  | { state: "upgrade" }
  | { state: "cap_reached"; limit: number }
  | { state: "subscription_inactive" }
  | { state: "temporarily_unavailable" };

export async function getStaffAssistantSurfaceAccess(
  user: AuthedUser,
  requiredFeatures: readonly string[] = [AI_ASSISTANT_FEATURE],
): Promise<StaffAssistantSurfaceAccess> {
  const entitlements = await getEntitlements(user.clinicId);
  if (!entitlements.subscriptionAllowed) return { state: "subscription_inactive" };
  if (!requiredFeatures.every((feature) => hasFeature(entitlements, feature))) {
    return { state: "upgrade" };
  }

  const usage = await checkAiTurn(user.clinicId);
  if (usage.reason === "lookup_failed") return { state: "temporarily_unavailable" };
  if (usage.reason === "subscription_inactive") return { state: "subscription_inactive" };
  if (!usage.allowed) return { state: "cap_reached", limit: usage.limit };
  return { state: "available", remaining: usage.remaining, limit: usage.limit };
}

export async function loadAssistantConversationForSurface(input: {
  user: AuthedUser;
  patientId?: string | null;
}): Promise<{
  conversation: LoadedDoctorConversation | null;
  persistenceAvailable: boolean;
}> {
  try {
    return {
      conversation: await loadLatestDoctorConversation({
        supabase: await createClient(),
        user: input.user,
        patientId: input.patientId,
      }),
      persistenceAvailable: true,
    };
  } catch (error) {
    Sentry.captureException(error, {
      tags: { area: "staff-assistant-conversation-load" },
      extra: { clinicId: input.user.clinicId, role: input.user.role },
    });
    return { conversation: null, persistenceAvailable: false };
  }
}

export type StaffAssistantPageResolution =
  | { state: "hidden" }
  | {
      state: "render";
      access: StaffAssistantSurfaceAccess;
      conversation: LoadedDoctorConversation | null;
      capabilities: AssistantCapabilities | null;
    };

export async function resolveStaffAssistantPage(
  user: AuthedUser,
  locale: PromptLocale = "en",
): Promise<StaffAssistantPageResolution> {
  const visibility = await getPageVisibilityState(user, "assistant");
  if (visibility === "hidden") return { state: "hidden" };
  if (visibility === "lookup_failed") {
    return {
      state: "render",
      access: { state: "temporarily_unavailable" },
      conversation: null,
      capabilities: null,
    };
  }

  let access = await getStaffAssistantSurfaceAccess(user);
  if (access.state !== "available") {
    return { state: "render", access, conversation: null, capabilities: null };
  }

  // P4.6B: resolved only once the surface is actually usable. Capabilities
  // describe the tool mount; there is nothing to describe on a gated surface,
  // and the access gate is the right place to explain a gated one.
  const [loaded, capabilities] = await Promise.all([
    loadAssistantConversationForSurface({ user }),
    resolveAssistantCapabilities(user, locale),
  ]);
  if (!loaded.persistenceAvailable) {
    access = { state: "temporarily_unavailable" };
  }
  return {
    state: "render",
    access,
    conversation: loaded.conversation,
    capabilities,
  };
}

export type DoctorAssistantSurfaceAccess = StaffAssistantSurfaceAccess;
export const getDoctorAssistantSurfaceAccess = getStaffAssistantSurfaceAccess;
