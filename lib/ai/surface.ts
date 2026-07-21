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
): Promise<StaffAssistantSurfaceAccess> {
  const entitlements = await getEntitlements(user.clinicId);
  if (!entitlements.subscriptionAllowed) return { state: "subscription_inactive" };
  if (!hasFeature(entitlements, AI_ASSISTANT_FEATURE)) return { state: "upgrade" };

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

export async function resolvePatientAssistantLauncher(input: {
  user: AuthedUser;
  patientId: string;
}): Promise<{
  access: Extract<StaffAssistantSurfaceAccess, { state: "available" }>;
  conversation: LoadedDoctorConversation | null;
} | null> {
  if (input.user.role !== "doctor") return null;
  try {
    if ((await getPageVisibilityState(input.user, "assistant")) !== "visible") return null;

    const access = await getStaffAssistantSurfaceAccess(input.user);
    if (access.state !== "available") return null;

    const loaded = await loadAssistantConversationForSurface({
      user: input.user,
      patientId: input.patientId,
    });
    if (!loaded.persistenceAvailable) return null;
    return { access, conversation: loaded.conversation };
  } catch (error) {
    // The launcher is optional patient-page enhancement data. Any AI-specific
    // dependency failure must leave the independently authorized patient
    // record usable.
    Sentry.captureException(error, {
      tags: { area: "patient-assistant-launcher" },
      extra: { clinicId: input.user.clinicId, role: input.user.role },
    });
    return null;
  }
}

export type DoctorAssistantSurfaceAccess = StaffAssistantSurfaceAccess;
export const getDoctorAssistantSurfaceAccess = getStaffAssistantSurfaceAccess;
