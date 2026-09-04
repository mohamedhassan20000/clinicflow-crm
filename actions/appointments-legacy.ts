"use server";

import { actionError } from "@/lib/i18n/action-errors";
import { revalidatePath } from "next/cache";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireMutationRole, requireRole, requireUser } from "@/lib/rbac";
import {
  replaceAppointmentSchema,
  type BillingValues,
} from "@/lib/validations/appointment";
import type { Database } from "@/types/database";
import { getPatientAccountBalance } from "@/actions/patients";
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";
import { computeAvailability, type AvailabilityResult } from "@/lib/booking/availability";
import {
  computeBillingUndoEligibility,
  type BillingUndoActivityEvent,
  type BillingUndoEligibility,
} from "@/lib/appointments/billing-undo";

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




/**
 * Dedicated Replace workflow: creates a linked replacement appointment at a new
 * time (and optionally a new doctor), marks the original `replaced`, and keeps
 * the original intact in history. The narrowly scoped, atomic
 * `replace_appointment` RPC re-derives the caller's clinic, role, and doctor
 * scope from auth state; no caller may point the replacement at an out-of-scope
 * doctor.
 */

export type ReplacementDoctorOption = {
  id: string;
  fullName: string;
};

export type ReplacementChainItem = {
  id: string;
  status: AppointmentStatus;
  scheduledAt: string;
  doctorId: string;
  doctorName: string | null;
  replacesAppointmentId: string | null;
  replacedByAppointmentId: string | null;
  chainPosition: number;
};

/**
 * Doctor choices for the Replace dialog. This is presentation data only; the
 * replace_appointment RPC independently re-derives and enforces the same scope.
 */
export async function getReplacementDoctorOptions(
  appointmentId: string,
): Promise<ActionResult & { data?: ReplacementDoctorOption[] }> {
  const user = await requireRole([
    "admin",
    "receptionist",
    "manager",
    "doctor",
    "assistant",
  ]);
  const parsedId = replaceAppointmentSchema.shape.original_id.safeParse(
    appointmentId,
  );
  if (!parsedId.success) {
    return { error: await actionError("appointments.validationError") };
  }

  const supabase = await createClient();
  const { data: original, error: originalError } = await supabase
    .from("appointments")
    .select("doctor_id")
    .eq("id", parsedId.data)
    .eq("clinic_id", user.clinicId)
    .is("deleted_at", null)
    .maybeSingle();
  if (originalError || !original) {
    return { error: await actionError("appointments.appointmentNotFound") };
  }

  let allowedDoctorIds: string[] | null = null;
  if (user.role === "doctor") {
    allowedDoctorIds = original.doctor_id === user.id ? [user.id] : [];
  } else if (user.role === "assistant") {
    const { data, error } = await supabase.rpc(
      "auth_supervised_doctor_ids",
    );
    if (error) {
      return { error: await actionError("appointments.failedToValidateDoctor") };
    }
    allowedDoctorIds = (data as string[] | null) ?? [];
  }

  if (allowedDoctorIds?.length === 0) {
    return { data: [] };
  }

  let doctorQuery = supabase
    .from("profiles")
    .select("id, full_name")
    .eq("clinic_id", user.clinicId)
    .eq("role", "doctor")
    .eq("is_active", true)
    .eq("is_deleted", false)
    .is("deleted_at", null)
    .order("full_name");
  if (allowedDoctorIds) {
    doctorQuery = doctorQuery.in("id", allowedDoctorIds);
  }
  const { data: doctors, error } = await doctorQuery;
  if (error) {
    return { error: await actionError("appointments.failedToValidateDoctor") };
  }

  return {
    data: (doctors ?? []).map((doctor) => ({
      id: doctor.id,
      fullName: doctor.full_name,
    })),
  };
}

/**
 * Presentation data for the Replace dialog's slot grid. The result comes from
 * the same calculator and uses the same original-appointment exclusion as the
 * final replace validation; the mutation remains the source of truth.
 */
export async function getReplacementAvailability(
  appointmentId: string,
  doctorId: string,
  dateIso: string,
  durationMinutes: number,
): Promise<ActionResult & { data?: AvailabilityResult }> {
  const user = await requireRole([
    "admin",
    "receptionist",
    "manager",
    "doctor",
    "assistant",
  ]);
  const parsedAppointmentId = replaceAppointmentSchema.shape.original_id.safeParse(appointmentId);
  const parsedDoctorId = replaceAppointmentSchema.shape.doctor_id.safeParse(doctorId);
  if (
    !parsedAppointmentId.success ||
    !parsedDoctorId.success ||
    !/^\d{4}-\d{2}-\d{2}$/.test(dateIso) ||
    !Number.isInteger(durationMinutes) ||
    durationMinutes <= 0
  ) {
    return { error: await actionError("appointments.validationError") };
  }

  const doctorResult = await getReplacementDoctorOptions(parsedAppointmentId.data);
  if (
    doctorResult.error ||
    !doctorResult.data?.some((doctor) => doctor.id === parsedDoctorId.data)
  ) {
    return {
      error: doctorResult.error ?? await actionError("appointments.failedToValidateDoctor"),
    };
  }

  const supabase = await createClient();
  const timeZone = await getClinicTimeZone(user.clinicId);
  const data = await computeAvailability({
    supabase,
    clinicId: user.clinicId,
    doctorId: parsedDoctorId.data,
    dateIso,
    timeZone,
    durationMinutes,
    excludeAppointmentId: parsedAppointmentId.data,
  });
  return { data };
}

