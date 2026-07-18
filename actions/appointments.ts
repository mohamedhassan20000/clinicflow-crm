"use server";

import { actionAppointmentStatus, actionError, actionWeekday } from "@/lib/i18n/action-errors";
import { localizeZodFieldErrors } from "@/lib/validations/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { fromZonedTime, toZonedTime } from "date-fns-tz";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireMutationRole, requireRole } from "@/lib/rbac";
import {
  appointmentSchema,
  billingSchema,
  STATUS_TRANSITIONS,
  type AppointmentFormValues,
  type BillingValues,
  type LineItemValues,
} from "@/lib/validations/appointment";
import type { Database, TablesUpdate } from "@/types/database";
import { getPatientAccountBalance } from "@/actions/patients";
import { ensureInvoiceFollowupSequence } from "@/lib/messaging/followups";
import { notifyAppointmentEvent } from "@/lib/messaging/appointment-notifications";
import { deliverIssuedInvoice } from "@/lib/messaging/invoice-delivery";
import { getClinicWorkingHours } from "@/actions/settings";
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";

export type ActionResult = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  success?: boolean;
};
type AppointmentStatus = Database["public"]["Enums"]["appointment_status"];
export type InvoiceUndoStatus = Extract<AppointmentStatus, "pending" | "confirmed" | "arrived" | "in_session">;
export type StartAppointmentSessionResult = ActionResult & {
  redirectTo?: string;
  patientId?: string;
};
type AppointmentValues = AppointmentFormValues;
type ValidatedAppointmentPackage = {
  packageId: string | null;
  packageSessionNumber: number | null;
};

function isPastScheduledAt(scheduledAt: string): boolean {
  const scheduledTime = new Date(scheduledAt).getTime();
  return Number.isFinite(scheduledTime) && scheduledTime <= Date.now();
}

