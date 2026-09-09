/**
 * The online-booking eligibility rule, in one place.
 *
 * ## Why this is a module and not a constant
 *
 * The clinic's rule — "nothing the assistant offers may be sooner than the day
 * after tomorrow" — has to hold at six different moments: the first day list,
 * a refinement of it, a directly named date, a correction, a re-query after a
 * refused slot, and the final write. Before this module the only thing
 * resembling a rule was `now + 24h` applied inside the slot filter in
 * {@link file://./patient.ts}, which is a *duration* and not a *calendar day*:
 * at 09:00 it excluded tomorrow morning and offered tomorrow afternoon, and at
 * 23:00 it offered almost all of the day after next. A patient could therefore
 * be shown a slot the clinic would not honour, pick it, and be refused at the
 * write — which is the loop this rule removes.
 *
 * Everything here is a **calendar-day** decision taken in the clinic's own
 * timezone. That is the unit the rule is written in ("not today, not
 * tomorrow"), it is the unit the availability reads speak (`YYYY-MM-DD` values
 * produced with `formatInTimeZone`), and it is the only unit under which the
 * answer does not change with the hour the patient happens to message at.
 *
 * The rule is a **floor, not a schedule**. It says which days are too soon; it
 * says nothing about whether the clinic or the doctor works on the days that
 * survive it. Real working days and real free slots are still decided by
 * `computeAvailability`, downstream and unchanged — so a floor landing on a
 * Friday the doctor does not work simply produces no days on that Friday, and
 * the first day actually offered is the first working day at or after it.
 *
 * Pure: no I/O, no model. `now` is always passed in.
 */

import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { addCalendarDays } from "@/lib/appointments/calendar";

/**
 * How many clinic-local days must pass before a day may be offered online.
 *
 * Two: today is excluded, tomorrow is excluded, and the day after tomorrow is
 * the earliest bookable calendar day. Written as a number rather than as three
 * separate checks so that a clinic policy change is one edit here and not a
 * search across the flows, the tools and the writer.
 */
export const ONLINE_BOOKING_LEAD_DAYS = 2;

/** The clinic's own calendar date right now. */
export function clinicToday(now: Date, timeZone: string): string {
  return formatInTimeZone(now, timeZone, "yyyy-MM-dd");
}

/**
 * The earliest calendar day online booking may offer.
 *
 * Inclusive: this date is bookable, everything before it is not.
 */
export function earliestOnlineBookableDate(now: Date, timeZone: string): string {
  return addCalendarDays(clinicToday(now, timeZone), ONLINE_BOOKING_LEAD_DAYS);
}

/**
 * The instant that day begins at the clinic.
 *
 * The slot filter needs a comparable instant rather than a date string, and
 * building it here keeps the conversion in the same file as the rule: a
 * midnight computed in the server's zone would move the boundary by hours for
 * every host outside the clinic's country.
 */
export function earliestOnlineBookableInstant(now: Date, timeZone: string): Date {
  return fromZonedTime(
    `${earliestOnlineBookableDate(now, timeZone)}T00:00:00`,
    timeZone,
  );
}

/** True when a `YYYY-MM-DD` clinic-local date is far enough ahead to offer. */
export function isOnlineBookableDate(
  date: string,
  now: Date,
  timeZone: string,
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return date >= earliestOnlineBookableDate(now, timeZone);
}

/**
 * Why a date is too soon, or null when it is not.
 *
 * The distinction matters to the patient: "that's today" and "that's tomorrow"
 * both mean "call the clinic", but a date three days in the past is a
 * misreading rather than a policy refusal, and telling somebody the clinic's
 * phone number because they typed last Tuesday would be answering a question
 * they did not ask.
 */
export function tooSoonReason(
  date: string,
  now: Date,
  timeZone: string,
): "past" | "today" | "tomorrow" | "too_soon" | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const today = clinicToday(now, timeZone);
  if (date < today) return "past";
  if (date === today) return "today";
  if (date === addCalendarDays(today, 1)) return "tomorrow";
  return isOnlineBookableDate(date, now, timeZone) ? null : "too_soon";
}

/**
 * A window start that respects the rule and any bound the patient set.
 *
 * One expression, used by every availability read, so "search from the day
 * after the eleventh" and "never search before the day after tomorrow" cannot
 * disagree. `after` is **exclusive** — it is the last day the patient ruled
 * out — which is the contract `parseDateLowerBound` produces and the day step
 * has always assumed.
 */
export function bookableWindowStart(input: {
  now: Date;
  timeZone: string;
  after?: string | null;
}): string {
  const floor = earliestOnlineBookableDate(input.now, input.timeZone);
  const bound =
    input.after && /^\d{4}-\d{2}-\d{2}$/.test(input.after)
      ? addCalendarDays(input.after, 1)
      : null;
  return bound && bound > floor ? bound : floor;
}
