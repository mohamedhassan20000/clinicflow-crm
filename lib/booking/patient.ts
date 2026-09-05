import "server-only";

import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { addCalendarDays } from "@/lib/appointments/calendar";
import { computeAvailability } from "@/lib/booking/availability";
import type {
  AvailabilityReason,
  WorkingWindow,
} from "@/lib/booking/availability";
import type { ResolvedPatientAiContext } from "@/lib/ai/patient-authorization";
import {
  createClinicScopedAdminClient,
  createPatientPreliminaryBooking,
  createProvisionalAiAppointmentRequest,
  getPendingConversationIntake,
} from "@/lib/supabase/admin";

export type PatientAvailabilityResult =
  | {
      ok: true;
      doctorId: string;
      doctorName: string;
      date: string;
      availableSlots: string[];
      availabilityReason: AvailabilityReason;
      workingHours: WorkingWindow[];
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
  durationMinutes?: number;
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

  // The department the conversation already settled on scopes this query even
  // when no service was named. Without it, a patient who chose Dermatology and
  // did not name a doctor was matched against *every* doctor in the clinic:
  // with several, the assistant was offered cross-department candidates, and
  // with one row surviving it silently bound that arbitrary doctor. The
  // selected department is the patient's own choice, so applying it is not a
  // narrowing — it is the filter that was missing.
  const scopeDepartmentId =
    departmentId ??
    (typeof input.identity.collectedData.department_id === "string"
      ? input.identity.collectedData.department_id
      : null);

  let doctorsQuery = db
    .from("profiles")
    .select("id, full_name, department_id")
    .eq("role", "doctor")
    .eq("is_active", true)
    .eq("is_deleted", false)
    .is("deleted_at", null);
  if (input.doctorId) doctorsQuery = doctorsQuery.eq("id", input.doctorId);
  // An explicitly named doctor is honoured as named; the department scope only
  // decides who is offered when the patient has not chosen yet.
  if (!input.doctorId && scopeDepartmentId) {
    doctorsQuery = doctorsQuery.eq("department_id", scopeDepartmentId);
  } else if (input.doctorId && departmentId) {
    doctorsQuery = doctorsQuery.eq("department_id", departmentId);
  }
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
  const availability = await computeAvailability({
    supabase: db,
    clinicId: input.identity.clinicId,
    doctorId: doctor.id,
    dateIso: input.date,
    timeZone: input.identity.clinicTimezone,
    durationMinutes: input.durationMinutes,
    now: input.now,
  });
  const now = input.now ?? new Date();
  const minimumBookingAt = now.getTime() + 24 * 60 * 60 * 1000;
  const availableSlots = availability.slots
    .filter(
      (slot) =>
        !slot.disabled &&
        fromZonedTime(
          `${input.date}T${slot.time}:00`,
          input.identity.clinicTimezone,
        ).getTime() >= minimumBookingAt,
    )
    .map((slot) => slot.time);

  return {
    ok: true,
    doctorId: doctor.id,
    doctorName: doctor.full_name,
    date: input.date,
    availableSlots,
    availabilityReason: availability.reason,
    workingHours: availability.workingHours,
  };
}

export type PatientAvailableDaysResult =
  | {
      ok: true;
      doctorId: string;
      doctorName: string;
      availableDays: Array<{ date: string; slotCount: number }>;
      minimumNoticeHours: 24;
    }
  | Extract<PatientAvailabilityResult, { ok: false }>;

