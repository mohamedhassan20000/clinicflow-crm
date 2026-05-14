"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
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

export type ActionResult = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  success?: boolean;
};
type AppointmentStatus = Database["public"]["Enums"]["appointment_status"];
export type InvoiceUndoStatus = Extract<AppointmentStatus, "pending" | "confirmed">;
type AppointmentValues = AppointmentFormValues;

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

  if (patientResult.error) return { error: "Failed to validate patient." };
  if (doctorResult.error) return { error: "Failed to validate doctor." };
  if (departmentResult.error) return { error: "Failed to validate department." };
  if (insuranceResult.error) return { error: "Failed to validate insurance provider." };
  if (!patientResult.data) return { error: "Select an active patient in this clinic." };
  if (!doctorResult.data) return { error: "Select an active doctor in this clinic." };
  if (values.department_id && !departmentResult.data) {
    return { error: "Select an active department in this clinic." };
  }
  if (values.insurance_provider_id && !insuranceResult.data) {
    return { error: "Select an active insurance provider in this clinic." };
  }
  if (
    values.department_id &&
    doctorResult.data.department_id &&
    doctorResult.data.department_id !== values.department_id
  ) {
    return { error: "Selected doctor does not belong to the selected department." };
  }

  return {};
}

async function validateAppointmentSlot(
  values: AppointmentValues,
  clinicId: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const startTime = new Date(values.scheduled_at);
  const endTime = new Date(startTime.getTime() + values.duration_minutes * 60_000);
  const dayStart = new Date(startTime);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(startTime);
  dayEnd.setHours(23, 59, 59, 999);

  const { data: sameDay, error } = await supabase
    .from("appointments")
    .select("scheduled_at, duration_minutes")
    .eq("doctor_id", values.doctor_id)
    .eq("clinic_id", clinicId)
    .is("deleted_at", null)
    .eq("status", "confirmed")
    .gte("scheduled_at", dayStart.toISOString())
    .lte("scheduled_at", dayEnd.toISOString());

  if (error) {
    return {
      error:
        "Could not verify the doctor's availability. Please try again before booking.",
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
          "This doctor is already booked during the selected session time. Please choose a different time slot.",
      };
    }
    if (
      startTime < new Date(exEnd.getTime() + BUFFER_MS) &&
      endTime > new Date(exStart.getTime() - BUFFER_MS)
    ) {
      return {
        error:
          "This doctor needs a 15-minute recovery/buffer window between appointments. Please choose a different time slot.",
      };
    }
  }

  return {};
}

