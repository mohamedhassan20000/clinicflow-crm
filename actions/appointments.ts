"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireUser } from "@/lib/rbac";
import {
  appointmentSchema,
  billingSchema,
  STATUS_TRANSITIONS,
  type BillingValues,
  type LineItemValues,
} from "@/lib/validations/appointment";
import type { TablesUpdate } from "@/types/database";
import { getPatientAccountBalance } from "@/actions/patients";

export type ActionResult = { error?: string; fieldErrors?: Record<string, string[]> };

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
  if (!allowed.includes(newStatus)) {
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
    const outstanding = Number(Math.max(0, total - collected).toFixed(2));

    update.payment_method = billing.payment_method;
    update.secondary_payment_method = billing.secondary_payment_method ?? null;
    update.secondary_amount = Number(billing.secondary_amount.toFixed(2));
    update.deposit_amount = Number(billing.deposit_amount.toFixed(2));
    update.total_amount = total;
    update.paid_amount = Number(billing.paid_amount.toFixed(2));
    update.insurance_amount = Number(billing.insurance_amount.toFixed(2));
    update.outstanding_amount = outstanding;
    update.payment_note = billing.payment_note ?? null;
    update.paid_at = new Date().toISOString();

    // Replace any existing line items, then insert fresh ones
    await supabase
      .from("appointment_services")
      .delete()
      .eq("appointment_id", id)
      .eq("clinic_id", user.clinicId);

    const rows = billing.line_items.map((li) => ({
      appointment_id: id,
      clinic_id: user.clinicId,
      service_id: li.service_id ?? null,
      name: li.name,
      price: Number(Number(li.price).toFixed(2)),
      quantity: Number(li.quantity),
    }));
    const { error: linesError } = await supabase
      .from("appointment_services")
      .insert(rows);
    if (linesError) {
      return { error: "Failed to save invoice line items." };
    }
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

export async function cancelAppointment(
  id: string,
  reason: string,
): Promise<ActionResult> {
  return updateAppointmentStatus(id, "cancelled", null, reason);
}

export interface BillingContext {
  patientName: string;
  hasInsurance: boolean;
  insuranceProviderName: string | null;
  accountBalance: number;
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

  const balance = await getPatientAccountBalance(
    appt.patient_id,
    user.clinicId,
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
      hasInsurance: Boolean(appt.insurance_provider_id) && !isSelfPay,
      insuranceProviderName: isSelfPay ? null : providerName,
      accountBalance: balance,
      departmentId: appt.department_id,
      departmentName: appt.departments?.name ?? null,
      departmentColor: appt.departments?.color ?? null,
      services,
    },
  };
}
