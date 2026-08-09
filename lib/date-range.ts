import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";

export type DateRangePreset =
  | "today"
  | "this_week"
  | "last_week"
  | "this_month"
  | "last_month"
  | "last_year"
  | "custom";

export type DateRangeInput = {
  preset?: DateRangePreset;
  from?: string;
  to?: string;
  now?: Date;
};

export type ResolvedDateRange = {
  preset: DateRangePreset;
  start: Date;
  end: Date;
  from: string;
  to: string;
};

export type RollingYearDateRange = Omit<ResolvedDateRange, "preset">;

function startOfClinicDay(date: Date): Date {
  const zoned = toZonedTime(date, DEFAULT_TIME_ZONE);
  return fromZonedTime(
    new Date(zoned.getFullYear(), zoned.getMonth(), zoned.getDate(), 0, 0, 0, 0),
    DEFAULT_TIME_ZONE,
  );
}

function endOfClinicDay(date: Date): Date {
  const zoned = toZonedTime(date, DEFAULT_TIME_ZONE);
  return fromZonedTime(
    new Date(zoned.getFullYear(), zoned.getMonth(), zoned.getDate(), 23, 59, 59, 999),
    DEFAULT_TIME_ZONE,
  );
}

function clinicDateInputToDate(value: string, endOfDay = false): Date {
  const time = endOfDay ? "T23:59:59.999" : "T00:00:00.000";
  return fromZonedTime(`${value}${time}`, DEFAULT_TIME_ZONE);
}

function fmtInput(date: Date): string {
  return formatInTimeZone(date, DEFAULT_TIME_ZONE, "yyyy-MM-dd");
}

/**
 * A clinic-calendar year ending on the clinic's current date. February 29 is
 * clamped to February 28 when the prior year is not a leap year.
 */
export function resolveRollingYearRange(now: Date = new Date()): RollingYearDateRange {
  const zonedNow = toZonedTime(now, DEFAULT_TIME_ZONE);
  const priorYear = zonedNow.getFullYear() - 1;
  const month = zonedNow.getMonth();
  const lastDayInPriorMonth = new Date(priorYear, month + 1, 0).getDate();
  const day = Math.min(zonedNow.getDate(), lastDayInPriorMonth);
  const start = fromZonedTime(
    new Date(priorYear, month, day, 0, 0, 0, 0),
    DEFAULT_TIME_ZONE,
  );
  const end = endOfClinicDay(now);

  return { start, end, from: fmtInput(start), to: fmtInput(end) };
}

export function resolveDateRange(input: DateRangeInput = {}): ResolvedDateRange {
  const now = input.now ?? new Date();

  // Honor an explicit from/to pair whenever both bounds are present, regardless
  // of the preset. Report → document links forward the resolved on-screen range
  // (from/to) without a preset; treating a present from/to as a custom range is
  // the single canonical rule that keeps every Preview and generated document
  // locked to the exact dates shown on the report page. Presets that are not
  // "custom" never carry from/to (the reports date filter clears them), so this
  // never overrides an intentionally preset-driven range.
  if (input.from && input.to) {
    const start = clinicDateInputToDate(input.from);
    const end = clinicDateInputToDate(input.to, true);
    return { preset: "custom", start, end, from: input.from, to: input.to };
  }

  const preset = input.preset ?? "this_month";
  const zonedNow = toZonedTime(now, DEFAULT_TIME_ZONE);

  if (preset === "today") {
    const start = startOfClinicDay(now);
    const end = endOfClinicDay(now);
    return { preset, start, end, from: fmtInput(start), to: fmtInput(end) };
  }

  if (preset === "this_week") {
    const day = zonedNow.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    const mondayDate = zonedNow.getDate() + diff;
    const monday = new Date(
      zonedNow.getFullYear(),
      zonedNow.getMonth(),
      mondayDate,
      0,
      0,
      0,
      0,
    );
    const sunday = new Date(
      zonedNow.getFullYear(),
      zonedNow.getMonth(),
      mondayDate + 6,
      23,
      59,
      59,
      999,
    );

    const start = fromZonedTime(monday, DEFAULT_TIME_ZONE);
    const end = fromZonedTime(sunday, DEFAULT_TIME_ZONE);
    return { preset, start, end, from: fmtInput(start), to: fmtInput(end) };
  }

  if (preset === "last_week") {
    const day = zonedNow.getDay();
    const thisMondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(
      zonedNow.getFullYear(),
      zonedNow.getMonth(),
      zonedNow.getDate() + thisMondayOffset - 7,
      0,
      0,
      0,
      0,
    );
    const sunday = new Date(
      monday.getFullYear(),
      monday.getMonth(),
      monday.getDate() + 6,
      23,
      59,
      59,
      999,
    );
    const start = fromZonedTime(monday, DEFAULT_TIME_ZONE);
    const end = fromZonedTime(sunday, DEFAULT_TIME_ZONE);
    return { preset, start, end, from: fmtInput(start), to: fmtInput(end) };
  }

  if (preset === "last_month") {
    const first = new Date(zonedNow.getFullYear(), zonedNow.getMonth() - 1, 1);
    const last = new Date(zonedNow.getFullYear(), zonedNow.getMonth(), 0);
    const start = startOfClinicDay(first);
    const end = endOfClinicDay(last);
    return { preset, start, end, from: fmtInput(start), to: fmtInput(end) };
  }

  if (preset === "last_year") {
    const range = resolveRollingYearRange(now);
    return { preset, ...range };
  }

  const first = new Date(zonedNow.getFullYear(), zonedNow.getMonth(), 1);
  const last = new Date(zonedNow.getFullYear(), zonedNow.getMonth() + 1, 0);
  const start = startOfClinicDay(first);
  const end = endOfClinicDay(last);
  return { preset: "this_month", start, end, from: fmtInput(start), to: fmtInput(end) };
}

export function dateRangeToRpcArgs(range: Pick<ResolvedDateRange, "start" | "end">) {
  return {
    p_start: range.start.toISOString(),
    p_end: range.end.toISOString(),
  };
}
