import "server-only";

import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

// One shared, reason-aware availability calculation is used by the appointment
// form and both AI booking surfaces. Callers still provide an authorized,
// tenant-scoped client; this module never broadens data access.

export type SlotDisabledReason =
  | "booked"
  | "blocked"
  | "break"
  | "elapsed"
  | "duration";

export type SlotInfo = {
  time: string;
  disabled: boolean;
  label?: "break";
  disabledReason?: SlotDisabledReason;
};

export type AvailabilityReason =
  | "available"
  | "doctor_required"
  | "doctor_not_found"
  | "no_schedule_configured"
  | "doctor_off_weekday"
  | "schedule_disabled"
  | "outside_schedule_range"
  | "clinic_closed"
  | "on_leave"
  | "working_hours_passed"
  | "all_slots_booked"
  | "all_slots_blocked"
  | "duration_unavailable"
  | "unable_to_calculate";

export type WorkingWindow = { start: string; end: string };

export type AvailabilityResult = {
  slots: SlotInfo[];
  reason: AvailabilityReason;
  dateIso: string;
  dayOfWeek: number;
  doctorName?: string;
  workingHours: WorkingWindow[];
};

type MinuteWindow = { start: number; end: number };
type BlockedRange = {
  start: number;
  end: number;
  kind: "booked" | "leave" | "off" | "blocked";
};