async function validateAppointmentReferences(
  values: AppointmentValues,
  clinicId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const [patientResult, doctorResult, departmentResult, insuranceResult] =
    await Promise.all([
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

  if (patientResult.error) return { error: await actionError("appointments.failedToValidatePatient") };
  if (doctorResult.error) return { error: await actionError("appointments.failedToValidateDoctor") };
  if (departmentResult.error) return { error: await actionError("appointments.failedToValidateDepartment") };
  if (insuranceResult.error) return { error: await actionError("appointments.failedToValidateInsuranceProvider") };
  if (!patientResult.data) return { error: await actionError("appointments.selectAnActivePatientInThisClinic") };
  if (!doctorResult.data) return { error: await actionError("appointments.selectAnActiveDoctorInThisClinic") };
  if (values.department_id && !departmentResult.data) {
    return { error: await actionError("appointments.selectAnActiveDepartmentInThisClinic") };
  }
  if (values.insurance_provider_id && !insuranceResult.data) {
    return { error: await actionError("appointments.selectAnActiveInsuranceProviderInThisClinic") };
  }
  if (
    values.department_id &&
    doctorResult.data.department_id &&
    doctorResult.data.department_id !== values.department_id
  ) {
    return { error: await actionError("appointments.selectedDoctorDoesNotBelongToTheSelectedDepartment") };
  }

  return {};
}

async function getClinicTimeZone(clinicId: string): Promise<string> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("clinics")
    .select("timezone")
    .eq("id", clinicId)
    .maybeSingle();

  return typeof data?.timezone === "string" && data.timezone
    ? data.timezone
    : DEFAULT_TIME_ZONE;
}

async function validateAppointmentPackage(
  values: AppointmentValues,
  clinicId: string,
): Promise<
  ActionResult & { data?: ValidatedAppointmentPackage }
> {
  if (!values.package_id) {
    return { data: { packageId: null, packageSessionNumber: null } };
  }

  const supabase = await createClient();
  const { data: pkg, error } = await supabase
    .from("patient_packages")
    .select("id, patient_id, clinic_id, is_active, total_sessions, used_sessions")
    .eq("id", values.package_id)
    .eq("clinic_id", clinicId)
    .eq("patient_id", values.patient_id)
    .maybeSingle();

  if (error) {
    return {
      error: await actionError("appointments.failedToValidatePackage"),
      fieldErrors: { package_id: [await actionError("appointments.failedToValidatePackage")] },
    };
  }

  if (!pkg) {
    return {
      error: await actionError("appointments.selectAnActivePackageForThisPatient"),
      fieldErrors: { package_id: [await actionError("appointments.selectAnActivePackageForThisPatient")] },
    };
  }

  if (!pkg.is_active || Number(pkg.used_sessions) >= Number(pkg.total_sessions)) {
    return {
      error: await actionError("appointments.selectedPackageHasNoRemainingSessions"),
      fieldErrors: { package_id: [await actionError("appointments.selectedPackageHasNoRemainingSessions")] },
    };
  }

  return {
    data: {
      packageId: pkg.id,
      packageSessionNumber: Number(pkg.used_sessions) + 1,
    },
  };
}

async function validateAppointmentSlot(
  values: AppointmentValues,
  clinicId: string,
  timeZone: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const startTime = new Date(values.scheduled_at);
  const endTime = new Date(startTime.getTime() + values.duration_minutes * 60_000);
  const zonedStart = toZonedTime(startTime, timeZone);
  const dayStart = fromZonedTime(
    new Date(
      zonedStart.getFullYear(),
      zonedStart.getMonth(),
      zonedStart.getDate(),
      0,
      0,
      0,
      0,
    ),
    timeZone,
  );
  const dayEnd = fromZonedTime(
    new Date(
      zonedStart.getFullYear(),
      zonedStart.getMonth(),
      zonedStart.getDate(),
      23,
      59,
      59,
      999,
    ),
    timeZone,
  );

  const { data: sameDay, error } = await supabase
    .from("appointments")
    .select("scheduled_at, duration_minutes")
    .eq("doctor_id", values.doctor_id)
    .eq("clinic_id", clinicId)
    .is("deleted_at", null)
    .in("status", ["confirmed", "arrived", "in_session"])
    .gte("scheduled_at", dayStart.toISOString())
    .lte("scheduled_at", dayEnd.toISOString());

  if (error) {
    return {
      error:
        await actionError("appointments.couldNotVerifyTheDoctorSAvailabilityPleaseTryAgain"),
    };
  }

  const BUFFER_MS = 15 * 60_000;
  for (const appt of sameDay ?? []) {
    const exStart = new Date(appt.scheduled_at);
    const exEnd = new Date(exStart.getTime() + appt.duration_minutes * 60_000);
    const overlapsSession = startTime < exEnd && endTime > exStart;
    if (overlapsSession) {
      return {
        error:
          await actionError("appointments.thisDoctorIsAlreadyBookedDuringTheSelectedSessionTime"),
      };
    }
    if (
      startTime < new Date(exEnd.getTime() + BUFFER_MS) &&
      endTime > new Date(exStart.getTime() - BUFFER_MS)
    ) {
      return {
        error:
          await actionError("appointments.thisDoctorNeedsA15MinuteRecoveryBufferWindowBetween"),
      };
    }
  }

  return {};
}

export async function createAppointment(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);

  const durationRaw = formData.get("duration_minutes");
  const raw = {
    patient_id: formData.get("patient_id"),
    doctor_id: formData.get("doctor_id"),
    department_id: formData.get("department_id") || null,
    scheduled_at: formData.get("scheduled_at"),
    duration_minutes: durationRaw ? Number(durationRaw) : 30,
    insurance_provider_id: formData.get("insurance_provider_id") || null,
    package_id: formData.get("package_id") || null,
    notes: formData.get("notes") || null,
  };

  const parsed = appointmentSchema.safeParse(raw);
  if (!parsed.success) {
    const flat = await localizeZodFieldErrors(parsed.error);
    const first = Object.values(flat).flat()[0];
    return { error: first ?? await actionError("appointments.pleaseFillEveryRequiredField"), fieldErrors: flat };
  }

  if (isPastScheduledAt(parsed.data.scheduled_at)) {
    return { error: await actionError("appointments.chooseAFutureDateAndTimeForTheAppointment") };
  }

  const clinicTimeZone = await getClinicTimeZone(user.clinicId);

  // Validate appointment is not on a clinic-closed day
  const clinicHours = await getClinicWorkingHours();
  if (clinicHours.some((d) => d.open)) {
    const apptDate = toZonedTime(parsed.data.scheduled_at, clinicTimeZone);
    const dow = apptDate.getDay();
    const clinicDay = clinicHours.find((d) => d.day_of_week === dow);
    if (!clinicDay?.open) {
      return { error: await actionError("appointments.clinicClosedOnDay", { day: await actionWeekday(dow) }) };
    }
  }

  const references = await validateAppointmentReferences(
    parsed.data,
    user.clinicId,
  );
  if (references.error) return references;

  const selectedPackage = await validateAppointmentPackage(parsed.data, user.clinicId);
  if (selectedPackage.error) return selectedPackage;

  const slot = await validateAppointmentSlot(
    parsed.data,
    user.clinicId,
    clinicTimeZone,
  );
  if (slot.error) return slot;

  const supabase = await createClient();
  const { data: inserted, error } = await supabase
    .from("appointments")
    .insert({
      ...parsed.data,
      package_id: selectedPackage.data?.packageId ?? null,
      package_session_number: selectedPackage.data?.packageSessionNumber ?? null,
      clinic_id: user.clinicId,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") {
      const msg = error.message ?? "";
      if (msg.includes("appointments_patient_active_slot_key")) {
        return {
          error:
            await actionError("appointments.thisPatientAlreadyHasAnotherAppointmentAtTheSameTime"),
        };
      }
      return {
        error:
          await actionError("appointments.thisDoctorAlreadyHasAnAppointmentAtThatTimePlease"),
      };
    }
    return { error: await actionError("appointments.failedToCreateAppointmentPleaseTryAgain") };
  }

  // §7.2a: a newly created appointment is pending — notify the patient
  // immediately (WhatsApp + Email). Best-effort; never blocks the booking.
  if (inserted?.id) {
    await notifyAppointmentEvent({
      clinicId: user.clinicId,
      appointmentId: inserted.id,
      event: "created",
    });
  }

  revalidatePath("/appointments");
  redirect("/appointments");
}

