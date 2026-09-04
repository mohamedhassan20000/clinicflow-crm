export type OverduePendingAppointment = {
  status: string;
  scheduled_at: string;
  duration_minutes: number | null | undefined;
  deleted_at?: string | null;
  displaced_at?: string | null;
  replaced_by_appointment_id?: string | null;
};

/**
 * Operational state only. The persisted appointment status remains `pending`.
 *
 * Duration is authoritative throughout the calendar and replacement workflow,
 * so a pending appointment becomes overdue when its scheduled end passes. A
 * missing/invalid duration falls back to the scheduled start rather than
 * inventing a duration that was never stored.
 */
export function overduePendingThreshold(
  appointment: Pick<OverduePendingAppointment, "scheduled_at" | "duration_minutes">,
): number | null {
  const start = new Date(appointment.scheduled_at).valueOf();
  if (!Number.isFinite(start)) return null;
  const duration = Number(appointment.duration_minutes);
  const durationMs = Number.isFinite(duration) && duration > 0
    ? duration * 60_000
    : 0;
  return start + durationMs;
}

export function isOverduePending(
  appointment: OverduePendingAppointment,
  now: Date | number = Date.now(),
): boolean {
  if (appointment.status !== "pending") return false;
  if (appointment.deleted_at || appointment.displaced_at) return false;
  if (appointment.replaced_by_appointment_id) return false;
  const threshold = overduePendingThreshold(appointment);
  const nowMs = now instanceof Date ? now.valueOf() : now;
  return threshold !== null && Number.isFinite(nowMs) && threshold < nowMs;
}

export function overdueMinutes(
  appointment: Pick<OverduePendingAppointment, "scheduled_at" | "duration_minutes">,
  now: Date | number = Date.now(),
): number {
  const threshold = overduePendingThreshold(appointment);
  const nowMs = now instanceof Date ? now.valueOf() : now;
  if (threshold === null || !Number.isFinite(nowMs) || nowMs <= threshold) return 0;
  return Math.floor((nowMs - threshold) / 60_000);
}