const STEP = 15;
const BUFFER_MIN = 15;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function timeStrToMinutes(value: string): number {
  const [hour, minute] = value.slice(0, 5).split(":").map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

function minutesToTime(value: number): string {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function clinicDayOfWeek(dateIso: string, timeZone: string): number {
  const instant = fromZonedTime(`${dateIso}T12:00:00`, timeZone);
  return Number(formatInTimeZone(instant, timeZone, "i")) % 7;
}

function intersectWindows(
  doctor: MinuteWindow,
  clinic: MinuteWindow[],
): MinuteWindow[] {
  if (clinic.length === 0) return [doctor];
  return clinic
    .map((window) => ({
      start: Math.max(doctor.start, window.start),
      end: Math.min(doctor.end, window.end),
    }))
    .filter((window) => window.end > window.start);
}

function toWorkingWindows(windows: MinuteWindow[]): WorkingWindow[] {
  return windows.map((window) => ({
    start: minutesToTime(window.start),
    end: minutesToTime(window.end),
  }));
}

function unavailable(
  reason: AvailabilityReason,
  dateIso: string,
  dayOfWeek: number,
  doctorName?: string,
  workingHours: WorkingWindow[] = [],
): AvailabilityResult {
  return { slots: [], reason, dateIso, dayOfWeek, doctorName, workingHours };
}

export async function computeAvailability(params: {
  supabase: SupabaseClient<Database>;
  clinicId: string;
  doctorId: string | null;
  dateIso: string;
  timeZone: string;
  durationMinutes?: number;
  excludeAppointmentId?: string;
  now?: Date;
}): Promise<AvailabilityResult> {
  const {
    supabase,
    clinicId,
    doctorId,
    dateIso,
    timeZone,
    excludeAppointmentId,
  } = params;
  const durationMinutes = Math.max(
    STEP,
    Math.ceil((params.durationMinutes ?? 30) / STEP) * STEP,
  );

  let dayOfWeek = 0;
  try {
    if (!ISO_DATE.test(dateIso)) {
      return unavailable("unable_to_calculate", dateIso, dayOfWeek);
    }
    dayOfWeek = clinicDayOfWeek(dateIso, timeZone);
  } catch {
    return unavailable("unable_to_calculate", dateIso, dayOfWeek);
  }

  if (!doctorId) {
    return unavailable("doctor_required", dateIso, dayOfWeek);
  }

  const dayStart = fromZonedTime(`${dateIso}T00:00:00.000`, timeZone);
  const dayEnd = fromZonedTime(`${dateIso}T23:59:59.999`, timeZone);

  let appointmentsQuery = supabase
    .from("appointments")
    .select("id, scheduled_at, duration_minutes, status")
    .eq("doctor_id", doctorId)
    .eq("clinic_id", clinicId)
    .in("status", ["confirmed", "arrived", "in_session"])
    .is("deleted_at", null)
    .gte("scheduled_at", dayStart.toISOString())
    .lte("scheduled_at", dayEnd.toISOString());
  if (excludeAppointmentId) {
    appointmentsQuery = appointmentsQuery.neq("id", excludeAppointmentId);
  }

  const [
    doctorResult,
    schedulesResult,
    clinicHoursResult,
    appointmentsResult,
    unavailabilityResult,
  ] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name, is_active, is_deleted, deleted_at")
      .eq("id", doctorId)
      .eq("clinic_id", clinicId)
      .eq("role", "doctor")
      .maybeSingle(),
    supabase
      .from("doctor_schedules")
      .select(
        "day_of_week, start_time, end_time, is_enabled, valid_from, valid_until",
      )
      .eq("doctor_id", doctorId)
      .eq("clinic_id", clinicId)
      .order("day_of_week"),
    supabase
      .from("clinic_working_hours")
      .select("day_of_week, shift_start, shift_end")
      .eq("clinic_id", clinicId)
      .order("day_of_week")
      .order("shift_start"),
    appointmentsQuery,
    supabase
      .from("doctor_unavailability")
      .select("starts_at, ends_at, kind")
      .eq("doctor_id", doctorId)
      .eq("clinic_id", clinicId)
      .eq("is_active", true)
      .lt("starts_at", dayEnd.toISOString())
      .gt("ends_at", dayStart.toISOString()),
  ]);

  if (
    doctorResult.error ||
    schedulesResult.error ||
    clinicHoursResult.error ||
    appointmentsResult.error ||
    unavailabilityResult.error
  ) {
    return unavailable(
      "unable_to_calculate",
      dateIso,
      dayOfWeek,
      doctorResult.data?.full_name,
    );
  }

  const doctor = doctorResult.data;
  if (
    !doctor ||
    !doctor.is_active ||
    doctor.is_deleted ||
    doctor.deleted_at
  ) {
    return unavailable("doctor_not_found", dateIso, dayOfWeek);
  }

  const schedules = schedulesResult.data ?? [];
  if (schedules.length === 0) {
    return unavailable(
      "no_schedule_configured",
      dateIso,
      dayOfWeek,
      doctor.full_name,
    );
  }

  const schedule = schedules.find((row) => row.day_of_week === dayOfWeek);
  if (!schedule) {
    return unavailable(
      "doctor_off_weekday",
      dateIso,
      dayOfWeek,
      doctor.full_name,
    );
  }
  if (!schedule.is_enabled) {
    return unavailable(
      "schedule_disabled",
      dateIso,
      dayOfWeek,
      doctor.full_name,
    );
  }
  if (
    (schedule.valid_from && dateIso < schedule.valid_from) ||
    (schedule.valid_until && dateIso > schedule.valid_until)
  ) {
    return unavailable(
      "outside_schedule_range",
      dateIso,
      dayOfWeek,
      doctor.full_name,
    );
  }

  const allClinicHours = clinicHoursResult.data ?? [];
  const clinicDayHours = allClinicHours
    .filter((row) => row.day_of_week === dayOfWeek)
    .map((row) => ({
      start: timeStrToMinutes(row.shift_start),
      end: timeStrToMinutes(row.shift_end),
    }));
  if (allClinicHours.length > 0 && clinicDayHours.length === 0) {
    return unavailable(
      "clinic_closed",
      dateIso,
      dayOfWeek,
      doctor.full_name,
    );
  }

  const doctorWindow = {
    start: timeStrToMinutes(schedule.start_time),
    end: timeStrToMinutes(schedule.end_time),
  };
  const windows = intersectWindows(doctorWindow, clinicDayHours);
  const workingHours = toWorkingWindows(windows);
  if (windows.length === 0) {
    return unavailable(
      "outside_schedule_range",
      dateIso,
      dayOfWeek,
      doctor.full_name,
    );
  }

  const blockedRanges: BlockedRange[] = (appointmentsResult.data ?? []).map(
    (appointment) => {
      const start = timeStrToMinutes(
        formatInTimeZone(appointment.scheduled_at, timeZone, "HH:mm"),
      );
      return {
        start: start - BUFFER_MIN,
        end: start + (appointment.duration_minutes ?? 30) + BUFFER_MIN,
        kind: "booked",
      };
    },
  );

  for (const period of unavailabilityResult.data ?? []) {
    const startsBeforeDay = new Date(period.starts_at) <= dayStart;
    const endsAfterDay = new Date(period.ends_at) >= dayEnd;
    blockedRanges.push({
      start: startsBeforeDay
        ? 0
        : timeStrToMinutes(formatInTimeZone(period.starts_at, timeZone, "HH:mm")),
      end: endsAfterDay
        ? 24 * 60
        : timeStrToMinutes(formatInTimeZone(period.ends_at, timeZone, "HH:mm")),
      kind: period.kind as BlockedRange["kind"],
    });
  }

  const fullDayLeave = blockedRanges.some(
    (range) =>
      (range.kind === "leave" || range.kind === "off") &&
      range.start <= windows[0]!.start &&
      range.end >= windows[windows.length - 1]!.end,
  );
  if (fullDayLeave) {
    return unavailable(
      "on_leave",
      dateIso,
      dayOfWeek,
      doctor.full_name,
      workingHours,
    );
  }

  const now = params.now ?? new Date();
  const today = formatInTimeZone(now, timeZone, "yyyy-MM-dd");
  const nowMinutes = timeStrToMinutes(formatInTimeZone(now, timeZone, "HH:mm"));
  const slots: SlotInfo[] = [];

  for (let time = doctorWindow.start; time < doctorWindow.end; time += STEP) {
    const stepEnd = time + STEP;
    const timeLabel = minutesToTime(time);
    const inWorkingStep = windows.some(
      (window) => time >= window.start && stepEnd <= window.end,
    );
    if (!inWorkingStep) {
      const withinDoctorDay =
        time >= doctorWindow.start && stepEnd <= doctorWindow.end;
      if (withinDoctorDay) {
        slots.push({
          time: timeLabel,
          disabled: true,
          label: "break",
          disabledReason: "break",
        });
      }
      continue;
    }

    const appointmentEnd = time + durationMinutes;
    const fitsDuration = windows.some(
      (window) => time >= window.start && appointmentEnd <= window.end,
    );
    if (!fitsDuration) {
      slots.push({
        time: timeLabel,
        disabled: true,
        disabledReason: "duration",
      });
      continue;
    }

    if (dateIso < today || (dateIso === today && time <= nowMinutes)) {
      slots.push({
        time: timeLabel,
        disabled: true,
        disabledReason: "elapsed",
      });
      continue;
    }

    const overlaps = blockedRanges.filter(
      (range) => time < range.end && appointmentEnd > range.start,
    );
    if (overlaps.length > 0) {
      const booked = overlaps.some((range) => range.kind === "booked");
      slots.push({
        time: timeLabel,
        disabled: true,
        disabledReason: booked ? "booked" : "blocked",
      });
      continue;
    }

    slots.push({ time: timeLabel, disabled: false });
  }

  if (slots.some((slot) => !slot.disabled)) {
    return {
      slots,
      reason: "available",
      dateIso,
      dayOfWeek,
      doctorName: doctor.full_name,
      workingHours,
    };
  }

  const disabledReasons = new Set(
    slots.map((slot) => slot.disabledReason).filter(Boolean),
  );
  let reason: AvailabilityReason = "duration_unavailable";
  if (
    dateIso <= today &&
    disabledReasons.size > 0 &&
    [...disabledReasons].every((value) =>
      ["elapsed", "duration", "break"].includes(value!),
    )
  ) {
    reason = "working_hours_passed";
  } else if (disabledReasons.has("booked")) {
    reason = "all_slots_booked";
  } else if (disabledReasons.has("blocked")) {
    reason = "all_slots_blocked";
  }

  return {
    slots,
    reason,
    dateIso,
    dayOfWeek,
    doctorName: doctor.full_name,
    workingHours,
  };
}

/** Compatibility wrapper for callers that only consume slot rows. */
export async function computeAvailableSlots(
  params: Parameters<typeof computeAvailability>[0],
): Promise<SlotInfo[]> {
  return (await computeAvailability(params)).slots;
}
