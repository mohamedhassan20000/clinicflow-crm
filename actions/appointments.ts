"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireRole, requireUser } from "@/lib/rbac";
import { appointmentSchema } from "@/lib/validations/appointment";
import { STATUS_TRANSITIONS } from "@/lib/validations/appointment";

export type ActionResult = { error?: string; fieldErrors?: Record<string, string[]> };

export async function createAppointment(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "receptionist"]);

  const raw = {
    patient_id: formData.get("patient_id"),
    doctor_id: formData.get("doctor_id"),
    department_id: formData.get("department_id") || null,
    scheduled_at: formData.get("scheduled_at"),
    duration_minutes: formData.get("duration_minutes") ?? 30,
    insurance_provider_id: formData.get("insurance_provider_id") || null,
    notes: formData.get("notes") || null,
  };

  const parsed = appointmentSchema.safeParse(raw);
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("appointments").insert({
    ...parsed.data,
    clinic_id: user.clinicId,
    created_by: user.id,
  });

  if (error) {
    if (error.code === "23505") {
      return {
        error:
          "This doctor already has an appointment at that time. Please choose a different slot.",
      };
    }
    return { error: "Failed to create appointment. Please try again." };
  }

  revalidatePath("/appointments");
  redirect("/appointments");
}

export async function updateAppointmentStatus(
  id: string,
  newStatus: string,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "receptionist"]);

  const supabase = await createClient();

  // Verify the transition is valid
  const { data: appt } = await supabase
    .from("appointments")
    .select("status")
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .single();

  if (!appt) return { error: "Appointment not found." };

  const allowed = STATUS_TRANSITIONS[appt.status] ?? [];
  if (!allowed.includes(newStatus)) {
    return { error: `Cannot transition from ${appt.status} to ${newStatus}.` };
  }

  const { error } = await supabase
    .from("appointments")
    .update({ status: newStatus as never, updated_by: user.id })
    .eq("id", id)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: "Failed to update status." };

  revalidatePath("/appointments");
  return {};
}

export async function cancelAppointment(id: string): Promise<ActionResult> {
  return updateAppointmentStatus(id, "cancelled");
}