export type BillingInput = BillingValues;

function lineItemTotal(items: LineItemValues[]): number {
  return Number(
    items
      .reduce((s, li) => s + Number(li.price) * Number(li.quantity), 0)
      .toFixed(2),
  );
}

export async function updateAppointmentStatus(
  id: string,
  newStatus: string,
  billingPayload?: BillingInput | null,
  cancellationReason?: string | null,
  noShowReason?: string | null,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);

  const supabase = await createClient();

  const { data: appt } = await supabase
    .from("appointments")
    .select("status, patient_id")
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .single();

  if (!appt) return { error: await actionError("appointments.appointmentNotFound") };

  const allowed = STATUS_TRANSITIONS[appt.status] ?? [];
  const completingWithInvoice = newStatus === "completed" && !!billingPayload;
  if (!completingWithInvoice && !allowed.includes(newStatus)) {
    return { error: await actionError("appointments.cannotTransitionStatus", {
      from: await actionAppointmentStatus(appt.status),
      to: await actionAppointmentStatus(newStatus),
    }) };
  }
  if (
    completingWithInvoice &&
    !["pending", "confirmed", "arrived", "in_session"].includes(appt.status)
  ) {
    return { error: await actionError("appointments.cannotTransitionStatus", {
      from: await actionAppointmentStatus(appt.status),
      to: await actionAppointmentStatus(newStatus),
    }) };
  }

  const update: TablesUpdate<"appointments"> = {
    status: newStatus as TablesUpdate<"appointments">["status"],
    updated_by: user.id,
  };

  if (newStatus === "cancelled") {
    const reason = (cancellationReason ?? "").trim();
    if (!reason) {
      return { error: await actionError("appointments.pleaseProvideAReasonForCancellingThisAppointment") };
    }
    if (reason.length > 500) {
      return { error: await actionError("appointments.cancellationReasonMustBe500CharactersOrLess") };
    }
    update.cancellation_reason = reason;
    update.cancelled_at = new Date().toISOString();
    update.cancelled_by = user.id;
  }

  if (newStatus === "no_show") {
    const reason = (noShowReason ?? "").trim();
    if (!reason) {
      return {
        error: await actionError("appointments.pleaseProvideAReasonForMarkingThisAppointmentAsA"),
      };
    }
    if (reason.length > 500) {
      return { error: await actionError("appointments.noShowReasonMustBe500CharactersOrLess") };
    }
    update.no_show_reason = reason;
    update.no_showed_at = new Date().toISOString();
    update.no_showed_by = user.id;
  }

  if (newStatus === "completed") {
    if (!billingPayload) {
      return { error: await actionError("appointments.billingDetailsAreRequiredToCompleteThisAppointment") };
    }

    const parsed = billingSchema.safeParse(billingPayload);
    if (!parsed.success) {
      const flat = await localizeZodFieldErrors(parsed.error);
      const first = Object.values(flat).flat()[0];
      return { error: first ?? await actionError("appointments.invalidBillingDetails"), fieldErrors: flat };
    }
    const billing = parsed.data;

    const total = lineItemTotal(billing.line_items);
    if (total <= 0) {
      return { error: await actionError("appointments.invoiceTotalMustBeGreaterThanZero") };
    }

    // Validate deposit_amount against patient's available balance
    if (billing.deposit_amount > 0) {
      const balance = await getPatientAccountBalance(
        appt.patient_id,
        user.clinicId,
      );
      if (billing.deposit_amount > balance + 0.001) {
        return {
          error: await actionError("appointments.depositExceedsBalance", {
            deposit: billing.deposit_amount.toFixed(2),
            balance: balance.toFixed(2),
          }),
        };
      }
      if (billing.deposit_amount > total + 0.001) {
        return { error: await actionError("appointments.depositAppliedCannotExceedInvoiceTotal") };
      }
    }

    const collected =
      billing.paid_amount +
      billing.insurance_amount +
      billing.secondary_amount +
      billing.deposit_amount;
    if (collected > total + 0.001) {
      return { error: await actionError("appointments.collectedAmountExceedsInvoiceTotal") };
    }
    const baseBillingArgs = {
      p_appointment_id: id,
      p_line_items: billing.line_items,
      p_paid_amount: Number(billing.paid_amount.toFixed(2)),
      p_payment_method: billing.payment_method,
      p_insurance_amount: Number(billing.insurance_amount.toFixed(2)),
      p_secondary_amount: Number(billing.secondary_amount.toFixed(2)),
      p_secondary_payment_method:
        billing.secondary_payment_method ?? undefined,
      p_deposit_amount: Number(billing.deposit_amount.toFixed(2)),
      p_payment_note: billing.payment_note ?? undefined,
    };

    const previousSettlementAmount = billing.previous_settlement_amount;
    const { error } =
      previousSettlementAmount > 0
        ? await supabase.rpc(
            "complete_appointment_billing_with_previous_settlement",
            {
              ...baseBillingArgs,
              p_previous_settlement_amount: previousSettlementAmount,
              p_previous_payment_method:
                billing.previous_payment_method ?? undefined,
              p_previous_note: billing.previous_note ?? undefined,
            },
          )
        : await supabase.rpc("complete_appointment_billing", baseBillingArgs);

    if (error) return { error: await actionError("appointments.weCouldNotCompleteThisRequestPleaseTryAgain") };

    // §7.3b: an invoice that completes with an outstanding balance enters the
    // dunning follow-up sequence (per-clinic configurable timing), advanced by
    // the daily morning cron. Registration is idempotent and best-effort — it
    // never fails billing. Invoice *delivery* to the patient is no longer
    // automatic (2026-07-19 flow revision): the employee sends it explicitly
    // via sendInvoiceToPatient after saving.
    if (total - collected > 0.001) {
      await ensureInvoiceFollowupSequence(user.clinicId, id);
    }

    revalidatePath("/appointments");
    revalidatePath(`/patients/${appt.patient_id}`);
    return {};
  }

  const { error } = await supabase
    .from("appointments")
    .update(update)
    .eq("id", id)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: await actionError("appointments.failedToUpdateStatus") };

  // §7.2a: confirming or cancelling an appointment notifies the patient
  // immediately (WhatsApp + Email). Best-effort; never blocks the status change.
  if (newStatus === "confirmed" || newStatus === "cancelled") {
    await notifyAppointmentEvent({
      clinicId: user.clinicId,
      appointmentId: id,
      event: newStatus,
    });
  }

  revalidatePath("/appointments");
  revalidatePath(`/patients/${appt.patient_id}`);
  return {};
}

