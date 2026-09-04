import "server-only";

import { formatInTimeZone } from "date-fns-tz";
import type { SupabaseClient } from "@supabase/supabase-js";
import { clinicDateRangeToUtc, resolveClinicTimeZone } from "@/lib/ai/tools/context";
import type { Database } from "@/types/database";

/**
 * Phase 7 (P7-02) — clinic-local date semantics for the generic read path.
 *
 * The tools the resource layer superseded (`list_appointments`,
 * `list_doctor_appointments`, `search_patient_visits`) never let the model name
 * an instant. They accepted a named preset or a `YYYY-MM-DD` clinic calendar
 * date and resolved it to UTC bounds **server-side, in the clinic's own
 * timezone** — `range.ts` states outright that the model "can never supply raw
 * timestamps or a timezone".
 *
 * When those tools were unmounted, `appointments.scheduled_at` and
 * `medical_notes.created_at` were left accepting offset-bearing instants only,
 * and nothing in the model's context carried the clinic timezone or the current
 * clinic-local date. "Show me today's appointments" — a suggestion chip Phase 7
 * deliberately re-pointed at `query_resource` — therefore depended on the model
 * inventing both an anchor date and a UTC offset, which silently returns the
 * wrong day's schedule at the edges for any clinic outside UTC.
 *
 * This module restores the removed semantics on the generic path, keeping the
 * property that mattered: **the timezone stays server-owned**. The model names a
 * clinic-local day or period; the server reads the clinic's IANA timezone from
 * the authenticated request and converts. The absolute-instant form still works
 * unchanged, so this is strictly additive.
 *
 * Calendar arithmetic is done on a *floating* calendar date (no timezone), and
 * only the final day boundaries are converted, through the same
 * `clinicDateRangeToUtc` the removed tools used. `resolveDateRange` in
 * `lib/date-range.ts` computes the same calendar boundaries against the fixed
 * `DEFAULT_TIME_ZONE`; `tests/unit/ai/phase7-clinic-date-semantics.test.ts`
 * asserts the two agree byte-for-byte for a clinic on that timezone, so an
 * assistant answer and the report page a user can open themselves still
 * reconcile.
 */

/**
 * Named clinic-local periods. The first six mirror `DateRangePreset` exactly so
 * the reconciliation test above is total over them; `yesterday` and `tomorrow`
 * are single-day derivations of the same clinic calendar, and `tomorrow` is the
 * one an appointment list actually needs.
 */
export const CLINIC_DATE_PRESETS = [
  "today",
  "yesterday",
  "tomorrow",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "last_year",
] as const;

export type ClinicDatePreset = (typeof CLINIC_DATE_PRESETS)[number];

export const CLINIC_LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const PRESETS = new Set<string>(CLINIC_DATE_PRESETS);

/** The clinic-local calendar day span a model-supplied value denotes. */
export type ClinicLocalDayRange = {
  /** Inclusive clinic-local calendar bounds, `YYYY-MM-DD`. */
  from: string;
  to: string;
  /** The absolute UTC instants those bounds resolve to, inclusive. */
  start: string;
  end: string;
};

/**
 * True when the value is a clinic-local form this module resolves, rather than
 * an absolute instant. An offset-bearing ISO datetime is left exactly as the
 * caller wrote it — the pre-Phase-7 behaviour, preserved.
 */
