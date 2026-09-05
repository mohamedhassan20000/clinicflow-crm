import "server-only";

import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { computeAvailability } from "@/lib/booking/availability";
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";
import {
  assertDomainMutationRole,
  domainFailure,
  domainSuccess,
  type DomainMutationMode,
  type DomainMutationResult,
} from "@/lib/domain-mutations";
import { notifyAppointmentEvent } from "@/lib/messaging/appointment-notifications";
import type { AuthedUser } from "@/lib/rbac";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  appointmentSchema,
  replaceAppointmentSchema,
  STATUS_TRANSITIONS,
  type AppointmentFormValues,
} from "@/lib/validations/appointment";
import type { Database, Tables, TablesUpdate } from "@/types/database";
import { isOverduePending } from "@/lib/appointments/overdue-pending";

type AppointmentStatus = Database["public"]["Enums"]["appointment_status"];

export const APPOINTMENT_CREATE_ROLES = [
  "admin",
  "receptionist",
  "manager",
  "assistant",
] as const;
export const APPOINTMENT_REPLACE_ROLES = [
  "admin",
  "receptionist",
  "manager",
  "doctor",
  "assistant",
] as const;
export const APPOINTMENT_DELETE_ROLES = [
  "admin",
  "receptionist",
  "manager",
] as const;
export const APPOINTMENT_UNDO_ROLES = [
  "admin",
  "receptionist",
  "doctor",
  "manager",
] as const;

export const appointmentIdSchema = z
  .object({ appointment_id: z.string().uuid() })
  .strict();
export const appointmentStatusSchema = z
  .object({
    appointment_id: z.string().uuid(),
    status: z.enum(["confirmed", "cancelled", "no_show"]),
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.status === "cancelled" || value.status === "no_show") &&
      !value.reason
    ) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "validation.required",
      });
    }
  });
export const appointmentUndoSchema = appointmentIdSchema.extend({
  target_status: z.enum(["pending", "confirmed", "arrived", "in_session"]),
});
export const appointmentConflictSchema = appointmentIdSchema.extend({
  conflicting_ids: z.array(z.string().uuid()).max(25),
});

type AppointmentMutationData = {
  appointment_id: string;
  patient_id?: string;
  status?: AppointmentStatus;
  redirect_to?: string;
};

async function clinicTimeZone(clinicId: string): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("clinics")
    .select("timezone")
    .eq("id", clinicId)
    .maybeSingle();
  return data?.timezone || DEFAULT_TIME_ZONE;
}

async function validateClinicOpen(
  clinicId: string,
  scheduledAt: string,
  timeZone: string,
) {
  const supabase = await createClient();
  const day = toZonedTime(scheduledAt, timeZone).getDay();
  const { data, error } = await supabase
    .from("clinic_working_hours")
    .select("day_of_week")
    .eq("clinic_id", clinicId);
  if (error) return domainFailure("appointments.weCouldNotCompleteThisRequestPleaseTryAgain");
  if ((data ?? []).length > 0) {
    const selected = data?.find((row) => row.day_of_week === day);
    if (!selected) {
      return domainFailure("appointments.clinicClosedOnDay", {
        values: { day },
      });
    }
  }
  return null;
}

