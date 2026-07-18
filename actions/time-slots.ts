"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";
import { computeAvailableSlots, type SlotInfo } from "@/lib/booking/availability";

export type { SlotInfo };

export async function getAvailableTimeSlots(
  doctorId: string | null,
  dateIso: string, // "YYYY-MM-DD"
): Promise<{ slots: SlotInfo[]; error?: string }> {
  const user = await requireRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const { data: clinic } = await supabase
    .from("clinics")
    .select("timezone")
    .eq("id", user.clinicId)
    .maybeSingle();
  const timeZone =
    typeof clinic?.timezone === "string" && clinic.timezone
      ? clinic.timezone
      : DEFAULT_TIME_ZONE;

  const slots = await computeAvailableSlots({
    supabase,
    clinicId: user.clinicId,
    doctorId,
    dateIso,
    timeZone,
  });

  return { slots };
}
