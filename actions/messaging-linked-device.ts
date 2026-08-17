"use server";

import { revalidatePath } from "next/cache";
import { actionError } from "@/lib/i18n/action-errors";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { requireMutationRole, requireRole } from "@/lib/rbac";
import {
  disconnectLinkedDeviceSession,
  readLinkedDeviceSession,
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
        : "messaging.theWhatsAppConnectionServiceIsUnavailable";
    return {
      error: await actionError(key),
      view: await readLinkedDeviceSession(user.clinicId),
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