export async function softDeleteAppointment(id: string): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const { data: appt, error: fetchError } = await supabase
    .from("appointments")
    .select("status, paid_at, paid_amount, total_amount")
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .single();

  if (fetchError || !appt) return { error: await actionError("appointments.appointmentNotFound") };

  if (
    ["arrived", "in_session", "completed"].includes(appt.status) ||
    appt.paid_at !== null ||
    (appt.paid_amount !== null && appt.paid_amount > 0) ||
    (appt.total_amount !== null && appt.total_amount > 0)
  ) {
    return {
      error:
        await actionError("appointments.arrivedInSessionCompletedOrChargedAppointmentsCannotBeDeleted"),
    };
  }

  const cascaded = await deleteAppointmentDependents(id, user.clinicId);
  if (cascaded.error) return cascaded;
  const { error } = await supabase
    .from("appointments")
    .update({
      deleted_at: new Date().toISOString(),
      total_amount: null,
      paid_amount: null,
      insurance_amount: null,
      secondary_amount: 0,
      deposit_amount: 0,
      outstanding_amount: null,
      paid_at: null,
      payment_method: null,
      secondary_payment_method: null,
      payment_note: null,
    } as TablesUpdate<"appointments">)
    .eq("id", id)
    .eq("clinic_id", user.clinicId);
  if (error) return { error: await actionError("appointments.weCouldNotCompleteThisRequestPleaseTryAgain") };
  revalidatePath("/appointments");
  return {};
}

export async function restoreAppointment(id: string): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("appointments")
    .update({ deleted_at: null })
    .eq("id", id)
    .eq("clinic_id", user.clinicId);
  if (error) return { error: await actionError("appointments.weCouldNotCompleteThisRequestPleaseTryAgain") };
  revalidatePath("/appointments");
  return {};
}

async function deleteAppointmentDependents(
  appointmentId: string,
  clinicId: string,
): Promise<ActionResult> {
  const adminClient = createClinicScopedAdminClient(clinicId);
  const operations = [
    adminClient
      .from("appointment_services")
      .delete()
      .eq("appointment_id", appointmentId)
      .eq("clinic_id", clinicId),
    adminClient.from("feedback").delete().eq("appointment_id", appointmentId),
    adminClient
      .from("follow_ups")
      .delete()
      .eq("appointment_id", appointmentId)
      .eq("clinic_id", clinicId),
    adminClient
      .from("outstanding_settlements")
      .delete()
      .eq("appointment_id", appointmentId)
      .eq("clinic_id", clinicId),
  ];

  const results = await Promise.all(operations);
  const failed = results.find((r) => r.error);
  if (failed?.error) return { error: await actionError("appointments.weCouldNotCompleteThisRequestPleaseTryAgain") };
  return {};
}

