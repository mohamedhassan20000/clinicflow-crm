"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireUser } from "@/lib/rbac";
import { appointmentSchema } from "@/lib/validations/appointment";
import { STATUS_TRANSITIONS } from "@/lib/validations/appointment";
import type { TablesUpdate } from "@/types/database";

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

const PAYMENT_METHODS = [
  "cash",
  "credit_card",
  "paypal",
  "bank_transfer",
  "insurance",
] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface BillingInput {
  total_amount: number;
  paid_amount: number;
  payment_method: PaymentMethod;
  insurance_amount: number;
  outstanding_amount: number;
  secondary_payment_method: PaymentMethod | null;
  secondary_amount: number;
  deposit_amount: number;
  payment_note: string | null;
}

export async function updateAppointmentStatus(
  id: string,
  newStatus: string,
  paymentMethodOrBilling?: string | BillingInput | null,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "receptionist"]);

  const supabase = await createClient();

  // Verify the transition is valid
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

  // Completing an appointment requires a payment method
  const update: TablesUpdate<"appointments"> = {
    status: newStatus as TablesUpdate<"appointments">["status"],
    updated_by: user.id,
  };

  if (newStatus === "completed") {
    const billing =
      typeof paymentMethodOrBilling === "object" && paymentMethodOrBilling
        ? paymentMethodOrBilling
        : null;

    if (billing) {
      if (!PAYMENT_METHODS.includes(billing.payment_method)) {
        return { error: "Invalid primary payment method." };
      }
      if (
        billing.secondary_payment_method &&
        !PAYMENT_METHODS.includes(billing.secondary_payment_method)
      ) {
        return { error: "Invalid secondary payment method." };
      }
      if (billing.total_amount <= 0) {
        return { error: "Total amount must be greater than zero." };
      }
      if (
        billing.paid_amount < 0 ||
        billing.insurance_amount < 0 ||
        billing.outstanding_amount < 0 ||
        billing.secondary_amount < 0 ||
        billing.deposit_amount < 0
      ) {
        return { error: "Amounts cannot be negative." };
      }
      update.payment_method = billing.payment_method;
      update.secondary_payment_method = billing.secondary_payment_method;
      update.secondary_amount = billing.secondary_amount;
      update.deposit_amount = billing.deposit_amount;
      update.total_amount = billing.total_amount;
      update.paid_amount = billing.paid_amount;
      update.insurance_amount = billing.insurance_amount;
      update.outstanding_amount = billing.outstanding_amount;
      update.payment_note = billing.payment_note;
      update.paid_at = new Date().toISOString();
    } else {
      const pm = paymentMethodOrBilling as string | null | undefined;
      if (!pm || !PAYMENT_METHODS.includes(pm as PaymentMethod)) {
        return { error: "Select a valid payment method to complete this appointment." };
      }
      update.payment_method = pm as PaymentMethod;
      update.paid_at = new Date().toISOString();
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

export async function cancelAppointment(id: string): Promise<ActionResult> {
  return updateAppointmentStatus(id, "cancelled");
}
