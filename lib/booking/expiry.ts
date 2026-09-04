import "server-only";

import {
  expireAiAppointmentRequests,
  expireAiPendingBookings,
} from "@/lib/supabase/admin";

export type PendingBookingExpirySummary = {
  expired: number;
  expiredRequests: number;
};

/**
 * P5A sub-job on the existing P3D daily cron. The database owns selection,
 * transition validation, locking, and audit so concurrent cron retries cannot
 * expire the same row twice.
 */
export async function runAiPendingBookingExpiry(
  now = new Date(),
): Promise<PendingBookingExpirySummary> {
  const [bookings, requests] = await Promise.all([
    expireAiPendingBookings(now),
    expireAiAppointmentRequests(now),
  ]);
  if (bookings.error) throw bookings.error;
  if (requests.error) throw requests.error;
  return {
    expired: bookings.data?.[0]?.expired_count ?? 0,
    expiredRequests: requests.data?.[0]?.expired_count ?? 0,
  };
}