export async function undoAppointmentStatus(
  id: string,
  targetStatus: Extract<AppointmentStatus, "pending" | "confirmed" | "arrived" | "in_session">,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist", "doctor"]);
  const supabase = await createClient();

  const { data: appt } = await supabase
    .from("appointments")
    .select("patient_id, doctor_id, status")
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .single();

  if (!appt) return { error: await actionError("appointments.appointmentNotFound") };
  if (user.role === "doctor") {
    if (appt.doctor_id !== user.id) {
      return { error: await actionError("appointments.youCanOnlyUpdateYourOwnAppointments") };
    }
    if (targetStatus !== "arrived" || appt.status !== "in_session") {
      return { error: await actionError("appointments.doctorsCanOnlyUndoASessionStart") };
    }
  }

  const { error } = await supabase.rpc("undo_appointment_status", {
    p_appointment_id: id,
    p_target_status: targetStatus,
  });

  if (error) return { error: await actionError("appointments.weCouldNotCompleteThisRequestPleaseTryAgain") };

  revalidatePath("/appointments");
  revalidatePath(`/patients/${appt.patient_id}`);
  return {};
}

export async function arriveAppointment(id: string): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const { data: appt } = await supabase
    .from("appointments")
    .select("status, patient_id")
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .single();

  if (!appt) return { error: await actionError("appointments.appointmentNotFound") };
  if (appt.status !== "confirmed") {
    return { error: await actionError("appointments.cannotTransitionStatus", {
      from: await actionAppointmentStatus(appt.status),
      to: await actionAppointmentStatus("arrived"),
    }) };
  }

  const { error } = await supabase
    .from("appointments")
    .update({
      status: "arrived",
      updated_by: user.id,
    } as TablesUpdate<"appointments">)
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .eq("status", "confirmed");

  if (error) return { error: await actionError("appointments.failedToMarkAppointmentAsArrived") };

  revalidatePath("/appointments");
  revalidatePath(`/patients/${appt.patient_id}`);
  return { success: true };
}

export async function startAppointmentSession(
  id: string,
): Promise<StartAppointmentSessionResult> {
  const user = await requireMutationRole(["doctor"]);
  const supabase = await createClient();

  const { data: appt, error: readError } = await supabase
    .from("appointments")
    .select("id, status, patient_id, doctor_id, clinic_id")
    .eq("id", id)
    .maybeSingle();

  if (readError) return { error: await actionError("appointments.weCouldNotCompleteThisRequestPleaseTryAgain") };
  if (!appt) return { error: await actionError("appointments.appointmentNotFound") };
  if (appt.clinic_id !== user.clinicId) {
    return { error: await actionError("appointments.appointmentNotFound") };
  }
  if (appt.doctor_id !== user.id) {
    return { error: await actionError("appointments.onlyTheAssignedDoctorCanStartThisSession") };
  }
  if (appt.status !== "arrived") {
    return { error: await actionError("appointments.thisAppointmentIsNoLongerArrived") };
  }

  const { data: startedSession, error } = await supabase
    .rpc("start_appointment_session", { p_appointment_id: id })
    .single();

  if (error) return { error: await actionError("appointments.weCouldNotCompleteThisRequestPleaseTryAgain") };
  if (startedSession.status !== "in_session") {
    return { error: await actionError("appointments.couldNotVerifyTheUpdatedSessionStatus") };
  }

  const redirectTo = `/patients/${startedSession.patient_id}/medical-notes-report`;
  revalidatePath("/appointments");
  revalidatePath("/dashboard");
  revalidatePath(`/patients/${startedSession.patient_id}`);
  revalidatePath(redirectTo);
  return { success: true, patientId: startedSession.patient_id, redirectTo };
}

export async function undoInvoiceCompletion(
  id: string,
  targetStatus: InvoiceUndoStatus,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const { data: appt } = await supabase
    .from("appointments")
    .select("patient_id")
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .single();

  if (!appt) return { error: await actionError("appointments.appointmentNotFound") };

  const { data: provenanceRows, error: provenanceError } = await supabase
    .from("outstanding_settlements")
    .select("id")
    .eq("clinic_id", user.clinicId)
    .eq("source_appointment_id", id)
    .limit(1);

  if (provenanceError) return { error: await actionError("appointments.weCouldNotCompleteThisRequestPleaseTryAgain") };

  const undoRpc =
    (provenanceRows?.length ?? 0) > 0
      ? "undo_appointment_billing_with_previous_settlement"
      : "undo_appointment_billing";

  const { error } = await supabase.rpc(undoRpc, {
    p_appointment_id: id,
    p_target_status: targetStatus,
  });

  if (error) return { error: await actionError("appointments.weCouldNotCompleteThisRequestPleaseTryAgain") };

  revalidatePath("/appointments");
  revalidatePath(`/patients/${appt.patient_id}`);
  return {};
}

