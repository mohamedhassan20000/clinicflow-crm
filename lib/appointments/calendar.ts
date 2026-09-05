import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { ClinicLocale } from "@/lib/datetime";
import type { Database } from "@/types/database";

export type AppointmentCalendarView = "day" | "week" | "month";
export type AppointmentCalendarRole =
  | "admin"
  | "receptionist"
  | "manager"
  | "doctor"
  | "assistant";
export type CalendarAppointmentStatus =
  Database["public"]["Enums"]["appointment_status"];

export const CALENDAR_APPOINTMENT_STATUSES: CalendarAppointmentStatus[] = [
  "pending",
  "confirmed",
  "arrived",
  "in_session",
  "completed",
  "cancelled",
  "no_show",
  "replaced",
];

export const CALENDAR_APPOINTMENT_SELECT =
  "id, patient_id, doctor_id, scheduled_at, status, insurance_provider_id, notes, duration_minutes, package_id, package_session_number, replaces_appointment_id, replaced_by_appointment_id, ai_patient_conversation_id, patients(full_name, phone, file_number), profiles!doctor_id(full_name), departments(name, color), patient_packages(name, total_sessions, used_sessions, price_per_session)";

export const CALENDAR_APPOINTMENT_FINANCIAL_SELECT =
  "id, total_amount, insurance_amount, insurance_calculation_mode, insurance_percentage, patient_responsibility, paid_amount, secondary_amount, deposit_amount, outstanding_amount";

export type CalendarFinancialRow = {
  id: string;
  total_amount: number | null;
  insurance_amount: number | null;
  insurance_calculation_mode: string | null;
  insurance_percentage: number | null;
  patient_responsibility: number | null;
  paid_amount: number | null;
  secondary_amount: number | null;
  deposit_amount: number | null;
  outstanding_amount: number | null;
};

export function resolveCalendarScopeFilters({
  role,
  userId,
  doctorParam,
  departmentParam,
  doctors,
  departments,
}: {
  role: AppointmentCalendarRole;
  userId: string;
  doctorParam?: string;
  departmentParam?: string;
  doctors: ReadonlyArray<{ id: string }>;
  departments: ReadonlyArray<{ id: string }>;
}): {
  doctorId: string | undefined;
  departmentId: string | undefined;
} {
  if (role === "doctor") {
    return { doctorId: userId, departmentId: undefined };
  }
  if (role === "assistant") {
    return { doctorId: undefined, departmentId: undefined };
  }
  return {
    doctorId: doctors.some((doctor) => doctor.id === doctorParam)
      ? doctorParam
      : undefined,
    departmentId: departments.some(
      (department) => department.id === departmentParam,
    )
      ? departmentParam
      : undefined,
  };
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH_PATTERN = /^\d{4}-\d{2}$/;

function utcDateFromCalendarDate(dateIso: string): Date {
  return new Date(`${dateIso}T00:00:00.000Z`);
}

export function isCalendarDate(value: string | null | undefined): value is string {
  if (!value || !ISO_DATE_PATTERN.test(value)) return false;
  const parsed = utcDateFromCalendarDate(value);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function isCalendarMonth(
  value: string | null | undefined,
): value is string {
  if (!value || !ISO_MONTH_PATTERN.test(value)) return false;
  return isCalendarDate(`${value}-01`);
}

export function calendarDateKey(
  value: Date | string | number,
  timeZone: string,
): string {
  return formatInTimeZone(value, timeZone, "yyyy-MM-dd");
}

export function calendarMinutes(
  value: Date | string | number,
  timeZone: string,
): number {
  const time = formatInTimeZone(value, timeZone, "HH:mm");
  const [hours, minutes] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

export type CalendarEventPlacement = {
  date: string;
  startMinutes: number;
  endMinutes: number;
};

export function toCalendarEventPlacement(
  appointment: {
    scheduled_at: string;
    duration_minutes?: number;
  },
  timeZone: string,
): CalendarEventPlacement {
  const startMinutes = calendarMinutes(
    appointment.scheduled_at,
    timeZone,
  );
  return {
    date: calendarDateKey(appointment.scheduled_at, timeZone),
    startMinutes,
    endMinutes: startMinutes + (appointment.duration_minutes ?? 0),
  };
}

export function addCalendarDays(dateIso: string, days: number): string {
  const date = utcDateFromCalendarDate(dateIso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function addCalendarMonths(monthIso: string, months: number): string {
  const date = new Date(`${monthIso}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 7);
}

export function calendarDayOfWeek(dateIso: string): number {
  return utcDateFromCalendarDate(dateIso).getUTCDay();
}

export function startOfCalendarWeek(
  dateIso: string,
  weekStartsOn: ClinicLocale["weekStart"],
): string {
  const difference =
    (calendarDayOfWeek(dateIso) - weekStartsOn + 7) % 7;
  return addCalendarDays(dateIso, -difference);
}

export type CalendarRange = {
  view: AppointmentCalendarView;
  dayAnchor: string;
  weekStart: string;
  monthStart: string;
  rangeStartDate: string;
  rangeEndDate: string;
  rangeStartIso: string;
  rangeEndIso: string;
};

export function getAppointmentCalendarRange({
  view,
  day,
  week,
  month,
  timeZone,
  weekStartsOn,
  now = new Date(),
}: {
  view: AppointmentCalendarView;
  day?: string;
  week?: string;
  month?: string;
  timeZone: string;
  weekStartsOn: ClinicLocale["weekStart"];
  now?: Date;
}): CalendarRange {
  const today = calendarDateKey(now, timeZone);
  const dayAnchor = isCalendarDate(day) ? day : today;
  const requestedWeekDate = isCalendarDate(week) ? week : today;
  const weekStart = startOfCalendarWeek(requestedWeekDate, weekStartsOn);
  const requestedMonth = isCalendarMonth(month)
    ? month
    : today.slice(0, 7);
  const monthStart = `${requestedMonth}-01`;

  let rangeStartDate: string;
  let rangeEndDate: string;

  if (view === "day") {
    rangeStartDate = dayAnchor;
    rangeEndDate = addCalendarDays(dayAnchor, 1);
  } else if (view === "month") {
    rangeStartDate = startOfCalendarWeek(monthStart, weekStartsOn);
    rangeEndDate = addCalendarDays(rangeStartDate, 42);
  } else {
    rangeStartDate = weekStart;
    rangeEndDate = addCalendarDays(weekStart, 7);
  }

  return {
    view,
    dayAnchor,
    weekStart,
    monthStart,
    rangeStartDate,
    rangeEndDate,
    rangeStartIso: fromZonedTime(
      `${rangeStartDate}T00:00:00`,
      timeZone,
    ).toISOString(),
    rangeEndIso: fromZonedTime(
      `${rangeEndDate}T00:00:00`,
      timeZone,
    ).toISOString(),
  };
}

export function mergeCalendarFinancialRows<T extends { id: string }>(
  appointments: T[],
  financialRows: CalendarFinancialRow[] | null | undefined,
): Array<T & Partial<CalendarFinancialRow>> {
  if (!financialRows?.length) return appointments;
  const financialById = new Map(
    financialRows.map((row) => [row.id, row] as const),
  );
  return appointments.map((appointment) => ({
    ...appointment,
    ...(financialById.get(appointment.id) ?? {}),
  }));
}
