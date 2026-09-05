import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { formatInTimeZone } from "date-fns-tz";
import { computeAvailableSlots } from "@/lib/booking/availability";
import { resolveClinicTimeZone } from "@/lib/ai/tools/context";
import { formatScheduledAt } from "@/lib/messaging/format";
import type { AuthedUser } from "@/lib/rbac";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/types/database";

export type PendingBookingInput = {
  patient_id: string;
  doctor_id: string;
  department_id?: string | null;
  scheduled_at: string;
  duration_minutes: number;
};

export type PendingBookingPreview = {
  patient_name: string;
  doctor_name: string;
  scheduled_at: string;
  scheduled_at_label: string;
  duration_minutes: number;
  status: "pending";
  patient_notification: "not_sent";
};

async function validatePendingBooking(
  supabase: SupabaseClient<Database>,
  user: AuthedUser,
  input: PendingBookingInput,
): Promise<PendingBookingPreview | null> {
  const scheduled = new Date(input.scheduled_at);
  if (!Number.isFinite(scheduled.getTime()) || scheduled.getTime() <= Date.now()) {
    return null;
  }
  const [patient, doctor, department] = await Promise.all([
    supabase
      .from("patients")
      .select("id, full_name")
      .eq("id", input.patient_id)
      .eq("clinic_id", user.clinicId)
      .eq("is_deleted", false)
      .maybeSingle(),
    supabase
      .from("profiles")
      .select("id, full_name, department_id")
      .eq("id", input.doctor_id)
      .eq("clinic_id", user.clinicId)
      .eq("role", "doctor")
      .eq("is_active", true)
      .eq("is_deleted", false)
      .is("deleted_at", null)
      .maybeSingle(),
    input.department_id
      ? supabase
          .from("departments")
          .select("id")
          .eq("id", input.department_id)
          .eq("clinic_id", user.clinicId)
          .eq("is_active", true)
          .is("deleted_at", null)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (
    patient.error ||
    doctor.error ||
    department.error ||
    !patient.data ||
    !doctor.data ||
    (input.department_id && !department.data) ||
    (input.department_id &&
      doctor.data.department_id &&
      doctor.data.department_id !== input.department_id)
  ) {
    return null;
  }

  const [timeZone, clinicFormat] = await Promise.all([
    resolveClinicTimeZone(supabase, user.clinicId),
    supabase
      .from("clinics")
      .select("locale, time_format, digits")
      .eq("id", user.clinicId)
      .maybeSingle(),
  ]);
  const dateIso = formatInTimeZone(scheduled, timeZone, "yyyy-MM-dd");
  const time = formatInTimeZone(scheduled, timeZone, "HH:mm");
  const slots = await computeAvailableSlots({
    supabase,
    clinicId: user.clinicId,
    doctorId: input.doctor_id,
    dateIso,
    timeZone,
  });
  const start = slots.findIndex((slot) => slot.time === time);
  const needed = Math.ceil(input.duration_minutes / 15);
  if (
    start < 0 ||
    slots.slice(start, start + needed).length !== needed ||
    slots.slice(start, start + needed).some((slot) => slot.disabled)
  ) {
    return null;
  }
  const formatted = formatScheduledAt(scheduled, {
    timezone: timeZone,
    locale: clinicFormat.data?.locale ?? "en",
    timeFormat: clinicFormat.data?.time_format ?? "24h",
    digits: clinicFormat.data?.digits ?? "latin",
  });
  return {
    patient_name: patient.data.full_name,
    doctor_name: doctor.data.full_name,
    scheduled_at: scheduled.toISOString(),
    scheduled_at_label: `${formatted.dateText} · ${formatted.timeText}`,
    duration_minutes: input.duration_minutes,
    status: "pending",
    patient_notification: "not_sent",
  };
}

export async function previewPendingBooking(input: {
  supabase: SupabaseClient<Database>;
  user: AuthedUser;
  booking: PendingBookingInput;
}): Promise<PendingBookingPreview | null> {
  return validatePendingBooking(input.supabase, input.user, input.booking);
}

/**
 * Phase 4 replacement for the retired workflow-run provenance path. The
 * action executor opens the receipt before calling this function; that receipt
 * is both the durable audit anchor and the idempotency key for the insert.
 */
export async function createPendingActionBooking(input: {
  supabase: SupabaseClient<Database>;
  user: AuthedUser;
  booking: PendingBookingInput;
  actionReceiptId: string;
}): Promise<
  | { ok: true; appointmentId: string; preview: PendingBookingPreview }
  | { ok: false; reason: "no_longer_available" | "patient_pending_cap" | "slot_pending_cap" | "create_failed" }
> {
  const preview = await validatePendingBooking(input.supabase, input.user, input.booking);
  if (!preview) return { ok: false, reason: "no_longer_available" };
  const session = await input.supabase.auth.getUser();
  if (session.error || session.data.user?.id !== input.user.id) return { ok: false, reason: "create_failed" };

  const writer = createClinicScopedAdminClient(input.user.clinicId);
  const receipt = await writer.from("ai_action_receipts")
    .select("id, clinic_id, actor_id, conversation_id, action_id, phase")
    .eq("id", input.actionReceiptId)
    .eq("clinic_id", input.user.clinicId)
    .eq("actor_id", input.user.id)
    .eq("action_id", "appointments.create_pending")
    .eq("phase", "execute")
    .maybeSingle();
  if (receipt.error || !receipt.data) return { ok: false, reason: "create_failed" };

  const existing = await writer.from("appointments").select("id")
    .eq("ai_action_receipt_id", input.actionReceiptId).maybeSingle();
  if (existing.error) return { ok: false, reason: "create_failed" };
  if (existing.data) return { ok: true, appointmentId: existing.data.id, preview };

  const inserted = await writer.from("appointments").insert({
    clinic_id: input.user.clinicId,
    patient_id: input.booking.patient_id,
    doctor_id: input.booking.doctor_id,
    department_id: input.booking.department_id ?? null,
    scheduled_at: preview.scheduled_at,
    duration_minutes: input.booking.duration_minutes,
    status: "pending",
    created_by: input.user.id,
    ai_action_receipt_id: input.actionReceiptId,
  }).select("id").single();
  if (inserted.error || !inserted.data) {
    const raced = await writer.from("appointments").select("id")
      .eq("ai_action_receipt_id", input.actionReceiptId).maybeSingle();
    if (raced.data) return { ok: true, appointmentId: raced.data.id, preview };
    if (inserted.error?.message.includes("AI_PENDING_PATIENT_CAP")) return { ok: false, reason: "patient_pending_cap" };
    if (inserted.error?.message.includes("AI_PENDING_SLOT_CAP")) return { ok: false, reason: "slot_pending_cap" };
    return { ok: false, reason: "create_failed" };
  }
  return { ok: true, appointmentId: inserted.data.id, preview };
}
