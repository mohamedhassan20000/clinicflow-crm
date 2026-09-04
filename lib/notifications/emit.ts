import "server-only";
import * as Sentry from "@sentry/nextjs";
import {
  createClinicScopedAdminClient,
  emitClinicNotificationRows,
} from "@/lib/supabase/admin";

/**
 * Staff in-app notification emitters (§7.5). Notifications are awareness, not
 * records: emission is best-effort and never fails the flow that triggered it.
 *
 * Role broadcasts are fanned out to concrete recipients at emit time so read
 * state stays a per-row `read_at` (the plan's nullable-recipient broadcast row
 * would need a separate per-user read table before it could carry read state).
 *
 * Deduplication is database-enforced (P3-M2): the emit RPC inserts with
 * ON CONFLICT DO NOTHING against a partial unique index on
 * (recipient_id, dedupe_key) WHERE read_at IS NULL, so concurrent emitters
 * cannot double-insert while a matching notification is unread.
 */

export type NotificationType =
  | "inbox_message"
  | "reminder_failed"
  | "followup_failed"
  // P5B — patient AI (§6.2): a drafted reply awaits staff approval, or the
  // agent handed a conversation to a human.
  | "ai_suggestion"
  | "ai_escalation"
  | "ai_patient_intake"
  | "ai_booking_request"
  | "ai_privileged_change"
  // P12 — included AI usage crossed a notification threshold (75/90/100).
  | "ai_usage_threshold";

export type NotificationRole = "admin" | "receptionist" | "manager" | "doctor";

type EmitInput = {
  clinicId: string;
  type: NotificationType;
  /** In-app path only (the schema rejects absolute URLs). */
  link: string | null;
  /** Localized at render time from type + data — names/dates only, no clinical content. */
  data?: Record<string, string>;
  /** Explicit recipients; wins over roles. */
  recipientIds?: readonly string[];
  /** Fan-out roles when no explicit recipients are given. */
  roles?: readonly NotificationRole[];
  /**
   * Skip recipients who already have an unread notification of this type for
   * the same link, so a busy conversation or a retried cron failure does not
   * stack duplicates.
   */
  dedupeUnread?: boolean;
  /**
   * Narrows dedupeUnread further to notifications carrying these data pairs
   * (e.g. one unread failure per appointment instead of per link).
   */
  dedupeData?: Record<string, string>;
};

/** Deterministic dedupe scope: type + link + narrowing data pairs. */
export function notificationDedupeKey(
  input: Pick<EmitInput, "type" | "link" | "dedupeData">,
): string {
  const pairs = Object.entries(input.dedupeData ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return `${input.type}|${input.link ?? ""}|${pairs}`;
}

export async function emitClinicNotification(
  input: EmitInput,
): Promise<{ created: number }> {
  try {
    const client = createClinicScopedAdminClient(input.clinicId);

    let recipients = [...new Set(input.recipientIds ?? [])];
    if (recipients.length === 0 && input.roles && input.roles.length > 0) {
      const members = await client
        .from("profiles")
        .select("id")
        .in("role", [...input.roles])
        .eq("is_active", true)
        .eq("is_deleted", false)
        .is("deleted_at", null);
      if (members.error) throw members.error;
      recipients = (members.data ?? []).map((row) => row.id);
    }
    if (recipients.length === 0) return { created: 0 };

    const inserted = await emitClinicNotificationRows({
      clinicId: input.clinicId,
      recipientIds: recipients,
      type: input.type,
      link: input.link,
      data: input.data ?? {},
      dedupeKey: input.dedupeUnread ? notificationDedupeKey(input) : null,
    });
    if (inserted.error) throw inserted.error;
    return { created: inserted.data ?? 0 };
  } catch (error) {
    Sentry.captureException(error, {
      tags: { scope: "notifications", type: input.type },
    });
    return { created: 0 };
  }
}