/** Ordered original -> ... -> active replacement history, still RLS-scoped. */
export async function getAppointmentReplacementChain(
  appointmentId: string,
): Promise<ActionResult & { data?: ReplacementChainItem[] }> {
  await requireRole([
    "admin",
    "receptionist",
    "manager",
    "doctor",
    "assistant",
  ]);
  const parsedId = replaceAppointmentSchema.shape.original_id.safeParse(
    appointmentId,
  );
  if (!parsedId.success) {
    return { error: await actionError("appointments.validationError") };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc(
    "get_appointment_replacement_chain",
    { p_appointment_id: parsedId.data },
  );
  if (error) {
    return {
      error: await actionError(
        "appointments.failedToLoadReplacementHistory",
      ),
    };
  }

  return {
    data: (data ?? []).map((item) => ({
      id: item.id,
      status: item.status,
      scheduledAt: item.scheduled_at,
      doctorId: item.doctor_id,
      doctorName: item.doctor_name,
      replacesAppointmentId: item.replaces_appointment_id,
      replacedByAppointmentId: item.replaced_by_appointment_id,
      chainPosition: item.chain_position,
    })),
  };
}

export type BillingInput = BillingValues;









const BILLING_UNDO_ACTIVITY_ACTIONS = [
  "appointment.completed",
  "appointment.billing_completion_undone",
] as const;

type AppointmentsSupabaseClient = Awaited<ReturnType<typeof createClient>>;

async function loadInvoiceUndoEligibility({
  id,
  user,
  supabase,
  now,
}: {
  id: string;
  user: Awaited<ReturnType<typeof requireUser>>;
  supabase: AppointmentsSupabaseClient;
  now?: Date;
}): Promise<
  BillingUndoEligibility & {
    patientId: string | null;
  }
> {
  if (
    user.role !== "admin" &&
    user.role !== "receptionist" &&
    user.role !== "manager"
  ) {
    return {
      ...computeBillingUndoEligibility({
        currentStatus: "completed",
        role: user.role,
        latestBillingEvent: null,
        now,
      }),
      patientId: null,
    };
  }

  const [appointmentResult, activityResult] = await Promise.all([
    supabase
      .from("appointments")
      .select("patient_id, status")
      .eq("id", id)
      .eq("clinic_id", user.clinicId)
      .maybeSingle(),
    supabase
      .from("activity_events")
      .select("id, action, occurred_at, previous_state")
      .eq("clinic_id", user.clinicId)
      .eq("entity_type", "appointment")
      .eq("entity_id", id)
      .in("action", [...BILLING_UNDO_ACTIVITY_ACTIONS])
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (appointmentResult.error) {
    console.error("appointment_billing_undo_appointment_read_failed", {
      appointmentId: id,
      clinicId: user.clinicId,
      code: appointmentResult.error.code,
      message: appointmentResult.error.message,
      details: appointmentResult.error.details,
      hint: appointmentResult.error.hint,
    });
  }
  if (activityResult.error) {
    console.error("appointment_billing_undo_activity_read_failed", {
      appointmentId: id,
      clinicId: user.clinicId,
      code: activityResult.error.code,
      message: activityResult.error.message,
      details: activityResult.error.details,
      hint: activityResult.error.hint,
    });
    return {
      canUndo: false,
      reason: "activity_unavailable",
      targetStatus: null,
      completionEventId: null,
      completionOccurredAt: null,
      expiresAt: null,
      patientId: appointmentResult.data?.patient_id ?? null,
    };
  }

  const latestBillingEvent =
    (activityResult.data as BillingUndoActivityEvent | null) ?? null;
  return {
    ...computeBillingUndoEligibility({
      currentStatus: appointmentResult.data?.status ?? null,
      role: user.role,
      latestBillingEvent,
      now,
    }),
    patientId: appointmentResult.data?.patient_id ?? null,
  };
}

export async function getInvoiceUndoEligibility(
  id: string,
): Promise<BillingUndoEligibility> {
  const user = await requireUser();
  const supabase = await createClient();
  const eligibility = await loadInvoiceUndoEligibility({
    id,
    user,
    supabase,
  });
  return {
    canUndo: eligibility.canUndo,
    reason: eligibility.reason,
    targetStatus: eligibility.targetStatus,
    completionEventId: eligibility.completionEventId,
    completionOccurredAt: eligibility.completionOccurredAt,
    expiresAt: eligibility.expiresAt,
  };
}


export type UndoInvoiceCompletionResult = ActionResult & {
  eligibility?: BillingUndoEligibility;
  targetStatus?: InvoiceUndoStatus;
  rpc?: string;
};


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


export async function emptyAppointmentsTrash(): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist", "manager"]);
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
  const user = await requireRole(["admin", "receptionist", "manager"]);
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
    const user = await requireRole(["admin", "receptionist", "manager", "assistant"]);
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
      .not("status", "in", '("cancelled","no_show","replaced")')
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
    const user = await requireRole(["admin", "receptionist", "manager", "assistant"]);
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

/**
 * Permanently removes a displaced appointment from the rebook queue.
 */
