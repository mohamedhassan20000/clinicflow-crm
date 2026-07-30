"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";
import { computeAvailability } from "@/lib/booking/availability";
import type { AvailabilityResult } from "@/lib/booking/availability";

export async function getAvailableTimeSlots(
  doctorId: string | null,
  dateIso: string, // "YYYY-MM-DD"
  durationMinutes = 30,
): Promise<AvailabilityResult> {
  // Keep this read boundary aligned with the page and create action. Assistant
  // doctor scope is checked below and remains independently enforced by RLS.
  const user = await requireRole([
    "admin",
    "receptionist",
    "manager",
    "assistant",
  ]);
  const supabase = await createClient();

  if (user.role === "assistant" && doctorId) {
    const { data: supervised, error: scopeError } = await supabase.rpc(
      "auth_supervised_doctor_ids",
    );
    if (
      scopeError ||
      !(supervised ?? []).includes(doctorId)
    ) {
      return {
        slots: [],
        reason: scopeError ? "unable_to_calculate" : "doctor_not_found",
        dateIso,
        dayOfWeek: new Date(`${dateIso}T12:00:00`).getDay(),
        workingHours: [],
      };
    }
  }

  const { data: clinic } = await supabase
    .from("clinics")
    .select("timezone")
    .eq("id", user.clinicId)
    .maybeSingle();
  const timeZone =
    typeof clinic?.timezone === "string" && clinic.timezone
      ? clinic.timezone
      : DEFAULT_TIME_ZONE;

  return computeAvailability({
    supabase,
    clinicId: user.clinicId,
    doctorId,
    dateIso,
    timeZone,
    durationMinutes,
  });
}