export type InvoiceChannelState = "sent" | "already_sent" | "failed" | "unavailable";
export type SendInvoiceResult = ActionResult & {
  channels?: { email: InvoiceChannelState; whatsapp: InvoiceChannelState };
};

/**
 * Manually deliver a completed appointment's invoice to the patient (§7.3a,
 * 2026-07-19 flow revision). Triggered by the "Send to patient" action after
 * the employee saves the invoice — never automatically. Email and WhatsApp are
 * independent and idempotent, so re-sending only retries the channel that has
 * not yet succeeded.
 */
export async function sendInvoiceToPatient(
  appointmentId: string,
): Promise<SendInvoiceResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const { data: appt } = await supabase
    .from("appointments")
    .select("status, total_amount")
    .eq("id", appointmentId)
    .eq("clinic_id", user.clinicId)
    .single();

  if (!appt) return { error: await actionError("appointments.appointmentNotFound") };
  if (appt.status !== "completed" || !((appt.total_amount ?? 0) > 0)) {
    return { error: await actionError("appointments.noInvoiceToSend") };
  }

  const result = await deliverIssuedInvoice({
    clinicId: user.clinicId,
    appointmentId,
  });
  if (!result) {
    return { error: await actionError("appointments.failedToSendInvoice") };
  }

  const normalize = (
    outcome:
      | { status: "sent" | "duplicate" | "ambiguous" | "failed" | "not_attempted" }
      | null,
  ): InvoiceChannelState => {
    switch (outcome?.status) {
      case "sent":
      case "ambiguous":
        return "sent";
      case "duplicate":
        return "already_sent";
      case "failed":
        return "failed";
      default:
        return "unavailable";
    }
  };

  return {
    success: true,
    channels: {
      email: normalize(result.email),
      whatsapp: normalize(result.whatsapp),
    },
  };
}

export async function permanentDeleteAppointment(id: string): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const { data: appt, error: fetchError } = await supabase
    .from("appointments")
    .select("id")
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .not("deleted_at", "is", null)
    .maybeSingle();

  if (fetchError) return { error: await actionError("appointments.weCouldNotCompleteThisRequestPleaseTryAgain") };
  if (!appt) return { error: await actionError("appointments.appointmentNotFound") };

  const cascaded = await deleteAppointmentDependents(id, user.clinicId);
  if (cascaded.error) return cascaded;

  const { error } = await supabase
    .from("appointments")
    .delete()
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .not("deleted_at", "is", null);

  if (error) return { error: await actionError("appointments.weCouldNotCompleteThisRequestPleaseTryAgain") };

  revalidatePath("/appointments");
  return { success: true };
}

export async function emptyAppointmentsTrash(): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const { data: trashedAppointments, error: selectError } = await supabase
    .from("appointments")
    .select("id")
    .eq("clinic_id", user.clinicId)
    .not("deleted_at", "is", null);

  if (selectError) return { error: await actionError("appointments.weCouldNotCompleteThisRequestPleaseTryAgain") };

  const ids = (trashedAppointments ?? []).map((appointment) => appointment.id);
  if (ids.length === 0) return { success: true };

  const adminClient = createClinicScopedAdminClient(user.clinicId);

  const { error: servicesError } = await adminClient
    .from("appointment_services")
    .delete()
    .in("appointment_id", ids)
    .eq("clinic_id", user.clinicId);
  if (servicesError) return { error: await actionError("appointments.weCouldNotCompleteThisRequestPleaseTryAgain") };

  const { error: feedbackError } = await adminClient
    .from("feedback")
    .delete()
    .in("appointment_id", ids);
  if (feedbackError) return { error: await actionError("appointments.weCouldNotCompleteThisRequestPleaseTryAgain") };

  const { error: followUpsError } = await adminClient
    .from("follow_ups")
    .delete()
    .in("appointment_id", ids)
    .eq("clinic_id", user.clinicId);
  if (followUpsError) return { error: await actionError("appointments.weCouldNotCompleteThisRequestPleaseTryAgain") };

  const { error: settlementsError } = await adminClient
    .from("outstanding_settlements")
    .delete()
    .in("appointment_id", ids)
    .eq("clinic_id", user.clinicId);
  if (settlementsError) return { error: await actionError("appointments.weCouldNotCompleteThisRequestPleaseTryAgain") };

  const { error } = await supabase
    .from("appointments")
    .delete()
    .eq("clinic_id", user.clinicId)
    .in("id", ids)
    .not("deleted_at", "is", null);

  if (error) return { error: await actionError("appointments.weCouldNotCompleteThisRequestPleaseTryAgain") };

  revalidatePath("/appointments");
  return { success: true };
}

export async function cancelAppointment(
  id: string,
  reason: string,
): Promise<ActionResult> {
  return updateAppointmentStatus(id, "cancelled", null, reason);
}

