"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionError } from "@/lib/i18n/action-errors";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import {
  runWhatsAppHealthAction as executeWhatsAppHealthAction,
  type WhatsAppHealthAction,
  type WhatsAppHealthActionCode,
} from "@/lib/messaging/health";
import { requireRole } from "@/lib/rbac";

const healthActionSchema = z.enum([
  "refresh_status",
  "sync_templates",
  "repair_webhook",
  "test_connectivity",
]);

export type WhatsAppHealthActionResult = {
  success?: boolean;
  code?: WhatsAppHealthActionCode;
  error?: string;
};

/**
 * P6D closed recovery registry. Admins and managers may run these strictly
 * read-and-retry actions; no action can submit a review, send a message, or
 * alter provider verification state.
 */
export async function runWhatsAppHealthAction(
  action: WhatsAppHealthAction,
): Promise<WhatsAppHealthActionResult> {
  const user = await requireRole(["admin", "manager"]);
  if (!hasFeature(await getEntitlements(user.clinicId), "whatsapp")) {
    return {
      code: "not_available",
      error: await actionError("messaging.whatsAppIsNotIncludedInYourPlan"),
    };
  }
  const parsed = healthActionSchema.safeParse(action);
  if (!parsed.success) {
    return {
      code: "not_available",
      error: await actionError("messaging.invalidWhatsAppHealthAction"),
    };
  }
  const result = await executeWhatsAppHealthAction({
    clinicId: user.clinicId,
    action: parsed.data,
  });
  if (!result.ok) {
    const key =
      result.code === "channel_unavailable"
        ? "messaging.whatsAppHealthChannelUnavailable"
        : result.code === "credentials_unavailable"
          ? "messaging.whatsAppHealthCredentialsUnavailable"
          : result.code === "not_available"
            ? "messaging.whatsAppHealthActionUnavailable"
            : "messaging.whatsAppHealthActionFailed";
    return { code: result.code, error: await actionError(key) };
  }

  revalidatePath("/settings/messaging");
  revalidatePath("/settings/messaging/health");
  revalidatePath("/settings/templates");
  return { success: true, code: "ok" };
}
