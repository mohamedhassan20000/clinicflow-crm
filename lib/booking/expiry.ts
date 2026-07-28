import "server-only";

import { expireAiPendingBookings } from "@/lib/supabase/admin";

export type PendingBookingExpirySummary = {
  expired: number;
};

/**
 * P5A sub-job on the existing P3D daily cron. The database owns selection,
 * transition validation, locking, and audit so concurrent cron retries cannot
 * expire the same row twice.
 */
export async function runAiPendingBookingExpiry(
  now = new Date(),
): Promise<PendingBookingExpirySummary> {
  const { data, error } = await expireAiPendingBookings(now);
  if (error) throw error;
  return { expired: data?.[0]?.expired_count ?? 0 };
}
