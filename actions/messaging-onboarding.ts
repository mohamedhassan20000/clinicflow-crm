"use server";

import { revalidatePath } from "next/cache";
import { actionError } from "@/lib/i18n/action-errors";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { requireMutationRole, requireRole } from "@/lib/rbac";
import {
  connectMetaChannel,
  getMetaChannelState,
  type MetaChannelState,
} from "@/lib/messaging/channel-management";
import { reconcileMetaChannel } from "@/lib/messaging/meta-reconcile";
import { metaOnboardingCompletionSchema } from "@/lib/validations/messaging";

export type OnboardingActionResult = {
  success?: boolean;
  error?: string;
  state?: MetaChannelState;
};

/** Admin+Manager read of the current Meta connection state for the wizard/status card. */
export async function readMetaChannelState(): Promise<MetaChannelState> {
  const user = await requireRole(["admin", "manager"]);
  return getMetaChannelState(user.clinicId);
}

/**
 * P6C completion (plan line 1309, step 4): the wizard hands back the Embedded
 * Signup `code` plus the phone-number / WABA ids Meta returned to the popup. We
 * exchange the code for a token, store the channel through the encryption boundary,
 * subscribe the webhook, then run one reconciliation poll so the confirmed state is
 * shown immediately. Admin-only mutation, entitlement-gated (same P3B rules).
 */
export async function completeMetaOnboarding(input: {
  code: string;
  phoneNumberId: string;
  wabaId: string;
}): Promise<OnboardingActionResult> {
  const user = await requireMutationRole("admin");
  if (!hasFeature(await getEntitlements(user.clinicId), "whatsapp")) {
    return { error: await actionError("messaging.whatsAppIsNotIncludedInYourPlan") };
  }
  const parsed = metaOnboardingCompletionSchema.safeParse(input);
  if (!parsed.success) {
    return { error: await actionError("messaging.invalidMetaOnboardingDetails") };
  }

  const connected = await connectMetaChannel({
    clinicId: user.clinicId,
    ...parsed.data,
  });
  if (!connected.ok) {
    const key =
      connected.code === "IDENTITY_TAKEN"
        ? "messaging.metaPhoneNumberAlreadyConnected"
        : connected.code === "CONFIGURATION"
          ? "messaging.messagingEnvironmentIsNotConfigured"
          : "messaging.couldNotCompleteMetaOnboarding";
    return { error: await actionError(key) };
  }

  // Return-from-popup reconciliation (hybrid refresh). A poll failure is not fatal:
  // the channel exists and the cron/manual refresh will pick it up.
  await reconcileMetaChannel(user.clinicId).catch(() => undefined);
  revalidatePath("/settings/messaging");
  return { success: true, state: await getMetaChannelState(user.clinicId) };
}

/**
 * Manual "Refresh status" (hybrid refresh). Admin+Manager may trigger a
 * reconciliation poll; returns the freshly derived state. Read-and-derive only —
 * never resubmits verification or mutates Meta review state.
 */
export async function refreshMetaConnectionState(): Promise<OnboardingActionResult> {
  const user = await requireRole(["admin", "manager"]);
  if (!hasFeature(await getEntitlements(user.clinicId), "whatsapp")) {
    return { error: await actionError("messaging.whatsAppIsNotIncludedInYourPlan") };
  }
  const result = await reconcileMetaChannel(user.clinicId);
  if (!result.ok) {
    return { error: await actionError("messaging.couldNotRefreshConnectionStatus") };
  }
  revalidatePath("/settings/messaging");
  return { success: true, state: await getMetaChannelState(user.clinicId) };
}
