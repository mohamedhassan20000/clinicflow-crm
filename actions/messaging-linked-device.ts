"use server";

import { revalidatePath } from "next/cache";
import { actionError } from "@/lib/i18n/action-errors";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { requireMutationRole, requireRole } from "@/lib/rbac";
import {
  disconnectLinkedDeviceSession,
  readLinkedDeviceSession,
  requestLinkedDeviceHistorySync,
  startLinkedDeviceSession,
} from "@/lib/messaging/linked-device";
import {
  NOT_STARTED_LINKED_DEVICE_VIEW,
  type LinkedDeviceView,
} from "@/lib/messaging/linked-device-view";

/**
 * P7E — the three actions behind "Connect with QR".
 *
 * Every one of them derives the clinic from the caller's own session through
 * requireRole/requireMutationRole and never accepts a clinic id as input, so a
 * clinic can only ever start, inspect or end *its own* pairing. What comes back
 * is the collapsed view: a status, the code image, the paired number. No
 * authentication state, worker address, session identifier or library error can
 * reach the browser through these.
 */

export type LinkedDeviceActionResult = {
  success?: boolean;
  error?: string;
  view: LinkedDeviceView;
};

/**
 * Starts the pairing and returns whatever state the worker has reached by the
 * time it answers. The code itself usually appears a moment later, which the
 * panel picks up on its next poll — so this never blocks waiting for WhatsApp.
 */
export async function startWhatsAppQrSession(): Promise<LinkedDeviceActionResult> {
  const user = await requireMutationRole("admin");
  if (!hasFeature(await getEntitlements(user.clinicId), "whatsapp")) {
    return {
      error: await actionError("messaging.whatsAppIsNotIncludedInYourPlan"),
      view: NOT_STARTED_LINKED_DEVICE_VIEW,
    };
  }

  const started = await startLinkedDeviceSession(user.clinicId);
  if (!started.ok) {
    const key =
      started.code === "OWNED_BY_META"
        ? "messaging.disconnectTheMetaApiConnectionFirst"
        : started.code === "OWNED_ELSEWHERE"
          ? "messaging.thisClinicsWhatsAppSessionIsHeldByAnotherService"
          : started.code === "WORKER_UPDATE_REQUIRED"
            ? "messaging.whatsAppServiceUpdateRequiredBeforePairing"
            : "messaging.theWhatsAppConnectionServiceIsUnavailable";
    return {
      error: await actionError(key),
      // A start that failed must leave the panel showing *why*, not a spinner.
      // The stored row is usually still `not_started` or `disconnected` at this
      // point — neither is a state the panel polls out of — so the failure is
      // reported as one instead of being read back from a row that never
      // changed. `OWNED_BY_META` keeps the row's own view: that card explains
      // the conflict itself and there is nothing to retry.
      view:
        started.code === "OWNED_BY_META"
          ? await readLinkedDeviceSession(user.clinicId)
          : {
              ...NOT_STARTED_LINKED_DEVICE_VIEW,
              status: "error",
              // An out-of-date pairing service is not "try again in a moment":
              // the panel has to say the one true thing, or an admin will sit
              // pressing Regenerate against a worker that will never comply.
              errorCode:
                started.code === "WORKER_UPDATE_REQUIRED" ? "worker_outdated" : "unavailable",
            },
    };
  }
  revalidatePath("/settings/messaging");
  return { success: true, view: started.view };
}

/**
 * The panel's poll while a code is on screen. Admin+Manager, read-only, and it
 * answers from the durable session row rather than the worker, so a busy worker
 * can never make this hang.
 */
export async function readWhatsAppQrSession(): Promise<LinkedDeviceView> {
  const user = await requireRole(["admin", "manager"]);
  return readLinkedDeviceSession(user.clinicId);
}

/**
 * Ends the pairing: WhatsApp is told to drop the linked device, the stored
 * authentication state is destroyed, and the channel — with the number it held —
 * is released so the clinic can pair a different phone or switch methods.
 */
export async function disconnectWhatsAppQrSession(): Promise<LinkedDeviceActionResult> {
  const user = await requireMutationRole("admin");
  const removed = await disconnectLinkedDeviceSession(user.clinicId);
  if (!removed.ok) {
    return {
      error: await actionError("messaging.couldNotDisconnectWhatsApp"),
      view: await readLinkedDeviceSession(user.clinicId),
    };
  }
  revalidatePath("/settings/messaging");
  revalidatePath("/inbox");
  return { success: true, view: await readLinkedDeviceSession(user.clinicId) };
}

/**
 * "Sync WhatsApp history" — asks the already-paired device for older messages.
 *
 * Explicit on purpose. WhatsApp pushes history once, when a device is linked; a
 * reconnect gets `RECENT` or nothing. The only supported way to ask for more is
 * an on-demand peer request per conversation, anchored on a message the device
 * already holds — so this is a button an admin presses, not something forced on
 * every reconnect.
 *
 * It cannot log out, re-pair, wipe authentication state, or reach a conversation
 * belonging to a different WhatsApp account: the clinic comes from the caller's
 * own session, and every account-scope and ownership guard lives in the worker,
 * which is the only side that can see which account the socket is authenticated
 * as. What arrives back rides the ordinary history spool and shows up in the
 * clinic's existing import progress.
 */
export async function syncWhatsAppHistory(): Promise<
  { success: true; chats: number } | { error: string }
> {
  const user = await requireMutationRole("admin");
  if (!hasFeature(await getEntitlements(user.clinicId), "whatsapp")) {
    return { error: await actionError("messaging.whatsAppIsNotIncludedInYourPlan") };
  }
  const outcome = await requestLinkedDeviceHistorySync(user.clinicId);
  if (!outcome.ok) {
    const key =
      outcome.code === "NO_SESSION" || outcome.code === "NOT_CONNECTED"
        ? "messaging.whatsAppHistorySyncNeedsConnectedSession"
        : outcome.code === "NO_ANCHORS"
          ? "messaging.whatsAppHistorySyncHasNoAnchorPoint"
          : outcome.code === "IN_PROGRESS"
            ? "messaging.whatsAppHistorySyncAlreadyRunning"
            : outcome.code === "COOLDOWN"
              ? "messaging.whatsAppHistorySyncTooSoon"
              : outcome.code === "UNSUPPORTED"
                ? "messaging.whatsAppHistorySyncNotSupportedByService"
                : "messaging.couldNotSyncWhatsAppHistory";
    return { error: await actionError(key) };
  }
  // The messages themselves arrive asynchronously, so what is revalidated here
  // is the progress surface, not the result.
  revalidatePath("/settings/messaging");
  return { success: true, chats: outcome.chats };
}