/** Days-first view over the same availability engine used by staff. */
export async function getPatientAvailableDays(input: {
  identity: ResolvedPatientAiContext;
  doctorId: string;
  durationMinutes: number;
  searchDays?: number;
  startDate?: string;
  serviceId?: string | null;
  now?: Date;
}): Promise<PatientAvailableDaysResult> {
  const now = input.now ?? new Date();
  const firstDate = input.startDate ??
    formatInTimeZone(now, input.identity.clinicTimezone, "yyyy-MM-dd");
  const dates = Array.from(
    { length: input.searchDays ?? 21 },
    (_, index) => addCalendarDays(firstDate, index),
  );
  const availableDays: Array<{ date: string; slotCount: number }> = [];
  let doctorName = "";

  // Seven dates at a time keeps the WhatsApp turn responsive without opening
  // dozens of concurrent database query sets for a long search horizon.
  for (let offset = 0; offset < dates.length; offset += 7) {
    const batch = await Promise.all(
      dates.slice(offset, offset + 7).map((date) =>
        getPatientAvailableSlots({
          identity: input.identity,
          date,
          doctorId: input.doctorId,
          serviceId: input.serviceId,
          durationMinutes: input.durationMinutes,
          now,
        }),
      ),
    );
    for (const result of batch) {
      if (!result.ok) return result;
      doctorName = result.doctorName;
      if (result.availableSlots.length > 0) {
        availableDays.push({
          date: result.date,
          slotCount: result.availableSlots.length,
        });
      }
    }
  }

  return {
    ok: true,
    doctorId: input.doctorId,
    doctorName,
    availableDays,
    minimumNoticeHours: 24,
  };
}

export type PatientPreliminaryBookingResult =
  | { ok: true; appointmentId: string; expiresAt: string; provisional: boolean }
  | {
      ok: false;
      reason:
        | "patient_pending_cap"
        | "slot_pending_cap"
        | "slot_unavailable"
        | "doctor_unavailable"
        | "service_unavailable"
        | "minimum_notice"
        | "intake_required"
        | "create_failed";
    };

function bookingFailure(message: string | undefined): PatientPreliminaryBookingResult {
  if (message?.includes("AI_BOOKING_MINIMUM_NOTICE")) {
    return { ok: false, reason: "minimum_notice" };
  }
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
  // P9C: the booking is for somebody with no staged file yet — a real, ordinary
  // step of the flow that used to surface as an opaque `create_failed`, which is
  // indistinguishable from a broken system and so became the technical fallback.
  if (message?.includes("PROVISIONAL_INTAKE_REQUIRED")) {
    return { ok: false, reason: "intake_required" };
  }
  return { ok: false, reason: "create_failed" };
}

export async function createPatientPendingBooking(input: {
  identity: ResolvedPatientAiContext;
  doctorId: string;
  scheduledAt: string;
  durationMinutes: number;
  serviceId?: string | null;
  now?: Date;
}): Promise<PatientPreliminaryBookingResult> {
  const scheduled = new Date(input.scheduledAt);
  const now = input.now ?? new Date();
  if (
    !Number.isFinite(scheduled.getTime()) ||
    scheduled.getTime() < now.getTime() + 24 * 60 * 60 * 1000
  ) {
    if (Number.isFinite(scheduled.getTime()) && scheduled.getTime() > now.getTime()) {
      return { ok: false, reason: "minimum_notice" };
    }
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
    durationMinutes: input.durationMinutes,
    now,
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
  // computeAvailability already evaluates the complete requested duration,
  // including schedule windows, breaks, buffers, bookings, and leave. Requiring
  // each following 15-minute increment to also be a valid *start* would reject
  // legitimate appointments near the end of a working window.
  if (!availability.availableSlots.includes(time)) {
    return { ok: false, reason: "slot_unavailable" };
  }

  // P9C — who is this appointment for?
  //
  // "Linked conversation" used to be the whole answer, and it was right for as
  // long as the only person the assistant could book for was the sender. A
  // pending third-party intake makes it wrong: the sender is linked, but the
  // appointment belongs to the person they staged, and taking the linked branch
  // here would file it under the sender's record without anyone being told. The
  // staged row is the authority, not the conversation and not the model.
  const pendingIntake = await getPendingConversationIntake({
    clinicId: input.identity.clinicId,
    conversationId: input.identity.conversationId,
  });
  const bookingForThirdParty = pendingIntake.data?.is_third_party === true;

  if (input.identity.linked && input.identity.patientId && !bookingForThirdParty) {
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
      provisional: false,
    };
  }

  const result = await createProvisionalAiAppointmentRequest({
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
    appointmentId: row.request_id,
    expiresAt: row.expires_at,
    provisional: true,
  };
}
