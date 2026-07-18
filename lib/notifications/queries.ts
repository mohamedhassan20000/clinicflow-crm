import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/types/database";

/** dedupe_key is an internal emit-time concern; the read surface omits it. */
export type NotificationRow = Omit<
  Database["public"]["Tables"]["notifications"]["Row"],
  "dedupe_key"
>;

export const NOTIFICATION_LIST_LIMIT = 50;

/**
 * Reads run on the authenticated RLS client: the recipient-read policy is the
 * authorization boundary, so these helpers add no role logic of their own.
 */
export async function getUnreadNotificationCount(): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .is("read_at", null);
  if (error) return 0;
  return count ?? 0;
}

export async function listOwnNotifications(): Promise<NotificationRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("notifications")
    .select(
      "id, clinic_id, recipient_id, type, title, body, link, data, read_at, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(NOTIFICATION_LIST_LIMIT);
  if (error) return [];
  return data ?? [];
}