export interface BillingContext {
  patientId: string;
  patientName: string;
  hasInsurance: boolean;
  insuranceProviderName: string | null;
  accountBalance: number;
  previousOutstandingBalance: number;
  departmentId: string | null;
  departmentName: string | null;
  departmentColor: string | null;
  packageInfo: {
    name: string;
    totalSessions: number;
    usedSessions: number;
    remainingSessions: number;
    sessionNumber: number | null;
    pricePerSession: number | null;
  } | null;
  services: { id: string; name: string; price: number; department_id: string }[];
}

/**
 * Loads the data the BillingDialog needs to render: department services,
 * patient account balance, and a couple of display fields. Single round-trip
 * from the client when the dialog opens.
 */
export async function getBillingContext(
  appointmentId: string,
): Promise<{ data?: BillingContext; error?: string }> {
  const user = await requireRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const { data: appt, error: apptError } = await supabase
    .from("appointments")
    .select(
      "id, patient_id, department_id, insurance_provider_id, package_session_number, patients(full_name), departments(name, color), insurance_providers(name), patient_packages(name, total_sessions, used_sessions, price_per_session)",
    )
    .eq("id", appointmentId)
    .eq("clinic_id", user.clinicId)
    .single();

  if (apptError || !appt) return { error: await actionError("appointments.appointmentNotFound") };

  const [balance, { data: previousOutstandingRows }] = await Promise.all([
    getPatientAccountBalance(appt.patient_id, user.clinicId),
    supabase
      .from("appointments")
      .select("outstanding_amount")
      .eq("clinic_id", user.clinicId)
      .eq("patient_id", appt.patient_id)
      .neq("id", appointmentId)
      .is("deleted_at", null)
      .gt("outstanding_amount", 0),
  ]);
  const previousOutstandingBalance = Number(
    (previousOutstandingRows ?? [])
      .reduce((sum, row) => sum + Number(row.outstanding_amount ?? 0), 0)
      .toFixed(2),
  );

  let services: BillingContext["services"] = [];
  if (appt.department_id) {
    const { data: svc } = await supabase
      .from("services")
      .select("id, name, price, department_id")
      .eq("clinic_id", user.clinicId)
      .eq("department_id", appt.department_id)
      .order("name", { ascending: true });
    services = (svc ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      price: Number(s.price),
      department_id: s.department_id,
    }));
  }

  // Fallback: if department has no services configured, surface all clinic services
  // so reception can still bill from the price list.
  if (services.length === 0) {
    const { data: svc } = await supabase
      .from("services")
      .select("id, name, price, department_id")
      .eq("clinic_id", user.clinicId)
      .order("name", { ascending: true });
    services = (svc ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      price: Number(s.price),
      department_id: s.department_id ?? "",
    }));
  }

  // "No Insurance (Self-Pay)" is a directory entry used at booking to flag
  // self-paying patients — treat it as no insurance for billing purposes so
  // the invoice doesn't show a "Covered by …" section.
  const providerName = appt.insurance_providers?.name ?? null;
  const isSelfPay =
    !!providerName && /no\s*insurance|self[\s-]?pay/i.test(providerName);
  const packageRow = appt.patient_packages;

  return {
    data: {
      patientName: appt.patients?.full_name ?? "",
      patientId: appt.patient_id,
      hasInsurance: Boolean(appt.insurance_provider_id) && !isSelfPay,
      insuranceProviderName: isSelfPay ? null : providerName,
      accountBalance: balance,
      previousOutstandingBalance,
      departmentId: appt.department_id,
      departmentName: appt.departments?.name ?? null,
      departmentColor: appt.departments?.color ?? null,
      packageInfo: packageRow
        ? {
            name: packageRow.name,
            totalSessions: Number(packageRow.total_sessions),
            usedSessions: Number(packageRow.used_sessions),
            remainingSessions: Math.max(
              0,
              Number(packageRow.total_sessions) - Number(packageRow.used_sessions),
            ),
            sessionNumber: appt.package_session_number ?? null,
            pricePerSession:
              packageRow.price_per_session == null
                ? null
                : Number(packageRow.price_per_session),
          }
        : null,
      services,
    },
  };
}

/**
 * Returns whether a patient already has at least one active (non-cancelled,
 * non-no_show, non-deleted) appointment on the calendar day of scheduledAt.
 * Used by the booking form to show a soft warning before submitting.
 * Errors are treated as "no conflict" so they never block the booking flow.
 */
export async function checkSameDayPatient(
  patientId: string,
  scheduledAt: string,
): Promise<{ hasSameDay: boolean }> {
  try {
    const user = await requireRole(["admin", "receptionist"]);
    const supabase = await createClient();

    const date = new Date(scheduledAt);
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const { data, error } = await supabase
      .from("appointments")
      .select("id")
      .eq("patient_id", patientId)
      .eq("clinic_id", user.clinicId)
      .is("deleted_at", null)
      .not("status", "in", '("cancelled","no_show")')
      .gte("scheduled_at", dayStart.toISOString())
      .lte("scheduled_at", dayEnd.toISOString())
      .limit(1);

    if (error || !data) return { hasSameDay: false };
    return { hasSameDay: data.length > 0 };
  } catch {
    return { hasSameDay: false };
  }
}