export async function createAppointment(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "receptionist"]);

  const durationRaw = formData.get("duration_minutes");
  const raw = {
    patient_id: formData.get("patient_id"),
    doctor_id: formData.get("doctor_id"),
    department_id: formData.get("department_id") || null,
    scheduled_at: formData.get("scheduled_at"),
    duration_minutes: durationRaw ? Number(durationRaw) : 30,
    insurance_provider_id: formData.get("insurance_provider_id") || null,
    notes: formData.get("notes") || null,
  };

  const parsed = appointmentSchema.safeParse(raw);
  if (!parsed.success) {
    const flat = parsed.error.flatten().fieldErrors;
    const first = Object.values(flat).flat()[0];
    return { error: first ?? "Please fill every required field.", fieldErrors: flat };
  }

  if (isPastScheduledAt(parsed.data.scheduled_at)) {
    return { error: "Choose a future date and time for the appointment." };
  }

  const references = await validateAppointmentReferences(
    parsed.data,
    user.clinicId,
  );
  if (references.error) return references;

  const slot = await validateAppointmentSlot(parsed.data, user.clinicId);
  if (slot.error) return slot;

  const supabase = await createClient();
  const { error } = await supabase.from("appointments").insert({
    ...parsed.data,
    clinic_id: user.clinicId,
    created_by: user.id,
  });

  if (error) {
    if (error.code === "23505") {
      const msg = error.message ?? "";
      if (msg.includes("appointments_patient_active_slot_key")) {
        return {
          error:
            "This patient already has another appointment at the same time. Pick a different slot.",
        };
      }
      return {
        error:
          "This doctor already has an appointment at that time. Please choose a different slot.",
      };
    }
    return { error: error.message || "Failed to create appointment. Please try again." };
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
  const user = await requireRole(["admin", "receptionist"]);

  const supabase = await createClient();

  const { data: appt } = await supabase
    .from("appointments")
    .select("status, patient_id")
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .single();

  if (!appt) return { error: "Appointment not found." };

  const allowed = STATUS_TRANSITIONS[appt.status] ?? [];
  const completingWithInvoice = newStatus === "completed" && !!billingPayload;
  if (!completingWithInvoice && !allowed.includes(newStatus)) {
    return { error: `Cannot transition from ${appt.status} to ${newStatus}.` };
  }
  if (
    completingWithInvoice &&
    appt.status !== "pending" &&
    appt.status !== "confirmed"
  ) {
    return { error: `Cannot transition from ${appt.status} to ${newStatus}.` };
  }

  const update: TablesUpdate<"appointments"> = {
    status: newStatus as TablesUpdate<"appointments">["status"],
    updated_by: user.id,
  };

  if (newStatus === "cancelled") {
    const reason = (cancellationReason ?? "").trim();
    if (!reason) {
      return { error: "Please provide a reason for cancelling this appointment." };
    }
    if (reason.length > 500) {
      return { error: "Cancellation reason must be 500 characters or less." };
    }
    update.cancellation_reason = reason;
    update.cancelled_at = new Date().toISOString();
    update.cancelled_by = user.id;
  }

  if (newStatus === "no_show") {
    const reason = (noShowReason ?? "").trim();
    if (!reason) {
      return {
        error: "Please provide a reason for marking this appointment as a no-show.",
      };
    }
    if (reason.length > 500) {
      return { error: "No-show reason must be 500 characters or less." };
    }
    update.no_show_reason = reason;
    update.no_showed_at = new Date().toISOString();
    update.no_showed_by = user.id;
  }

  if (newStatus === "completed") {
    if (!billingPayload) {
      return { error: "Billing details are required to complete this appointment." };
    }

    const parsed = billingSchema.safeParse(billingPayload);
    if (!parsed.success) {
      const flat = parsed.error.flatten().fieldErrors;
      const first = Object.values(flat).flat()[0];
      return { error: first ?? "Invalid billing details.", fieldErrors: flat };
    }
    const billing = parsed.data;

    const total = lineItemTotal(billing.line_items);
    if (total <= 0) {
      return { error: "Invoice total must be greater than zero." };
    }

    // Validate deposit_amount against patient's available balance
    if (billing.deposit_amount > 0) {
      const balance = await getPatientAccountBalance(
        appt.patient_id,
        user.clinicId,
      );
      if (billing.deposit_amount > balance + 0.001) {
        return {
          error: `Deposit applied (${billing.deposit_amount.toFixed(
            2,
          )}) exceeds patient's account balance (${balance.toFixed(2)}).`,
        };
      }
      if (billing.deposit_amount > total + 0.001) {
        return { error: "Deposit applied cannot exceed invoice total." };
      }
    }

    const collected =
      billing.paid_amount +
      billing.insurance_amount +
      billing.secondary_amount +
      billing.deposit_amount;
    if (collected > total + 0.001) {
      return { error: "Collected amount exceeds invoice total." };
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

    if (error) return { error: error.message };
    revalidatePath("/appointments");
    revalidatePath(`/patients/${appt.patient_id}`);
    return {};
  }

  const { error } = await supabase
    .from("appointments")
    .update(update)
    .eq("id", id)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: "Failed to update status." };

  revalidatePath("/appointments");
  revalidatePath(`/patients/${appt.patient_id}`);
  return {};
}

