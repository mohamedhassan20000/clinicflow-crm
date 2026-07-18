import "server-only";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";
import type { AuthedUser } from "@/lib/rbac";
import type { PromptLocale } from "@/lib/ai/prompts/doctor";
import type { Database } from "@/types/database";

/**
 * Server-resolved context every doctor tool closes over. Identity is captured
 * from the authorized session at the surface boundary (never from the model),
 * so a tool's clinic and actor cannot be influenced by prompt content (§9.1).
 */
export type DoctorToolContext = {
  user: AuthedUser;
  locale: PromptLocale;
  /**
   * Optional patient the staff member opened the assistant on (the patient-
   * profile launcher, §6.2). Advisory only — the get_patient_summary tool still
   * takes an explicit patient_id and RLS still scopes every read.
   */
  patientId?: string | null;
};

/** ISO calendar date, e.g. "2026-07-18". */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function resolveClinicTimeZone(
  supabase: SupabaseClient<Database>,
  clinicId: string,
): Promise<string> {
  const { data: clinic } = await supabase
    .from("clinics")
    .select("timezone")
    .eq("id", clinicId)
    .maybeSingle();
  return typeof clinic?.timezone === "string" && clinic.timezone
    ? clinic.timezone
    : DEFAULT_TIME_ZONE;
}

export function clinicDateRangeToUtc(
  from: string,
  to: string,
  timeZone: string,
): { start: string; end: string } {
  return {
    start: fromZonedTime(`${from}T00:00:00.000`, timeZone).toISOString(),
    end: fromZonedTime(`${to}T23:59:59.999`, timeZone).toISOString(),
  };
}

export function omitElapsedClinicSlots(
  dateIso: string,
  slots: string[],
  timeZone: string,
  now = new Date(),
): string[] {
  const today = formatInTimeZone(now, timeZone, "yyyy-MM-dd");
  if (dateIso < today) return [];
  if (dateIso > today) return slots;

  return slots.filter(
    (time) => fromZonedTime(`${dateIso}T${time}:00`, timeZone).getTime() > now.getTime(),
  );
}
