import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import { format as formatDate, startOfWeek } from "date-fns";

export const CLINIC_TZ = "Europe/Istanbul";

export function toIstanbul(date: Date | string | number): Date {
  return toZonedTime(date, CLINIC_TZ);
}

export function formatSlot(date: Date | string | number): string {
  return formatInTimeZone(date, CLINIC_TZ, "EEE d MMM · HH:mm");
}

export function formatDay(date: Date | string | number): string {
  return formatInTimeZone(date, CLINIC_TZ, "EEEE, d MMMM yyyy");
}

export function formatTime(date: Date | string | number): string {
  return formatInTimeZone(date, CLINIC_TZ, "HH:mm");
}

// Turkey uses Monday-first weeks.
export function startOfWeekTR(date: Date): Date {
  return startOfWeek(toIstanbul(date), { weekStartsOn: 1 });
}

export function isoDay(date: Date | string | number): string {
  return formatInTimeZone(date, CLINIC_TZ, "yyyy-MM-dd");
}

// Rough re-export for consistency when no TZ formatting is needed.
export { formatDate };
