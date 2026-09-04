import {
  DEFAULT_TIME_ZONE,
  toNumberingLocale,
  type ClinicLocale,
} from "@/lib/datetime";

export type TimeFormat = "12h" | "24h";

const TZ = DEFAULT_TIME_ZONE;

/**
 * Format a Date or ISO string as a clinic time (Istanbul timezone).
 * Returns "HH:MM" for 24h, "h:MM AM/PM" for 12h.
 */
export function formatTime(
  date: Date | string,
  format: TimeFormat = "24h",
  locale?: Partial<ClinicLocale>,
): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const timeZone = locale?.timeZone ?? TZ;
  if (format === "12h") {
    return d.toLocaleTimeString(toNumberingLocale(locale), {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone,
    });
  }
  return d.toLocaleTimeString(toNumberingLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  });
}

/**
 * Format a "HH:MM" slot string based on the chosen format.
 * Used in the time picker where slots are stored as "HH:MM" strings.
 */
export function formatSlotTime(
  slotTime: string,
  format: TimeFormat = "24h",
  locale?: Partial<ClinicLocale>,
): string {
  const [h, m] = slotTime.split(":").map(Number);
  const hour = h ?? 0;
  const minute = m ?? 0;
  if (format === "24h") {
    return `${new Intl.NumberFormat(toNumberingLocale(locale), {
      minimumIntegerDigits: 2,
      useGrouping: false,
    }).format(hour)}:${new Intl.NumberFormat(toNumberingLocale(locale), {
      minimumIntegerDigits: 2,
      useGrouping: false,
    }).format(minute)}`;
  }
  const isArabic = locale?.locale?.toLowerCase().startsWith("ar") === true;
  const period = isArabic
    ? hour >= 12 ? "مساءً" : "صباحًا"
    : hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${new Intl.NumberFormat(toNumberingLocale(locale), {
    useGrouping: false,
  }).format(h12)}:${new Intl.NumberFormat(toNumberingLocale(locale), {
    minimumIntegerDigits: 2,
    useGrouping: false,
  }).format(minute)} ${period}`;
}
