/**
 * Day-first message timestamps for the Inbox.
 *
 * `Intl` orders a numeric date by *locale convention*, and the application's
 * English locale is plain `"en"` — which is US English, which is month-first.
 * So a message sent on the 30th of August rendered as `8/30/26`, a format
 * nobody in the clinic reads that way. Arabic was already correct (`30/8/26`);
 * only English was wrong, and `dateStyle: "short"` gave no way to say so.
 *
 * This picks the *ordering* explicitly and changes nothing else. The instant
 * itself, the stored timestamp and the timezone the caller resolves are all
 * untouched — this formats a `Date` the caller already has.
 */

/**
 * The locale to format the date part in: the caller's own whenever it is
 * already day-first, and British English otherwise.
 *
 * Arabic is day-first everywhere it is used, and its own locale is what carries
 * the numbering system (`ar-EG` renders Arabic-Indic digits), so substituting
 * anything for it would be a regression.
 */
function dayFirstLocale(locale: string): string {
  return locale.toLowerCase().startsWith("ar") ? locale : "en-GB";
}

/** Whether the caller's locale writes a 12-hour clock, so the swap keeps it. */
function prefersHour12(locale: string): boolean {
  try {
    return new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hour12 === true;
  } catch {
    return true;
  }
}

/**
 * `D/M/YY, h:mm` — the Inbox message stamp.
 *
 * `timeZone` is optional and passed straight through; omitted, `Intl` uses the
 * viewer's own, which is what the Inbox has always done.
 */
export function formatInboxTimestamp(
  value: Date,
  locale: string,
  timeZone?: string,
): string {
  const options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "numeric",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: prefersHour12(locale),
    ...(timeZone ? { timeZone } : {}),
  };
  try {
    return new Intl.DateTimeFormat(dayFirstLocale(locale), options).format(value);
  } catch {
    return new Intl.DateTimeFormat("en-GB", options).format(value);
  }
}