export function isClinicLocalDateInput(value: string): boolean {
  return CLINIC_LOCAL_DATE_RE.test(value) || PRESETS.has(value);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Formats a floating calendar date; never touches a timezone. */
function fmtFloating(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parses `YYYY-MM-DD` into a floating calendar date. */
function parseFloating(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year!, month! - 1, date!);
}

function shiftDays(day: string, days: number): string {
  const base = parseFloating(day);
  return fmtFloating(
    new Date(base.getFullYear(), base.getMonth(), base.getDate() + days),
  );
}

/**
 * Monday-start week, matching `resolveDateRange`'s `day === 0 ? -6 : 1 - day`.
 * The clinic's configured `week_start` is deliberately *not* consulted: the
 * report pages this must reconcile with use the same fixed rule, and diverging
 * here would make an assistant answer disagree with the report it cites.
 */
function weekStart(day: string): string {
  const base = parseFloating(day);
  const weekday = base.getDay();
  return shiftDays(day, weekday === 0 ? -6 : 1 - weekday);
}

/** The clinic's current calendar date, derived from the server clock. */
export function clinicToday(timeZone: string, now: Date): string {
  return formatInTimeZone(now, timeZone, "yyyy-MM-dd");
}

/**
 * Resolves a clinic-local calendar day or named period to its inclusive
 * `from`/`to` calendar bounds. Returns `null` for anything this module does not
 * own, so the caller can pass an absolute instant straight through.
 */
export function resolveClinicLocalDayRange(
  value: string,
  timeZone: string,
  now: Date,
): { from: string; to: string } | null {
  if (CLINIC_LOCAL_DATE_RE.test(value)) return { from: value, to: value };
  if (!PRESETS.has(value)) return null;

  const today = clinicToday(timeZone, now);
  const preset = value as ClinicDatePreset;

  if (preset === "today") return { from: today, to: today };
  if (preset === "yesterday") {
    const day = shiftDays(today, -1);
    return { from: day, to: day };
  }
  if (preset === "tomorrow") {
    const day = shiftDays(today, 1);
    return { from: day, to: day };
  }
  if (preset === "this_week") {
    const monday = weekStart(today);
    return { from: monday, to: shiftDays(monday, 6) };
  }
  if (preset === "last_week") {
    const monday = shiftDays(weekStart(today), -7);
    return { from: monday, to: shiftDays(monday, 6) };
  }
  if (preset === "this_month") {
    const base = parseFloating(today);
    return {
      from: fmtFloating(new Date(base.getFullYear(), base.getMonth(), 1)),
      to: fmtFloating(new Date(base.getFullYear(), base.getMonth() + 1, 0)),
    };
  }
  if (preset === "last_month") {
    const base = parseFloating(today);
    return {
      from: fmtFloating(new Date(base.getFullYear(), base.getMonth() - 1, 1)),
      to: fmtFloating(new Date(base.getFullYear(), base.getMonth(), 0)),
    };
  }

  // last_year — the rolling clinic year `resolveRollingYearRange` computes:
  // the same calendar day one year back, clamped when that month is shorter
  // (29 February into a non-leap year), through to today.
  const base = parseFloating(today);
  const priorYear = base.getFullYear() - 1;
  const month = base.getMonth();
  const lastDayInPriorMonth = new Date(priorYear, month + 1, 0).getDate();
  const day = Math.min(base.getDate(), lastDayInPriorMonth);
  return {
    from: fmtFloating(new Date(priorYear, month, day)),
    to: today,
  };
}

/**
 * The full resolution: clinic-local bounds plus the UTC instants they denote.
 * `start`/`end` come from `clinicDateRangeToUtc`, which is the exact function
 * the removed `list_doctor_appointments` / `search_patient_visits` used, so the
 * emitted bounds are byte-identical to what those tools produced.
 */
export function resolveClinicLocalRange(
  value: string,
  timeZone: string,
  now: Date,
): ClinicLocalDayRange | null {
  const bounds = resolveClinicLocalDayRange(value, timeZone, now);
  if (!bounds) return null;
  const { start, end } = clinicDateRangeToUtc(bounds.from, bounds.to, timeZone);
  return { ...bounds, start, end };
}

/**
 * A per-resolution memo for the clinic timezone read.
 *
 * A query may carry several clinic-local filters (a `gte` and an `lte`, or a
 * range on two resources in one turn); each one must resolve against the same
 * timezone, and re-reading `clinics.timezone` per filter would be a second
 * round trip for an answer that cannot change inside one request.
 */
export function clinicTimeZoneMemo(
  client: SupabaseClient<Database>,
  clinicId: string,
): () => Promise<string> {
  let pending: Promise<string> | null = null;
  return () => (pending ??= resolveClinicTimeZone(client, clinicId));
}
