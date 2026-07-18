"use server";

import { revalidatePath } from "next/cache";
import { actionError } from "@/lib/i18n/action-errors";
import { requireMutationUser } from "@/lib/rbac";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import { notificationIdSchema } from "@/lib/validations/messaging";

export type NotificationActionResult = {
  success?: boolean;
  error?: string;
};

/**
 * P3D §7.5 — mark-as-read. Reads run on the recipient-scoped RLS policy;
 * writes go through the reviewed service-role path (the table carries no
 * authenticated write policies) and are always constrained to the caller's
 * own rows.
 */
export async function markNotificationRead(
  id: string,
): Promise<NotificationActionResult> {
  const user = await requireMutationUser();
  const parsed = notificationIdSchema.safeParse({ id });
  if (!parsed.success) {
    return { error: await actionError("notifications.couldNotUpdateNotifications") };
  }
  const updated = await createClinicScopedAdminClient(user.clinicId)
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", parsed.data.id)
    .eq("recipient_id", user.id)
    .is("read_at", null);
  if (updated.error) {
    return { error: await actionError("notifications.couldNotUpdateNotifications") };
  }
  revalidatePath("/notifications");
  return { success: true };
}

export async function markAllNotificationsRead(): Promise<NotificationActionResult> {
  const user = await requireMutationUser();
  const updated = await createClinicScopedAdminClient(user.clinicId)
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("recipient_id", user.id)
    .is("read_at", null);
  if (updated.error) {
    return { error: await actionError("notifications.couldNotUpdateNotifications") };
  }
  revalidatePath("/notifications");
  return { success: true };
}
