import "server-only";

import { formatInTimeZone } from "date-fns-tz";
import { computeAvailableSlots } from "@/lib/booking/availability";
import type { ResolvedPatientAiContext } from "@/lib/ai/patient-authorization";
import {
  createClinicScopedAdminClient,
  createPatientPreliminaryBooking,
} from "@/lib/supabase/admin";

export type PatientAvailabilityResult =
  | {
      ok: true;
      doctorId: string;
      doctorName: string;
      date: string;
      availableSlots: string[];
    }
  | {
      ok: false;
      reason: "doctor_not_found" | "service_not_found";
    }
  | {
      ok: false;
      reason: "doctor_required";
      candidates: Array<{ id: string; name: string }>;
    };

export async function getPatientAvailableSlots(input: {
  identity: ResolvedPatientAiContext;
  date: string;
  doctorId?: string | null;
  serviceId?: string | null;
  now?: Date;
}): Promise<PatientAvailabilityResult> {
  const db = createClinicScopedAdminClient(input.identity.clinicId);
  let departmentId: string | null = null;

  if (input.serviceId) {
    const service = await db
      .from("services")
      .select("id, department_id")
      .eq("id", input.serviceId)
      .eq("is_active", true)
      .is("deleted_at", null)
      .maybeSingle();
    if (service.error || !service.data) {
      return { ok: false, reason: "service_not_found" };
    }
    departmentId = service.data.department_id;
  }

  let doctorsQuery = db
    .from("profiles")
    .select("id, full_name, department_id")
    .eq("role", "doctor")
    .eq("is_active", true)
    .eq("is_deleted", false)
    .is("deleted_at", null);
  if (input.doctorId) doctorsQuery = doctorsQuery.eq("id", input.doctorId);
  if (departmentId) doctorsQuery = doctorsQuery.eq("department_id", departmentId);
  const doctors = await doctorsQuery.order("full_name").limit(20);
  if (doctors.error || doctors.data.length === 0) {
    return { ok: false, reason: "doctor_not_found" };
  }
  if (!input.doctorId && doctors.data.length > 1) {
    return {
      ok: false,
      reason: "doctor_required",
      candidates: doctors.data.map((doctor) => ({
        id: doctor.id,
        name: doctor.full_name,
      })),
    };
  }

  const doctor = doctors.data[0]!;
  const slots = await computeAvailableSlots({
    supabase: db,
    clinicId: input.identity.clinicId,
    doctorId: doctor.id,
    dateIso: input.date,
    timeZone: input.identity.clinicTimezone,
  });
  const now = input.now ?? new Date();
  const today = formatInTimeZone(now, input.identity.clinicTimezone, "yyyy-MM-dd");
  const currentTime = formatInTimeZone(now, input.identity.clinicTimezone, "HH:mm");
  const availableSlots = slots
    .filter(
      (slot) =>
        !slot.disabled &&
        (input.date > today || (input.date === today && slot.time > currentTime)),
    )
    .map((slot) => slot.time);

  return {
    ok: true,
    doctorId: doctor.id,
    doctorName: doctor.full_name,
    date: input.date,
    availableSlots,
  };
}

export type PatientPreliminaryBookingResult =
  | { ok: true; appointmentId: string; expiresAt: string }
  | {
      ok: false;
      reason:
        | "patient_pending_cap"
        | "slot_pending_cap"
        | "slot_unavailable"
        | "doctor_unavailable"
        | "service_unavailable"
        | "create_failed";
    };

function bookingFailure(message: string | undefined): PatientPreliminaryBookingResult {
  if (message?.includes("AI_PENDING_PATIENT_CAP")) {
    return { ok: false, reason: "patient_pending_cap" };
  }
  if (message?.includes("AI_PENDING_SLOT_CAP")) {
    return { ok: false, reason: "slot_pending_cap" };
  }
  if (
    message?.includes("AI_BOOKING_SLOT_UNAVAILABLE") ||
    message?.includes("AI_BOOKING_INVALID_SLOT")
  ) {
    return { ok: false, reason: "slot_unavailable" };
  }
  if (message?.includes("AI_BOOKING_DOCTOR_UNAVAILABLE")) {
    return { ok: false, reason: "doctor_unavailable" };
  }
  if (message?.includes("AI_BOOKING_SERVICE_UNAVAILABLE")) {
    return { ok: false, reason: "service_unavailable" };
  }
  return { ok: false, reason: "create_failed" };
}

export async function createPatientPendingBooking(input: {
  identity: ResolvedPatientAiContext;
  doctorId: string;
  scheduledAt: string;
  durationMinutes: number;
  serviceId?: string | null;
}): Promise<PatientPreliminaryBookingResult> {
  const scheduled = new Date(input.scheduledAt);
  if (!Number.isFinite(scheduled.getTime()) || scheduled.getTime() <= Date.now()) {
    return { ok: false, reason: "slot_unavailable" };
  }
  const date = formatInTimeZone(
    scheduled,
    input.identity.clinicTimezone,
    "yyyy-MM-dd",
  );
  const time = formatInTimeZone(
    scheduled,
    input.identity.clinicTimezone,
    "HH:mm",
  );
  const availability = await getPatientAvailableSlots({
    identity: input.identity,
    date,
    doctorId: input.doctorId,
    serviceId: input.serviceId,
  });
  if (!availability.ok) {
    return {
      ok: false,
      reason:
        availability.reason === "service_not_found"
          ? "service_unavailable"
          : "doctor_unavailable",
    };
  }
  const needed = Math.ceil(input.durationMinutes / 15);
  const start = availability.availableSlots.indexOf(time);
  const expected = Array.from({ length: needed }, (_, index) => {
    const total =
      Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + index * 15;
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
      total % 60,
    ).padStart(2, "0")}`;
  });
  if (
    start < 0 ||
    availability.availableSlots
      .slice(start, start + needed)
      .some((slot, index) => slot !== expected[index]) ||
    availability.availableSlots.slice(start, start + needed).length !== needed
  ) {
    return { ok: false, reason: "slot_unavailable" };
  }

  const result = await createPatientPreliminaryBooking({
    clinicId: input.identity.clinicId,
    conversationId: input.identity.conversationId,
    doctorId: input.doctorId,
    scheduledAt: input.scheduledAt,
    durationMinutes: input.durationMinutes,
    serviceId: input.serviceId,
  });
  const row = result.data?.[0];
  if (result.error || !row) return bookingFailure(result.error?.message);
  return {
    ok: true,
    appointmentId: row.appointment_id,
    expiresAt: row.expires_at,
  };
}
