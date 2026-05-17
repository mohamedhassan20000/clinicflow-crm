import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import { CLINIC_TZ } from "@/lib/datetime";

export type DateRangePreset = "today" | "this_week" | "this_month" | "custom";

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

function startOfClinicDay(date: Date): Date {
  const zoned = toZonedTime(date, CLINIC_TZ);
  return fromZonedTime(
    new Date(zoned.getFullYear(), zoned.getMonth(), zoned.getDate(), 0, 0, 0, 0),
    CLINIC_TZ,
  );
}

function endOfClinicDay(date: Date): Date {
  const zoned = toZonedTime(date, CLINIC_TZ);
  return fromZonedTime(
    new Date(zoned.getFullYear(), zoned.getMonth(), zoned.getDate(), 23, 59, 59, 999),
    CLINIC_TZ,
  );
}

function clinicDateInputToDate(value: string, endOfDay = false): Date {
  const time = endOfDay ? "T23:59:59.999" : "T00:00:00.000";
  return fromZonedTime(`${value}${time}`, CLINIC_TZ);
}

function fmtInput(date: Date): string {
  return formatInTimeZone(date, CLINIC_TZ, "yyyy-MM-dd");
}

export function resolveDateRange(input: DateRangeInput = {}): ResolvedDateRange {
  const preset = input.preset ?? "this_month";
  const now = input.now ?? new Date();

  if (preset === "custom" && input.from && input.to) {
    const start = clinicDateInputToDate(input.from);
    const end = clinicDateInputToDate(input.to, true);
    return { preset, start, end, from: input.from, to: input.to };
  }

  const zonedNow = toZonedTime(now, CLINIC_TZ);

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

    const start = fromZonedTime(monday, CLINIC_TZ);
    const end = fromZonedTime(sunday, CLINIC_TZ);
    return { preset, start, end, from: fmtInput(start), to: fmtInput(end) };
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