export async function softDeleteAppointment(id: string): Promise<ActionResult> {
  const user = await requireRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const { data: appt, error: fetchError } = await supabase
    .from("appointments")
    .select("status, paid_at, paid_amount, total_amount")
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .single();

  if (fetchError || !appt) return { error: "Appointment not found." };

  if (
    appt.status === "completed" ||
    appt.paid_at !== null ||
    (appt.paid_amount !== null && appt.paid_amount > 0) ||
    (appt.total_amount !== null && appt.total_amount > 0)
  ) {
    return {
      error:
        "Completed or charged appointments cannot be deleted. Please use the billing undo option immediately after charging if you need to correct the invoice.",
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
  if (error) return { error: error.message };
  revalidatePath("/appointments");
  return {};
}

export async function restoreAppointment(id: string): Promise<ActionResult> {
  const user = await requireRole(["admin", "receptionist"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("appointments")
    .update({ deleted_at: null })
    .eq("id", id)
    .eq("clinic_id", user.clinicId);
  if (error) return { error: error.message };
  revalidatePath("/appointments");
  return {};
}

async function deleteAppointmentDependents(
  appointmentId: string,
  clinicId: string,
): Promise<ActionResult> {
  const adminClient = createAdminClient();
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
  if (failed?.error) return { error: failed.error.message };
  return {};
}

export async function undoAppointmentStatus(
  id: string,
  targetStatus: "pending" | "confirmed",
): Promise<ActionResult> {
  const user = await requireRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const { data: appt } = await supabase
    .from("appointments")
    .select("patient_id")
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .single();

  if (!appt) return { error: "Appointment not found." };

  const { error } = await supabase.rpc("undo_appointment_status", {
    p_appointment_id: id,
    p_target_status: targetStatus,
  });

  if (error) return { error: error.message };

  revalidatePath("/appointments");
  revalidatePath(`/patients/${appt.patient_id}`);
  return {};
}

export async function undoInvoiceCompletion(
  id: string,
  targetStatus: InvoiceUndoStatus,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const { data: appt } = await supabase
    .from("appointments")
    .select("patient_id")
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .single();

  if (!appt) return { error: "Appointment not found." };

  const { data: provenanceRows, error: provenanceError } = await supabase
    .from("outstanding_settlements")
    .select("id")
    .eq("clinic_id", user.clinicId)
    .eq("source_appointment_id", id)
    .limit(1);

  if (provenanceError) return { error: provenanceError.message };

  const undoRpc =
    (provenanceRows?.length ?? 0) > 0
      ? "undo_appointment_billing_with_previous_settlement"
      : "undo_appointment_billing";

  const { error } = await supabase.rpc(undoRpc, {
    p_appointment_id: id,
    p_target_status: targetStatus,
  });

  if (error) return { error: error.message };

  revalidatePath("/appointments");
  revalidatePath(`/patients/${appt.patient_id}`);
  return {};
}

export async function permanentDeleteAppointment(id: string): Promise<ActionResult> {
  const user = await requireRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const cascaded = await deleteAppointmentDependents(id, user.clinicId);
  if (cascaded.error) return cascaded;

  const { error } = await supabase
    .from("appointments")
    .delete()
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .not("deleted_at", "is", null);

  if (error) return { error: error.message };

  revalidatePath("/appointments");
  return { success: true };
}

export async function emptyAppointmentsTrash(): Promise<ActionResult> {
  const user = await requireRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const { data: trashedAppointments, error: selectError } = await supabase
    .from("appointments")
    .select("id")
    .eq("clinic_id", user.clinicId)
    .not("deleted_at", "is", null);

  if (selectError) return { error: selectError.message };

  const ids = (trashedAppointments ?? []).map((appointment) => appointment.id);
  if (ids.length === 0) return { success: true };

  const adminClient = createAdminClient();

  const { error: servicesError } = await adminClient
    .from("appointment_services")
    .delete()
    .in("appointment_id", ids)
    .eq("clinic_id", user.clinicId);
  if (servicesError) return { error: servicesError.message };

  const { error: feedbackError } = await adminClient
    .from("feedback")
    .delete()
    .in("appointment_id", ids);
  if (feedbackError) return { error: feedbackError.message };

  const { error: followUpsError } = await adminClient
    .from("follow_ups")
    .delete()
    .in("appointment_id", ids)
    .eq("clinic_id", user.clinicId);
  if (followUpsError) return { error: followUpsError.message };

  const { error: settlementsError } = await adminClient
    .from("outstanding_settlements")
    .delete()
    .in("appointment_id", ids)
    .eq("clinic_id", user.clinicId);
  if (settlementsError) return { error: settlementsError.message };

  const { error } = await supabase
    .from("appointments")
    .delete()
    .eq("clinic_id", user.clinicId)
    .in("id", ids)
    .not("deleted_at", "is", null);

  if (error) return { error: error.message };

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
      "id, patient_id, department_id, insurance_provider_id, patients(full_name), departments(name, color), insurance_providers(name)",
    )
    .eq("id", appointmentId)
    .eq("clinic_id", user.clinicId)
    .single();

  if (apptError || !appt) return { error: "Appointment not found." };

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

    if (targetErr || !target) return { error: "Appointment not found." };

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

    if (candErr) return { error: "Failed to check for conflicts." };

    // Filter to true time overlaps in JS
    const conflicts = (candidates ?? []).filter((c) => {
      const cStart = new Date(c.scheduled_at);
      const cEnd = new Date(cStart.getTime() + (c.duration_minutes ?? 30) * 60_000);
      return cStart < targetEnd && cEnd > targetStart;
    });

    return { data: conflicts as unknown as ConflictingAppointment[] };
  } catch {
    return { error: "Failed to check for conflicts." };
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
  const user = await requireRole(["admin", "receptionist"]);
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
      return { error: "Cannot confirm this appointment." };
    }
    return { error: confirmErr.message || "Failed to confirm appointment." };
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
      return { error: "Appointment confirmed, but failed to remove conflicting appointments." };
    }
  }

  revalidatePath("/appointments");
  return { success: true };
}

/**
 * Permanently removes a displaced appointment from the rebook queue.
 */
export async function dismissDisplacedAppointment(id: string): Promise<ActionResult> {
  const user = await requireRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const { error } = await supabase
    .from("appointments")
    .delete()
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .not("displaced_at", "is", null);

  if (error) return { error: error.message || "Failed to dismiss appointment." };

  revalidatePath("/appointments");
  return { success: true };
}
