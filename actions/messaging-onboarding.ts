"use server";

import { revalidatePath } from "next/cache";
import { actionError } from "@/lib/i18n/action-errors";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { requireMutationRole, requireRole } from "@/lib/rbac";
import {
  connectMetaChannel,
  connectMetaChannelManually,
  disconnectMetaChannel,
  getMetaChannelState,
  type MetaChannelState,
} from "@/lib/messaging/channel-management";
import {
  toWhatsAppBusinessConnectionView,
  type WhatsAppBusinessConnectionView,
} from "@/lib/messaging/connection-view";
import { reconcileMetaChannel } from "@/lib/messaging/meta-reconcile";
import {
  manualMetaConnectionSchema,
  metaOnboardingCompletionSchema,
  whatsappBusinessOnboardingSchema,
} from "@/lib/validations/messaging";

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

export type WhatsAppBusinessActionResult = {
  success?: boolean;
  error?: string;
  connection?: WhatsAppBusinessConnectionView;
};

/**
 * P7C — completion of the "Connect WhatsApp Business" (Coexistence) flow.
 *
 * The browser hands back only what Meta's own popup gave it: an authorization
 * code and the asset ids it claims. Everything that decides whether the clinic is
 * actually connected happens here and below: the code is exchanged for a token,
 * the token is introspected and matched against the claimed WABA, the WABA is
 * confirmed to be shared with this platform, the number is confirmed to belong to
 * it and to be live on the WhatsApp Business app, our system user is assigned and
 * verified, and the webhook subscription is created and read back. Only then are
 * credentials stored and the channel allowed to progress toward `connected` —
 * which is what flips clinic_channels.status to `active` and thereby opens the
 * existing WhatsApp inbox and automated sends.
 *
 * The result is deliberately narrow: a UI state and the display number. Provider
 * ids, tokens, webhook details and raw Meta errors never reach the client.
 */
export async function connectWhatsAppBusinessAccount(input: {
  code: string;
  phoneNumberId: string;
  wabaId: string;
}): Promise<WhatsAppBusinessActionResult> {
  const user = await requireMutationRole("admin");
  if (!hasFeature(await getEntitlements(user.clinicId), "whatsapp")) {
    return { error: await actionError("messaging.whatsAppIsNotIncludedInYourPlan") };
  }
  const parsed = whatsappBusinessOnboardingSchema.safeParse(input);
  if (!parsed.success) {
    return { error: await actionError("messaging.couldNotConnectWhatsAppBusiness") };
  }

  const connected = await connectMetaChannel({
    clinicId: user.clinicId,
    ...parsed.data,
    flow: "coexistence",
  });
  if (!connected.ok) {
    // Every provider/configuration failure collapses to one plain message; only
    // the already-claimed number is distinguished, because that one is
    // actionable by the clinic.
    return {
      error: await actionError(
        connected.code === "IDENTITY_TAKEN"
          ? "messaging.metaPhoneNumberAlreadyConnected"
          : "messaging.couldNotConnectWhatsAppBusiness",
      ),
    };
  }

  // One reconciliation pass so the confirmed state is shown immediately. A poll
  // failure is not fatal — the channel exists and the cron will pick it up; the
  // clinic simply stays on "Verifying" until then.
  await reconcileMetaChannel(user.clinicId).catch(() => undefined);
  const state = await getMetaChannelState(user.clinicId);
  revalidatePath("/settings/messaging");
  // Reaching `connected` activates the channel, so the WhatsApp surfaces that
  // read it must not serve a stale cached shell.
  revalidatePath("/inbox");
  return { success: true, connection: toWhatsAppBusinessConnectionView(state) };
}

/**
 * Poll used by the "Verifying" step. Meta can take a moment to report the number
 * as live, so the card re-checks a few times before settling. Admin+Manager, read
 * side only — it runs the same reconciliation as the manual refresh and returns
 * the collapsed view.
 */
export async function readWhatsAppBusinessConnection(): Promise<WhatsAppBusinessConnectionView> {
  const user = await requireRole(["admin", "manager"]);
  const state = await getMetaChannelState(user.clinicId);
  if (state.configured && state.connectionState !== "connected") {
    await reconcileMetaChannel(user.clinicId).catch(() => undefined);
    return toWhatsAppBusinessConnectionView(await getMetaChannelState(user.clinicId));
  }
  return toWhatsAppBusinessConnectionView(state);
}

/**
 * P7D — "Connect with Meta API": stores the clinic's own Meta / WhatsApp Cloud
 * API credentials for this clinic only.
 *
 * The credentials are validated for shape here and then proved against Meta
 * inside the messaging boundary before anything is written; nothing is ever
 * stored on the strength of what was typed. Admin-only and entitlement-gated,
 * exactly like the two signup flows, and the result carries only the collapsed
 * view — no token, app secret, WABA id or raw Meta error crosses back.
 */
export async function connectMetaApiCredentials(input: {
  appId: string;
  appSecret: string;
  accessToken: string;
  phoneNumberId: string;
  wabaId: string;
}): Promise<WhatsAppBusinessActionResult> {
  const user = await requireMutationRole("admin");
  if (!hasFeature(await getEntitlements(user.clinicId), "whatsapp")) {
    return { error: await actionError("messaging.whatsAppIsNotIncludedInYourPlan") };
  }
  const parsed = manualMetaConnectionSchema.safeParse(input);
  if (!parsed.success) {
    return { error: await actionError("messaging.enterValidMetaApiCredentials") };
  }

  const connected = await connectMetaChannelManually({
    clinicId: user.clinicId,
    credentials: parsed.data,
  });
  if (!connected.ok) {
    // Only the two outcomes the clinic can actually act on are distinguished:
    // a number another clinic already holds, and a number that differs from the
    // one currently connected (which requires disconnecting first). Everything
    // else — a rejected token, an unreachable Graph API, a broken envelope —
    // collapses to one message so no provider detail leaks.
    const key =
      connected.code === "IDENTITY_TAKEN"
        ? "messaging.metaPhoneNumberAlreadyConnected"
        : connected.code === "CONFIGURATION"
          ? "messaging.disconnectBeforeConnectingADifferentNumber"
          : "messaging.couldNotVerifyMetaApiCredentials";
    return { error: await actionError(key) };
  }

  // One reconciliation pass so the confirmed state is shown immediately; a poll
  // failure leaves the card on "Verifying" until the cron catches up.
  await reconcileMetaChannel(user.clinicId).catch(() => undefined);
  const state = await getMetaChannelState(user.clinicId);
  revalidatePath("/settings/messaging");
  revalidatePath("/inbox");
  return { success: true, connection: toWhatsAppBusinessConnectionView(state) };
}

/**
 * P7D — disconnects this clinic's WhatsApp channel, whichever of the two
 * methods established it.
 *
 * Admin-only. Scoped to the caller's own clinic by `requireMutationRole`, so it
 * can never reach another tenant's channel. Releasing the channel also releases
 * the globally unique sender identity, which is what allows the clinic to
 * connect a different number afterwards.
 */
export async function disconnectWhatsAppChannel(): Promise<WhatsAppBusinessActionResult> {
  const user = await requireMutationRole("admin");
  const removed = await disconnectMetaChannel(user.clinicId);
  if (!removed.ok) {
    return { error: await actionError("messaging.couldNotDisconnectWhatsApp") };
  }
  revalidatePath("/settings/messaging");
  revalidatePath("/inbox");
  return {
    success: true,
    connection: toWhatsAppBusinessConnectionView(
      await getMetaChannelState(user.clinicId),
    ),
  };
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
