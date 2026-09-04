import "server-only";

import {
  createClinicScopedAdminClient,
  emitClinicNotificationRows,
} from "@/lib/supabase/admin";
import type { AuthedUser } from "@/lib/rbac";

export type PrivilegedNotificationResult =
  | { delivered: true; recipientCount: number }
  | {
      delivered: false;
      reason: "recipient_lookup_failed" | "no_active_admin" | "emit_failed";
    };

export type PrivilegedNotifier = (input: {
  user: AuthedUser;
  actionId: string;
  targetUserId: string;
  targetName: string;
  receiptId: string;
}) => Promise<PrivilegedNotificationResult>;

/**
 * Phase 5f admin notification.
 *
 * F5: this deliberately **reports** failure instead of throwing it. Delivery
 * happens after the mutation has already committed and after its receipt has
 * been finalized, so a notification error is a notification error — never
 * evidence that the role change failed. The caller records the delivery failure
 * on its own auditable path (see `executeRegisteredAction`).
 */
export async function notifyClinicAdminsOfPrivilegedAction(input: {
  user: AuthedUser;
  actionId: string;
  targetUserId: string;
  targetName: string;
  receiptId: string;
}): Promise<PrivilegedNotificationResult> {
  const admin = createClinicScopedAdminClient(input.user.clinicId);
  const recipients = await admin
    .from("profiles")
    .select("id")
    .eq("role", "admin")
    .eq("is_active", true)
    .eq("is_deleted", false)
    .is("deleted_at", null);
  if (recipients.error) {
    return { delivered: false, reason: "recipient_lookup_failed" };
  }
  if (!recipients.data?.length) {
    return { delivered: false, reason: "no_active_admin" };
  }
  const emitted = await emitClinicNotificationRows({
    clinicId: input.user.clinicId,
    recipientIds: recipients.data.map((recipient) => recipient.id),
    type: "ai_privileged_change",
    link: "/settings/staff",
    data: {
      actorName: input.user.fullName,
      actionId: input.actionId,
      targetName: input.targetName,
      targetUserId: input.targetUserId,
    },
    dedupeKey: `ai_privileged_change|${input.receiptId}`,
  });
  if (emitted.error || !emitted.data) {
    return { delivered: false, reason: "emit_failed" };
  }
  return { delivered: true, recipientCount: recipients.data.length };
}
