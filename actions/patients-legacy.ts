"use server";

import { revalidatePath } from "next/cache";
import { actionError } from "@/lib/i18n/action-errors";
import { requireMutationRole, requireRole } from "@/lib/rbac";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type PatientStub = {
  id: string;
  full_name: string;
  file_number: string;
  national_id: string;
  phone: string;
  department_id: string | null;
  deleted_at: string | null;
  archived_at: string | null;
  departments: { id: string; name: string; color: string | null } | null;
};

/** Read/bulk compatibility helpers; Phase 5 single-record mutations live in lib/patients/mutations.ts. */
export async function getTrashPatients(): Promise<{
  data?: PatientStub[];
  error?: string;
}> {
  const user = await requireRole(["admin", "receptionist"]);
  const admin = createClinicScopedAdminClient(user.clinicId);
  const { data, error } = await admin
    .from("patients")
    .select("id, full_name, file_number, national_id, phone, department_id, deleted_at, archived_at, departments(id, name, color)")
    .eq("clinic_id", user.clinicId)
    .eq("is_deleted", true)
    .eq("is_archived", false)
    .order("deleted_at", { ascending: false });
  if (error) return { error: await actionError("patients.failedToLoadTrash") };
  return { data: (data ?? []) as PatientStub[] };
}

export async function getArchivePatients(): Promise<{
  data?: PatientStub[];
  error?: string;
}> {
  const user = await requireRole(["admin", "receptionist"]);
  const admin = createClinicScopedAdminClient(user.clinicId);
  const { data, error } = await admin
    .from("patients")
    .select("id, full_name, file_number, national_id, phone, department_id, deleted_at, archived_at, departments(id, name, color)")
    .eq("clinic_id", user.clinicId)
    .eq("is_archived", true)
    .order("archived_at", { ascending: false });
  if (error) return { error: await actionError("patients.failedToLoadArchive") };
  return { data: (data ?? []) as PatientStub[] };
}

export async function archiveAllTrashPatients(
  olderThanDays?: number,
): Promise<{ error?: string; success?: boolean }> {
  const user = await requireMutationRole("admin");
  const admin = createClinicScopedAdminClient(user.clinicId);
  let query = admin
    .from("patients")
    .update({
      is_archived: true,
      archived_at: new Date().toISOString(),
      updated_by: user.id,
    })
    .eq("clinic_id", user.clinicId)
    .eq("is_deleted", true)
    .eq("is_archived", false);
  if (olderThanDays != null) {
    query = query.lt(
      "deleted_at",
      new Date(Date.now() - olderThanDays * 86_400_000).toISOString(),
    );
  }
  const { error } = await query;
  if (error)
    return { error: await actionError("patients.failedToArchivePatients") };
  revalidatePath("/patients/trash");
  revalidatePath("/patients/archive");
  return { success: true };
}

export async function getPatientAccountBalance(
  patientId: string,
  clinicId: string,
): Promise<number> {
  const supabase = await createClient();
  const [{ data: deposits }, { data: appointments }] = await Promise.all([
    supabase.from("patient_deposits").select("amount").eq("patient_id", patientId).eq("clinic_id", clinicId),
    supabase.from("appointments").select("deposit_amount").eq("patient_id", patientId).eq("clinic_id", clinicId),
  ]);
  const deposited = (deposits ?? []).reduce(
    (sum, row) => sum + Number(row.amount ?? 0),
    0,
  );
  const spent = (appointments ?? []).reduce(
    (sum, row) => sum + Number(row.deposit_amount ?? 0),
    0,
  );
  return Math.max(0, Number((deposited - spent).toFixed(2)));
}