async function validateReferences(
  values: AppointmentFormValues,
  clinicId: string,
) {
  const supabase = await createClient();
  const [patient, doctor, department, insurance] = await Promise.all([
    supabase
      .from("patients")
      .select("id")
      .eq("id", values.patient_id)
      .eq("clinic_id", clinicId)
      .eq("is_deleted", false)
      .maybeSingle(),
    supabase
      .from("profiles")
      .select("id, department_id")
      .eq("id", values.doctor_id)
      .eq("clinic_id", clinicId)
      .eq("role", "doctor")
      .eq("is_active", true)
      .eq("is_deleted", false)
      .is("deleted_at", null)
      .maybeSingle(),
    values.department_id
      ? supabase
          .from("departments")
          .select("id")
          .eq("id", values.department_id)
          .eq("clinic_id", clinicId)
          .eq("is_active", true)
          .is("deleted_at", null)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    values.insurance_provider_id
      ? supabase
          .from("insurance_providers")
          .select("id")
          .eq("id", values.insurance_provider_id)
          .eq("clinic_id", clinicId)
          .eq("is_active", true)
          .is("deleted_at", null)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (patient.error)
    return domainFailure("appointments.failedToValidatePatient");
  if (doctor.error)
    return domainFailure("appointments.failedToValidateDoctor");
  if (department.error)
    return domainFailure("appointments.failedToValidateDepartment");
  if (insurance.error)
    return domainFailure("appointments.failedToValidateInsuranceProvider");
  if (!patient.data)
    return domainFailure("appointments.selectAnActivePatientInThisClinic");
  if (!doctor.data)
    return domainFailure("appointments.selectAnActiveDoctorInThisClinic");
  if (values.department_id && !department.data)
    return domainFailure("appointments.selectAnActiveDepartmentInThisClinic");
  if (values.insurance_provider_id && !insurance.data)
    return domainFailure(
      "appointments.selectAnActiveInsuranceProviderInThisClinic",
    );
  if (
    values.department_id &&
    doctor.data.department_id &&
    doctor.data.department_id !== values.department_id
  ) {
    return domainFailure(
      "appointments.selectedDoctorDoesNotBelongToTheSelectedDepartment",
    );
  }
  return null;
}

async function validatePackage(
  values: AppointmentFormValues,
  clinicId: string,
) {
  if (!values.package_id) {
    return { packageId: null, packageSessionNumber: null };
  }
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("patient_packages")
    .select("id, is_active, total_sessions, used_sessions")
    .eq("id", values.package_id)
    .eq("clinic_id", clinicId)
    .eq("patient_id", values.patient_id)
    .maybeSingle();
  if (error) return domainFailure("appointments.failedToValidatePackage");
  if (!data)
    return domainFailure("appointments.selectAnActivePackageForThisPatient");
  if (!data.is_active || Number(data.used_sessions) >= Number(data.total_sessions)) {
    return domainFailure("appointments.selectedPackageHasNoRemainingSessions");
  }
  return {
    packageId: data.id,
    packageSessionNumber: Number(data.used_sessions) + 1,
  };
}

async function validateSlot(
  values: Pick<
    AppointmentFormValues,
    "doctor_id" | "scheduled_at" | "duration_minutes"
  >,
  clinicId: string,
  timeZone: string,
  excludeAppointmentId?: string,
) {
  const supabase = await createClient();
  const start = new Date(values.scheduled_at);
  const end = new Date(start.getTime() + values.duration_minutes * 60_000);
  const dateIso = formatInTimeZone(start, timeZone, "yyyy-MM-dd");
  const clinicTime = formatInTimeZone(start, timeZone, "HH:mm");
  const availability = await computeAvailability({
    supabase,
    clinicId,
    doctorId: values.doctor_id,
    dateIso,
    timeZone,
    durationMinutes: values.duration_minutes,
    excludeAppointmentId,
  });
  const selected = availability.slots.find((slot) => slot.time === clinicTime);

  const zoned = toZonedTime(start, timeZone);
  const dayStart = fromZonedTime(
    new Date(zoned.getFullYear(), zoned.getMonth(), zoned.getDate(), 0, 0, 0),
    timeZone,
  );
  const dayEnd = fromZonedTime(
    new Date(
      zoned.getFullYear(),
      zoned.getMonth(),
      zoned.getDate(),
      23,
      59,
      59,
      999,
    ),
    timeZone,
  );
  let query = supabase
    .from("appointments")
    .select("id, scheduled_at, duration_minutes")
    .eq("doctor_id", values.doctor_id)
    .eq("clinic_id", clinicId)
    .is("deleted_at", null)
    .in("status", ["confirmed", "arrived", "in_session"])
    .gte("scheduled_at", dayStart.toISOString())
    .lte("scheduled_at", dayEnd.toISOString());
  if (excludeAppointmentId) query = query.neq("id", excludeAppointmentId);
  const sameDay = await query;
  if (sameDay.error) {
    return domainFailure(
      "appointments.couldNotVerifyTheDoctorSAvailabilityPleaseTryAgain",
    );
  }
  const buffer = 15 * 60_000;
  for (const existing of sameDay.data ?? []) {
    const existingStart = new Date(existing.scheduled_at);
    const existingEnd = new Date(
      existingStart.getTime() + existing.duration_minutes * 60_000,
    );
    if (start < existingEnd && end > existingStart) {
      return domainFailure(
        "appointments.thisDoctorIsAlreadyBookedDuringTheSelectedSessionTime",
      );
    }
    if (
      start < new Date(existingEnd.getTime() + buffer) &&
      end > new Date(existingStart.getTime() - buffer)
    ) {
      return domainFailure(
        "appointments.thisDoctorNeedsA15MinuteRecoveryBufferWindowBetween",
      );
    }
  }
  if (!selected || selected.disabled) {
    const keys = {
      no_schedule_configured: "appointments.doctorHasNoWorkingSchedule",
      doctor_off_weekday: "appointments.doctorDoesNotWorkOnSelectedWeekday",
      schedule_disabled: "appointments.doctorScheduleDisabled",
      outside_schedule_range: "appointments.dateOutsideDoctorSchedule",
      clinic_closed: "appointments.clinicClosedOnSelectedDate",
      on_leave: "appointments.doctorOnLeave",
      working_hours_passed: "appointments.doctorWorkingHoursPassed",
      all_slots_booked: "appointments.allDoctorSlotsBooked",
      all_slots_blocked: "appointments.allDoctorSlotsBlocked",
      duration_unavailable: "appointments.durationDoesNotFitWorkingHours",
      doctor_not_found: "appointments.failedToValidateDoctor",
      doctor_required: "appointments.failedToValidateDoctor",
      unable_to_calculate:
        "appointments.couldNotVerifyTheDoctorSAvailabilityPleaseTryAgain",
      available: "appointments.selectedTimeIsNotAvailable",
    } as const;
    return domainFailure(keys[availability.reason]);
  }
  return null;
}

export async function createAppointmentMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<AppointmentMutationData>> {
  assertDomainMutationRole(user, APPOINTMENT_CREATE_ROLES);
  const parsed = appointmentSchema.safeParse(input);
  if (!parsed.success) {
    return domainFailure("appointments.pleaseFillEveryRequiredField", {
      validationError: parsed.error,
    });
  }
  if (new Date(parsed.data.scheduled_at).getTime() <= Date.now()) {
    return domainFailure("appointments.chooseAFutureDateAndTimeForTheAppointment");
  }
  const timeZone = await clinicTimeZone(user.clinicId);
  const closed = await validateClinicOpen(
    user.clinicId,
    parsed.data.scheduled_at,
    timeZone,
  );
  if (closed) return closed;
  const references = await validateReferences(parsed.data, user.clinicId);
  if (references) return references;
  const selectedPackage = await validatePackage(parsed.data, user.clinicId);
  if ("ok" in selectedPackage) return selectedPackage;
  const packageSelection = selectedPackage;
  const slot = await validateSlot(parsed.data, user.clinicId, timeZone);
  if (slot) return slot;

  const preview = {
    appointment_id: "00000000-0000-0000-0000-000000000000",
    patient_id: parsed.data.patient_id,
    status: "pending" as const,
  };
  if (mode === "preview") {
    return domainSuccess(preview, {
      targetTable: "appointments",
      after: { ...parsed.data, status: "pending" },
    });
  }
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("appointments")
    .insert({
      ...parsed.data,
      package_id: packageSelection.packageId,
      package_session_number: packageSelection.packageSessionNumber,
      clinic_id: user.clinicId,
      created_by: user.id,
    })
    .select("id, patient_id, status")
    .single();
  if (error) {
    if (error.code === "23505") {
      return domainFailure(
        error.message?.includes("appointments_patient_active_slot_key")
          ? "appointments.thisPatientAlreadyHasAnotherAppointmentAtTheSameTime"
          : "appointments.thisDoctorAlreadyHasAnAppointmentAtThatTimePlease",
      );
    }
    return domainFailure(
      "appointments.failedToCreateAppointmentPleaseTryAgain",
    );
  }
  await notifyAppointmentEvent({
    clinicId: user.clinicId,
    appointmentId: data.id,
    event: "created",
  });
  revalidatePath("/appointments");
  return domainSuccess(
    {
      appointment_id: data.id,
      patient_id: data.patient_id,
      status: data.status,
      redirect_to: `/appointments?view=day&date=${formatInTimeZone(
        parsed.data.scheduled_at,
        timeZone,
        "yyyy-MM-dd",
      )}`,
    },
    {
      targetTable: "appointments",
      targetRecordIds: [data.id],
      after: { ...parsed.data, id: data.id, status: data.status },
    },
  );
}

export async function replaceAppointmentMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<AppointmentMutationData>> {
  assertDomainMutationRole(user, APPOINTMENT_REPLACE_ROLES);
  const parsed = replaceAppointmentSchema.safeParse(input);
  if (!parsed.success) {
    return domainFailure("appointments.validationError", {
      validationError: parsed.error,
    });
  }
  if (new Date(parsed.data.scheduled_at).getTime() <= Date.now()) {
    return domainFailure("appointments.replacementTimeMustBeInTheFuture");
  }
  const supabase = await createClient();
  const { data: original, error: originalError } = await supabase
    .from("appointments")
    .select("id, patient_id, doctor_id, department_id, status, scheduled_at, duration_minutes, deleted_at, displaced_at, replaced_by_appointment_id")
    .eq("id", parsed.data.original_id)
    .eq("clinic_id", user.clinicId)
    .is("deleted_at", null)
    .maybeSingle();
  if (originalError || !original)
    return domainFailure("appointments.appointmentNotFound");
  if (
    !["pending", "confirmed"].includes(original.status) ||
    original.displaced_at != null ||
    original.replaced_by_appointment_id != null ||
    (new Date(original.scheduled_at).getTime() <= Date.now() &&
      !isOverduePending(original))
  ) {
    return domainFailure(
      "appointments.onlyFutureOpenAppointmentsCanBeReplaced",
    );
  }
  const timeZone = await clinicTimeZone(user.clinicId);
  const closed = await validateClinicOpen(
    user.clinicId,
    parsed.data.scheduled_at,
    timeZone,
  );
  if (closed) return closed;
  const slot = await validateSlot(
    parsed.data,
    user.clinicId,
    timeZone,
    parsed.data.original_id,
  );
  if (slot) return slot;
  if (mode === "preview") {
    return domainSuccess(
      {
        appointment_id: parsed.data.original_id,
        patient_id: original.patient_id,
        status: "replaced",
      },
      {
        targetTable: "appointments",
        targetRecordIds: [parsed.data.original_id],
        before: original,
        after: { ...parsed.data, status: "confirmed" },
      },
    );
  }
  const { data: newId, error } = await supabase.rpc("replace_appointment", {
    p_original_id: parsed.data.original_id,
    p_scheduled_at: parsed.data.scheduled_at,
    p_doctor_id: parsed.data.doctor_id,
    p_duration_minutes: parsed.data.duration_minutes,
    p_department_id: parsed.data.department_id ?? undefined,
    p_notes: parsed.data.notes ?? undefined,
  });
  if (error) {
    if (error.code === "23505")
      return domainFailure(
        "appointments.thisDoctorAlreadyHasAnAppointmentAtThatTimePlease",
      );
    if (error.message?.toLowerCase().includes("future"))
      return domainFailure("appointments.replacementTimeMustBeInTheFuture");
    if (error.message?.toLowerCase().includes("pending or confirmed"))
      return domainFailure(
        "appointments.onlyFutureOpenAppointmentsCanBeReplaced",
      );
    return domainFailure(
      "appointments.failedToCreateAppointmentPleaseTryAgain",
    );
  }
  if (typeof newId !== "string") {
    return domainFailure(
      "appointments.failedToCreateAppointmentPleaseTryAgain",
    );
  }
  await notifyAppointmentEvent({
    clinicId: user.clinicId,
    appointmentId: newId,
    event: "created",
  });
  revalidatePath("/appointments");
  return domainSuccess(
    {
      appointment_id: newId,
      patient_id: original.patient_id,
      status: "confirmed",
    },
    {
      targetTable: "appointments",
      targetRecordIds: [parsed.data.original_id, newId],
      before: original,
      after: { ...parsed.data, id: newId, status: "confirmed" },
    },
  );
}

export async function updateAppointmentStatusMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<AppointmentMutationData>> {
  assertDomainMutationRole(user, APPOINTMENT_CREATE_ROLES);
  const parsed = appointmentStatusSchema.safeParse(input);
  if (!parsed.success) {
    return domainFailure("appointments.failedToUpdateStatus", {
      validationError: parsed.error,
    });
  }
  const supabase = await createClient();
  const appointmentId = parsed.data.appointment_id;
  const { data: appointment, error: readError } = await supabase
    .from("appointments")
    .select("id, patient_id, status, scheduled_at, duration_minutes, deleted_at, displaced_at, replaced_by_appointment_id, cancellation_reason, no_show_reason")
    .eq("id", appointmentId)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (readError || !appointment)
    return domainFailure("appointments.appointmentNotFound");
  const allowed = STATUS_TRANSITIONS[appointment.status] ?? [];
  if (!allowed.includes(parsed.data.status)) {
    return domainFailure("appointments.cannotTransitionStatus", {
      values: { from: appointment.status, to: parsed.data.status },
    });
  }
  if (
    appointment.status === "pending" &&
    parsed.data.status === "no_show" &&
    !isOverduePending(appointment)
  ) {
    return domainFailure("appointments.cannotTransitionStatus", {
      values: { from: appointment.status, to: parsed.data.status },
    });
  }
  const now = new Date().toISOString();
  const update: TablesUpdate<"appointments"> = {
    status: parsed.data.status,
    updated_by: user.id,
  };
  if (parsed.data.status === "cancelled") {
    update.cancellation_reason = parsed.data.reason;
    update.cancelled_at = now;
    update.cancelled_by = user.id;
  }
  if (parsed.data.status === "no_show") {
    update.no_show_reason = parsed.data.reason;
    update.no_showed_at = now;
    update.no_showed_by = user.id;
  }
  if (mode === "preview") {
    return domainSuccess(
      {
        appointment_id: appointmentId,
        patient_id: appointment.patient_id,
        status: parsed.data.status,
      },
      {
        targetTable: "appointments",
        targetRecordIds: [appointmentId],
        before: appointment,
        after: { ...appointment, ...update },
      },
    );
  }
  const { error } = await supabase
    .from("appointments")
    .update(update)
    .eq("id", appointmentId)
    .eq("clinic_id", user.clinicId);
  if (error) return domainFailure("appointments.failedToUpdateStatus");
  if (parsed.data.status === "confirmed" || parsed.data.status === "cancelled") {
    await notifyAppointmentEvent({
      clinicId: user.clinicId,
      appointmentId,
      event: parsed.data.status,
    });
  }
  revalidatePath("/appointments");
  revalidatePath(`/patients/${appointment.patient_id}`);
  return domainSuccess(
    {
      appointment_id: appointmentId,
      patient_id: appointment.patient_id,
      status: parsed.data.status,
    },
    {
      targetTable: "appointments",
      targetRecordIds: [appointmentId],
      before: appointment,
      after: { ...appointment, ...update },
    },
  );
}

async function loadAppointmentForDelete(user: AuthedUser, appointmentId: string) {
  const supabase = await createClient();
  const result = await supabase
    .from("appointments")
    .select(
      "id, patient_id, doctor_id, scheduled_at, status, paid_at, paid_amount, total_amount, deleted_at, displaced_at, patients(full_name), profiles!doctor_id(full_name)",
    )
    .eq("id", appointmentId)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  return { supabase, ...result };
}

type AppointmentDependentSnapshot = {
  appointmentServices: Tables<"appointment_services">[];
  feedback: Tables<"feedback">[];
  followups: Tables<"follow_ups">[];
  settlements: Tables<"outstanding_settlements">[];
};

async function restoreDependents(
  clinicId: string,
  snapshot: AppointmentDependentSnapshot,
): Promise<boolean> {
  const admin = createClinicScopedAdminClient(clinicId);
  const results = await Promise.all([
    snapshot.appointmentServices.length
      ? admin.from("appointment_services").upsert(snapshot.appointmentServices)
      : Promise.resolve({ error: null }),
    snapshot.feedback.length
      ? admin.from("feedback").upsert(snapshot.feedback)
      : Promise.resolve({ error: null }),
    snapshot.followups.length
      ? admin.from("follow_ups").upsert(snapshot.followups)
      : Promise.resolve({ error: null }),
    snapshot.settlements.length
      ? admin.from("outstanding_settlements").upsert(snapshot.settlements)
      : Promise.resolve({ error: null }),
  ]);
  return results.every((result) => !result.error);
}

async function deleteDependents(
  appointmentId: string,
  clinicId: string,
): Promise<{ ok: true; snapshot: AppointmentDependentSnapshot } | { ok: false }> {
  const admin = createClinicScopedAdminClient(clinicId);
  const loaded = await Promise.all([
    admin.from("appointment_services").select("*").eq("appointment_id", appointmentId).eq("clinic_id", clinicId),
    admin.from("feedback").select("*").eq("appointment_id", appointmentId),
    admin.from("follow_ups").select("*").eq("appointment_id", appointmentId).eq("clinic_id", clinicId),
    admin.from("outstanding_settlements").select("*").eq("appointment_id", appointmentId).eq("clinic_id", clinicId),
  ]);
  if (loaded.some((result) => result.error)) return { ok: false };
  const snapshot: AppointmentDependentSnapshot = {
    appointmentServices: loaded[0].data ?? [],
    feedback: loaded[1].data ?? [],
    followups: loaded[2].data ?? [],
    settlements: loaded[3].data ?? [],
  };
  const deleted = await Promise.all([
    admin.from("appointment_services").delete().eq("appointment_id", appointmentId).eq("clinic_id", clinicId).select("id"),
    admin.from("feedback").delete().eq("appointment_id", appointmentId).select("id"),
    admin.from("follow_ups").delete().eq("appointment_id", appointmentId).eq("clinic_id", clinicId).select("id"),
    admin.from("outstanding_settlements").delete().eq("appointment_id", appointmentId).eq("clinic_id", clinicId).select("id"),
  ]);
  const expected = [
    snapshot.appointmentServices.length,
    snapshot.feedback.length,
    snapshot.followups.length,
    snapshot.settlements.length,
  ];
  const complete = deleted.every(
    (result, index) => !result.error && result.data?.length === expected[index],
  );
  if (!complete) {
    await restoreDependents(clinicId, snapshot);
    return { ok: false };
  }
  return { ok: true, snapshot };
}

export async function softDeleteAppointmentMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<AppointmentMutationData>> {
  assertDomainMutationRole(user, APPOINTMENT_DELETE_ROLES);
  const parsed = appointmentIdSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("appointments.appointmentNotFound", {
      validationError: parsed.error,
    });
  const { supabase, data: appointment, error } = await loadAppointmentForDelete(
    user,
    parsed.data.appointment_id,
  );
  if (error || !appointment)
    return domainFailure("appointments.appointmentNotFound");
  if (
    ["arrived", "in_session", "completed"].includes(appointment.status) ||
    appointment.paid_at !== null ||
    Number(appointment.paid_amount ?? 0) > 0 ||
    Number(appointment.total_amount ?? 0) > 0
  ) {
    return domainFailure(
      "appointments.arrivedInSessionCompletedOrChargedAppointmentsCannotBeDeleted",
    );
  }
  const deletedAt = new Date().toISOString();
  if (mode === "preview") {
    return domainSuccess(
      {
        appointment_id: parsed.data.appointment_id,
        patient_id: appointment.patient_id,
        status: appointment.status,
      },
      {
        targetTable: "appointments",
        targetRecordIds: [parsed.data.appointment_id],
        before: appointment,
        after: { ...appointment, deleted_at: deletedAt },
      },
    );
  }
  const dependentCleanup = await deleteDependents(
    parsed.data.appointment_id,
    user.clinicId,
  );
  if (!dependentCleanup.ok) {
    return domainFailure(
      "appointments.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  }
  const update = await supabase
    .from("appointments")
    .update({
      deleted_at: deletedAt,
      total_amount: null,
      paid_amount: null,
      insurance_amount: null,
      insurance_calculation_mode: "amount",
      insurance_percentage: null,
      patient_responsibility: null,
      secondary_amount: 0,
      deposit_amount: 0,
      outstanding_amount: null,
      paid_at: null,
      payment_method: null,
      secondary_payment_method: null,
      payment_note: null,
    } as TablesUpdate<"appointments">)
    .eq("id", parsed.data.appointment_id)
    .eq("clinic_id", user.clinicId);
  if (update.error) {
    await restoreDependents(user.clinicId, dependentCleanup.snapshot);
    return domainFailure(
      "appointments.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  }
  revalidatePath("/appointments");
  return domainSuccess(
    {
      appointment_id: parsed.data.appointment_id,
      patient_id: appointment.patient_id,
      status: appointment.status,
    },
    {
      targetTable: "appointments",
      targetRecordIds: [parsed.data.appointment_id],
      before: appointment,
      after: { ...appointment, deleted_at: deletedAt },
    },
  );
}

export async function restoreAppointmentMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<AppointmentMutationData>> {
  assertDomainMutationRole(user, APPOINTMENT_DELETE_ROLES);
  const parsed = appointmentIdSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("appointments.appointmentNotFound", {
      validationError: parsed.error,
    });
  if (mode === "preview") {
    return domainSuccess(
      { appointment_id: parsed.data.appointment_id },
      {
        targetTable: "appointments",
        targetRecordIds: [parsed.data.appointment_id],
        after: { deleted_at: null },
      },
    );
  }
  const supabase = await createClient();
  const update = await supabase
    .from("appointments")
    .update({ deleted_at: null })
    .eq("id", parsed.data.appointment_id)
    .eq("clinic_id", user.clinicId);
  if (update.error)
    return domainFailure(
      "appointments.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  revalidatePath("/appointments");
  return domainSuccess(
    {
      appointment_id: parsed.data.appointment_id,
    },
    {
      targetTable: "appointments",
      targetRecordIds: [parsed.data.appointment_id],
      after: { deleted_at: null },
    },
  );
}

export async function undoAppointmentStatusMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<AppointmentMutationData>> {
  assertDomainMutationRole(user, APPOINTMENT_UNDO_ROLES);
  const parsed = appointmentUndoSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("appointments.weCouldNotCompleteThisRequestPleaseTryAgain", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  const { data: appointment, error } = await supabase
    .from("appointments")
    .select("id, patient_id, doctor_id, status")
    .eq("id", parsed.data.appointment_id)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (error || !appointment)
    return domainFailure("appointments.appointmentNotFound");
  if (user.role === "doctor") {
    if (appointment.doctor_id !== user.id)
      return domainFailure("appointments.youCanOnlyUpdateYourOwnAppointments");
    if (
      parsed.data.target_status !== "arrived" ||
      appointment.status !== "in_session"
    ) {
      return domainFailure("appointments.doctorsCanOnlyUndoASessionStart");
    }
  }
  if (mode === "preview") {
    return domainSuccess(
      {
        appointment_id: parsed.data.appointment_id,
        patient_id: appointment.patient_id,
        status: parsed.data.target_status,
      },
      {
        targetTable: "appointments",
        targetRecordIds: [parsed.data.appointment_id],
        before: appointment,
        after: { ...appointment, status: parsed.data.target_status },
      },
    );
  }
  const undone = await supabase.rpc("undo_appointment_status", {
    p_appointment_id: parsed.data.appointment_id,
    p_target_status: parsed.data.target_status,
  });
  if (undone.error)
    return domainFailure(
      "appointments.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  revalidatePath("/appointments");
  revalidatePath(`/patients/${appointment.patient_id}`);
  return domainSuccess(
    {
      appointment_id: parsed.data.appointment_id,
      patient_id: appointment.patient_id,
      status: parsed.data.target_status,
    },
    {
      targetTable: "appointments",
      targetRecordIds: [parsed.data.appointment_id],
      before: appointment,
      after: { ...appointment, status: parsed.data.target_status },
    },
  );
}

export async function arriveAppointmentMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<AppointmentMutationData>> {
  assertDomainMutationRole(user, APPOINTMENT_CREATE_ROLES);
  const parsed = appointmentIdSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("appointments.appointmentNotFound", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  const { data: appointment, error } = await supabase
    .from("appointments")
    .select("id, status, patient_id")
    .eq("id", parsed.data.appointment_id)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (error || !appointment)
    return domainFailure("appointments.appointmentNotFound");
  if (appointment.status !== "confirmed") {
    return domainFailure("appointments.cannotTransitionStatus", {
      values: { from: appointment.status, to: "arrived" },
    });
  }
  if (mode === "preview") {
    return domainSuccess(
      {
        appointment_id: appointment.id,
        patient_id: appointment.patient_id,
        status: "arrived",
      },
      {
        targetTable: "appointments",
        targetRecordIds: [appointment.id],
        before: appointment,
        after: { ...appointment, status: "arrived" },
      },
    );
  }
  const updated = await supabase
    .from("appointments")
    .update({ status: "arrived", updated_by: user.id })
    .eq("id", appointment.id)
    .eq("clinic_id", user.clinicId)
    .eq("status", "confirmed");
  if (updated.error)
    return domainFailure("appointments.failedToMarkAppointmentAsArrived");
  revalidatePath("/appointments");
  revalidatePath(`/patients/${appointment.patient_id}`);
  return domainSuccess(
    {
      appointment_id: appointment.id,
      patient_id: appointment.patient_id,
      status: "arrived",
    },
    {
      targetTable: "appointments",
      targetRecordIds: [appointment.id],
      before: appointment,
      after: { ...appointment, status: "arrived" },
    },
  );
}

export async function startAppointmentSessionMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<AppointmentMutationData>> {
  assertDomainMutationRole(user, ["doctor"]);
  const parsed = appointmentIdSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("appointments.appointmentNotFound", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  const { data: appointment, error } = await supabase
    .from("appointments")
    .select("id, status, patient_id, doctor_id, clinic_id")
    .eq("id", parsed.data.appointment_id)
    .maybeSingle();
  if (error)
    return domainFailure(
      "appointments.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  if (!appointment || appointment.clinic_id !== user.clinicId)
    return domainFailure("appointments.appointmentNotFound");
  if (appointment.doctor_id !== user.id)
    return domainFailure("appointments.onlyTheAssignedDoctorCanStartThisSession");
  if (appointment.status !== "arrived")
    return domainFailure("appointments.thisAppointmentIsNoLongerArrived");
  const redirectTo = `/patients/${appointment.patient_id}/medical-notes-report`;
  if (mode === "preview") {
    return domainSuccess(
      {
        appointment_id: appointment.id,
        patient_id: appointment.patient_id,
        status: "in_session",
        redirect_to: redirectTo,
      },
      {
        targetTable: "appointments",
        targetRecordIds: [appointment.id],
        before: appointment,
        after: { ...appointment, status: "in_session" },
      },
    );
  }
  const started = await supabase
    .rpc("start_appointment_session", {
      p_appointment_id: appointment.id,
    })
    .single();
  if (started.error)
    return domainFailure(
      "appointments.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  if (started.data.status !== "in_session")
    return domainFailure("appointments.couldNotVerifyTheUpdatedSessionStatus");
  revalidatePath("/appointments");
  revalidatePath("/dashboard");
  revalidatePath(`/patients/${started.data.patient_id}`);
  revalidatePath(redirectTo);
  return domainSuccess(
    {
      appointment_id: appointment.id,
      patient_id: started.data.patient_id,
      status: "in_session",
      redirect_to: redirectTo,
    },
    {
      targetTable: "appointments",
      targetRecordIds: [appointment.id],
      before: appointment,
      after: { ...appointment, status: "in_session" },
    },
  );
}

export async function permanentDeleteAppointmentMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<AppointmentMutationData>> {
  assertDomainMutationRole(user, APPOINTMENT_DELETE_ROLES);
  const parsed = appointmentIdSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("appointments.appointmentNotFound", {
      validationError: parsed.error,
    });
  const { data: appointment, error } = await loadAppointmentForDelete(
    user,
    parsed.data.appointment_id,
  );
  if (error || !appointment || !appointment.deleted_at)
    return domainFailure("appointments.appointmentNotFound");
  if (mode === "preview") {
    return domainSuccess(
      {
        appointment_id: appointment.id,
        patient_id: appointment.patient_id,
        status: appointment.status,
      },
      {
        targetTable: "appointments",
        targetRecordIds: [appointment.id],
        before: appointment,
        after: null,
      },
    );
  }
  const dependentCleanup = await deleteDependents(
    parsed.data.appointment_id,
    user.clinicId,
  );
  if (!dependentCleanup.ok)
    return domainFailure(
      "appointments.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  // The UI authorizes managers for this operation, while the table's DELETE
  // policy remains admin-only. The tenant-bound admin client is safe here only
  // after the session client proved the exact trashed appointment belongs to
  // the actor's clinic and the core role check passed.
  const admin = createClinicScopedAdminClient(user.clinicId);
  const removed = await admin
    .from("appointments")
    .delete()
    .eq("id", parsed.data.appointment_id)
    .eq("clinic_id", user.clinicId)
    .not("deleted_at", "is", null)
    .select("id");
  if (removed.error || removed.data?.length !== 1) {
    await restoreDependents(user.clinicId, dependentCleanup.snapshot);
    return domainFailure(
      "appointments.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  }
  revalidatePath("/appointments");
  return domainSuccess(
    {
      appointment_id: parsed.data.appointment_id,
      patient_id: appointment.patient_id,
      status: appointment.status,
    },
    {
      targetTable: "appointments",
      targetRecordIds: [parsed.data.appointment_id],
      before: appointment,
      after: null,
    },
  );
}

export async function confirmAndDisplaceAppointmentsMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<AppointmentMutationData>> {
  assertDomainMutationRole(user, APPOINTMENT_CREATE_ROLES);
  const parsed = appointmentConflictSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("appointments.failedToCheckForConflicts", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  const { data: target, error: targetError } = await supabase
    .from("appointments")
    .select("id, patient_id, doctor_id, scheduled_at, duration_minutes, status, patients(full_name), profiles!doctor_id(full_name)")
    .eq("id", parsed.data.appointment_id)
    .eq("clinic_id", user.clinicId)
    .eq("status", "pending")
    .maybeSingle();
  if (targetError || !target)
    return domainFailure("appointments.cannotConfirmThisAppointment");
  let conflicts: Array<{
    id: string;
    status: AppointmentStatus;
    patient_id: string;
    doctor_id: string;
    scheduled_at: string;
    patients: { full_name: string } | null;
    profiles: { full_name: string } | null;
  }> = [];
  if (parsed.data.conflicting_ids.length > 0) {
    const found = await supabase
      .from("appointments")
      .select("id, status, patient_id, doctor_id, scheduled_at, patients(full_name), profiles!doctor_id(full_name)")
      .eq("clinic_id", user.clinicId)
      .eq("doctor_id", target.doctor_id)
      .eq("status", "pending")
      .in("id", parsed.data.conflicting_ids);
    if (found.error || found.data?.length !== parsed.data.conflicting_ids.length)
      return domainFailure("appointments.failedToCheckForConflicts");
    conflicts = found.data;
  }
  const now = new Date().toISOString();
  if (mode === "preview") {
    return domainSuccess(
      {
        appointment_id: target.id,
        patient_id: target.patient_id,
        status: "confirmed",
      },
      {
        targetTable: "appointments",
        targetRecordIds: [target.id, ...conflicts.map((row) => row.id)],
        before: { target, conflicts },
        after: {
          target: { ...target, status: "confirmed" },
          conflicts: conflicts.map((row) => ({
            ...row,
            deleted_at: now,
            displaced_at: now,
          })),
        },
      },
    );
  }
  const confirmed = await supabase
    .from("appointments")
    .update({ status: "confirmed", updated_by: user.id })
    .eq("id", target.id)
    .eq("clinic_id", user.clinicId)
    .eq("status", "pending");
  if (confirmed.error)
    return domainFailure("appointments.failedToConfirmAppointment");
  if (conflicts.length > 0) {
    const displaced = await supabase
      .from("appointments")
      .update({ deleted_at: now, displaced_at: now, displaced_by: user.id })
      .in(
        "id",
        conflicts.map((row) => row.id),
      )
      .eq("clinic_id", user.clinicId)
      .eq("status", "pending");
    if (displaced.error) {
      return domainFailure(
        "appointments.appointmentConfirmedButFailedToRemoveConflictingAppointments",
      );
    }
  }
  await notifyAppointmentEvent({
    clinicId: user.clinicId,
    appointmentId: target.id,
    event: "confirmed",
  });
  revalidatePath("/appointments");
  return domainSuccess(
    {
      appointment_id: target.id,
      patient_id: target.patient_id,
      status: "confirmed",
    },
    {
      targetTable: "appointments",
      targetRecordIds: [target.id, ...conflicts.map((row) => row.id)],
      before: { target, conflicts },
      after: { target: { ...target, status: "confirmed" }, conflicts },
    },
  );
}

export async function dismissDisplacedAppointmentMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<AppointmentMutationData>> {
  assertDomainMutationRole(user, APPOINTMENT_DELETE_ROLES);
  const parsed = appointmentIdSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("appointments.failedToDismissAppointment", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  const { data: appointment, error } = await supabase
    .from("appointments")
    .select("id, patient_id, status, displaced_at")
    .eq("id", parsed.data.appointment_id)
    .eq("clinic_id", user.clinicId)
    .not("displaced_at", "is", null)
    .maybeSingle();
  if (error || !appointment)
    return domainFailure("appointments.failedToDismissAppointment");
  if (mode === "preview") {
    return domainSuccess(
      {
        appointment_id: appointment.id,
        patient_id: appointment.patient_id,
        status: appointment.status,
      },
      {
        targetTable: "appointments",
        targetRecordIds: [appointment.id],
        before: appointment,
        after: null,
      },
    );
  }
  const removed = await supabase
    .from("appointments")
    .delete()
    .eq("id", appointment.id)
    .eq("clinic_id", user.clinicId)
    .not("displaced_at", "is", null);
  if (removed.error)
    return domainFailure("appointments.failedToDismissAppointment");
  revalidatePath("/appointments");
  return domainSuccess(
    {
      appointment_id: appointment.id,
      patient_id: appointment.patient_id,
      status: appointment.status,
    },
    {
      targetTable: "appointments",
      targetRecordIds: [appointment.id],
      before: appointment,
      after: null,
    },
  );
}
