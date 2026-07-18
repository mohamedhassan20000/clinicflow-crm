import "server-only";
import { toNumberingLocale } from "@/lib/datetime";

/**
 * Shared patient-facing date/time formatting for the automated senders
 * (reminders §7.2b, appointment events §7.2a). Uses the clinic's timezone,
 * locale, digit system, and 12h/24h preference — this is patient content, so
 * it follows the clinic's settings, never a staff UI locale.
 */
export type ClinicFormatContext = {
  timezone: string;
  locale: string;
  timeFormat: string;
  digits: string;
};

export function formatScheduledAt(
  scheduledAt: Date,
  context: ClinicFormatContext,
): { dateText: string; timeText: string } {
  const locale = toNumberingLocale({
    locale: context.locale,
    digits: context.digits === "arabic" ? "arabic" : "latin",
  });
  const dateText = new Intl.DateTimeFormat(locale, {
    timeZone: context.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(scheduledAt);
  const timeText = new Intl.DateTimeFormat(locale, {
    timeZone: context.timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: context.timeFormat === "12h",
  }).format(scheduledAt);
  return { dateText, timeText };
}