// ── Conflict resolution ───────────────────────────────────────────────────────

export type ConflictingAppointment = {
  id: string;
  scheduled_at: string;
  duration_minutes: number;
  patients: { full_name: string } | null;
  departments: { name: string; color: string | null } | null;
  profiles: { full_name: string } | null;
};

/**
 * Returns pending appointments for the same doctor that overlap in time with
 * the given appointment. Used before confirming to detect scheduling conflicts.
 */
export async function getConflictingPendingAppointments(
  appointmentId: string,
): Promise<{ data?: ConflictingAppointment[]; error?: string }> {
  try {
    const user = await requireRole(["admin", "receptionist"]);
    const supabase = await createClient();

    // Fetch the target appointment
    const { data: target, error: targetErr } = await supabase
      .from("appointments")
      .select("doctor_id, scheduled_at, duration_minutes")
      .eq("id", appointmentId)
      .eq("clinic_id", user.clinicId)
      .single();

    if (targetErr || !target) return { error: await actionError("appointments.appointmentNotFound") };

    const targetStart = new Date(target.scheduled_at);
    const targetEnd = new Date(targetStart.getTime() + (target.duration_minutes ?? 30) * 60_000);

    // Fetch all pending appointments for the same doctor on the same date
    const dayStart = new Date(targetStart);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(targetStart);
    dayEnd.setHours(23, 59, 59, 999);

    const { data: candidates, error: candErr } = await supabase
      .from("appointments")
      .select(
        "id, scheduled_at, duration_minutes, patients(full_name), departments(name, color), profiles!doctor_id(full_name)",
      )
      .eq("clinic_id", user.clinicId)
      .eq("doctor_id", target.doctor_id)
      .eq("status", "pending")
      .neq("id", appointmentId)
      .is("deleted_at", null)
      .gte("scheduled_at", dayStart.toISOString())
      .lte("scheduled_at", dayEnd.toISOString());

    if (candErr) return { error: await actionError("appointments.failedToCheckForConflicts") };

    // Filter to true time overlaps in JS
    const conflicts = (candidates ?? []).filter((c) => {
      const cStart = new Date(c.scheduled_at);
      const cEnd = new Date(cStart.getTime() + (c.duration_minutes ?? 30) * 60_000);
      return cStart < targetEnd && cEnd > targetStart;
    });

    return { data: conflicts as unknown as ConflictingAppointment[] };
  } catch {
    return { error: await actionError("appointments.failedToCheckForConflicts") };
  }
}

/**
 * Confirms an appointment and displaces all listed conflicting pending
 * appointments (soft-deletes them and marks them as displaced so they appear
 * in the rebook queue instead of the recycle bin).
 */
export async function confirmAndDisplaceConflicts(
  appointmentId: string,
  conflictingIds: string[],
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const supabase = await createClient();

  // Confirm the target appointment
  const { error: confirmErr } = await supabase
    .from("appointments")
    .update({ status: "confirmed", updated_by: user.id })
    .eq("id", appointmentId)
    .eq("clinic_id", user.clinicId)
    .eq("status", "pending");

  if (confirmErr) {
    if (confirmErr.code === "check_violation" || confirmErr.message?.includes("transition")) {
      return { error: await actionError("appointments.cannotConfirmThisAppointment") };
    }
    return { error: await actionError("appointments.failedToConfirmAppointment") };
  }

  // Displace all conflicting pending appointments
  if (conflictingIds.length > 0) {
    const now = new Date().toISOString();
    const { error: displaceErr } = await supabase
      .from("appointments")
      .update({
        deleted_at: now,
        displaced_at: now,
        displaced_by: user.id,
      })
      .in("id", conflictingIds)
      .eq("clinic_id", user.clinicId)
      .eq("status", "pending");

    if (displaceErr) {
      return { error: await actionError("appointments.appointmentConfirmedButFailedToRemoveConflictingAppointments") };
    }
  }

  // §7.2a: notify the patient their appointment is confirmed. Best-effort.
  await notifyAppointmentEvent({
    clinicId: user.clinicId,
    appointmentId,
    event: "confirmed",
  });

  revalidatePath("/appointments");
  return { success: true };
}

/**
 * Permanently removes a displaced appointment from the rebook queue.
 */
export async function dismissDisplacedAppointment(id: string): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const { error } = await supabase
    .from("appointments")
    .delete()
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .not("displaced_at", "is", null);

  if (error) return { error: await actionError("appointments.failedToDismissAppointment") };

  revalidatePath("/appointments");
  return { success: true };
}
