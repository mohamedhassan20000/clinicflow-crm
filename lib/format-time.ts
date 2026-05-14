import { CLINIC_TZ } from "@/lib/datetime";

export type TimeFormat = "12h" | "24h";

const TZ = CLINIC_TZ;

/**
 * Format a Date or ISO string as a clinic time (Istanbul timezone).
 * Returns "HH:MM" for 24h, "h:MM AM/PM" for 12h.
 */
export function formatTime(date: Date | string, format: TimeFormat = "24h"): string {
  const d = typeof date === "string" ? new Date(date) : date;
  if (format === "12h") {
    return d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: TZ,
    });
  }
  return d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: TZ,
  });
}

/**
 * Format a "HH:MM" slot string based on the chosen format.
 * Used in the time picker where slots are stored as "HH:MM" strings.
 */
export function formatSlotTime(slotTime: string, format: TimeFormat = "24h"): string {
  if (format === "24h") return slotTime;
  const [h, m] = slotTime.split(":").map(Number);
  const hour = h ?? 0;
  const minute = m ?? 0;
  const period = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${period}`;
}
