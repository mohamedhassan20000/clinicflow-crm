"use server";

import { actionError } from "@/lib/i18n/action-errors";
import { createClient } from "@/lib/supabase/server";
import { clinicalRecordIdSchema } from "@/lib/validations/clinical";
import { requireClinicalRead } from "@/actions/clinical/_shared";

/** Read-only compatibility helper; Phase 5 mutation bodies live in lib/clinical/mutations.ts. */
export async function getSickLeave(id: string) {
  const user = await requireClinicalRead();
  const parsed = clinicalRecordIdSchema.safeParse(id);
  if (!parsed.success)
    return { data: null, error: await actionError("clinical.invalidId") };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sick_leaves")
    .select("*")
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  return {
    data: data ?? null,
    error: error ? await actionError("clinical.readFailed") : null,
  };
}
