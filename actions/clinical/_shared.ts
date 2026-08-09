import "server-only";
import { actionError } from "@/lib/i18n/action-errors";
import { requireMutationRole, requireRole, type AuthedUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import type {
  LabRequestTestInput,
  PrescriptionMedicationInput,
} from "@/lib/validations/clinical";

export const CLINICAL_PREPARER_ROLES = [
  "admin",
  "manager",
  "receptionist",
  "doctor",
  "assistant",
] as const;

export type ClinicalActionResult<T = undefined> = {
  success?: boolean;
  data?: T;
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

export async function requireClinicalMutation(): Promise<AuthedUser> {
  return requireMutationRole([...CLINICAL_PREPARER_ROLES]);
}

export async function requireClinicalRead(): Promise<AuthedUser> {
  return requireRole([...CLINICAL_PREPARER_ROLES]);
}

export async function validationFailure(
  issues: { path: PropertyKey[]; message: string }[],
): Promise<ClinicalActionResult<never>> {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.join(".") || "form";
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return {
    error: await actionError("clinical.validationError"),
    fieldErrors,
  };
}

/**
 * Generic clinical mutation failure. The user-facing string stays generic; the
 * real underlying cause (Postgres error / context) is always logged server-side
 * so swallowed failures are diagnosable. `event` names the failing operation.
 */
export async function mutationFailure(
  event?: string,
  context?: Record<string, unknown>,
): Promise<ClinicalActionResult<never>> {
  if (event) {
    console.error(event, {
      ...context,
      message:
        context?.error instanceof Error
          ? context.error.message
          : context?.error != null
            ? String(
                (context.error as { message?: unknown }).message ??
                  context.error,
              )
            : "unknown",
    });
  }
  return { error: await actionError("clinical.mutationFailed") };
}

export async function recordNotFound(): Promise<ClinicalActionResult<never>> {
  return { error: await actionError("clinical.recordNotFound") };
}

export async function recordLocked(): Promise<ClinicalActionResult<never>> {
  return { error: await actionError("clinical.recordLocked") };
}

export async function hydratePrescriptionMedications(
  user: AuthedUser,
  responsibleDoctorId: string,
  medications: PrescriptionMedicationInput[],
) {
  const supabase = await createClient();
  const { data: doctor } = await supabase
    .from("profiles")
    .select("department_id")
    .eq("id", responsibleDoctorId)
    .eq("clinic_id", user.clinicId)
    .eq("role", "doctor")
    .eq("is_active", true)
    .maybeSingle();
  if (!doctor) return null;

  const ids = Array.from(
    new Set(
      medications
        .map((item) => item.drug_catalog_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  if (ids.length === 0) return medications;

  const { data: catalog } = await supabase
    .from("drug_catalog")
    .select("id, name, form, strength, is_controlled, is_active, drug_catalog_departments(department_id)")
    .eq("clinic_id", user.clinicId)
    .in("id", ids);
  if (!catalog || catalog.length !== ids.length) return null;
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));

  return medications.map((item) => {
    if (!item.drug_catalog_id) return item;
    const entry = byId.get(item.drug_catalog_id);
    if (!entry?.is_active) throw new Error("CLINICAL_CATALOG_INACTIVE");
    const departments = entry.drug_catalog_departments ?? [];
    if (
      departments.length > 0 &&
      (!doctor.department_id || !departments.some((row) => row.department_id === doctor.department_id))
    ) {
      throw new Error("CLINICAL_CATALOG_DEPARTMENT_SCOPE");
    }
    const snapshotName = [entry.name, entry.form, entry.strength].filter(Boolean).join(" · ");
    return {
      ...item,
      drug_name: snapshotName,
      is_controlled_snapshot: entry.is_controlled,
    };
  });
}

export async function hydrateLabRequestTests(
  user: AuthedUser,
  responsibleDoctorId: string,
  tests: LabRequestTestInput[],
) {
  const supabase = await createClient();
  const { data: doctor } = await supabase
    .from("profiles")
    .select("department_id")
    .eq("id", responsibleDoctorId)
    .eq("clinic_id", user.clinicId)
    .eq("role", "doctor")
    .eq("is_active", true)
    .maybeSingle();
  if (!doctor) return null;

  const ids = Array.from(
    new Set(
      tests
        .map((item) => item.lab_test_catalog_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  if (ids.length === 0) return tests;

  const { data: catalog } = await supabase
    .from("lab_test_catalog")
    .select("id, name, is_active, lab_test_catalog_departments(department_id)")
    .eq("clinic_id", user.clinicId)
    .in("id", ids);
  if (!catalog || catalog.length !== ids.length) return null;
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));

  return tests.map((item) => {
    if (!item.lab_test_catalog_id) return item;
    const entry = byId.get(item.lab_test_catalog_id);
    if (!entry?.is_active) throw new Error("CLINICAL_CATALOG_INACTIVE");
    const departments = entry.lab_test_catalog_departments ?? [];
    if (
      departments.length > 0 &&
      (!doctor.department_id || !departments.some((row) => row.department_id === doctor.department_id))
    ) {
      throw new Error("CLINICAL_CATALOG_DEPARTMENT_SCOPE");
    }
    return { ...item, test_name: entry.name };
  });
}

export async function finalizeClinicalRecord(
  table: "prescriptions" | "lab_requests" | "sick_leaves",
  id: string,
): Promise<ClinicalActionResult<{ id: string; status: "finalized" }>> {
  const user = await requireClinicalMutation();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from(table)
    .update({
      status: "finalized",
      finalized_at: new Date().toISOString(),
      finalized_by: user.id,
    })
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .eq("status", "draft")
    .select("id")
    .maybeSingle();
  if (error) return mutationFailure();
  if (!data) return recordLocked();
  return { success: true, data: { id: data.id, status: "finalized" } };
}

/**
 * Finalize a draft immediately before document issuance. This is deliberately
 * idempotent so a failed PDF render can be retried without weakening the
 * clinical record lifecycle or issuing from mutable draft data.
 */
export async function ensureClinicalRecordFinalizedForIssue(
  table: "prescriptions" | "lab_requests" | "sick_leaves",
  id: string,
): Promise<ClinicalActionResult<{ id: string; status: "finalized" }>> {
  const user = await requireClinicalMutation();
  const supabase = await createClient();
  const { data: current, error: readError } = await supabase
    .from(table)
    .select("id, status")
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (readError) return mutationFailure("clinical_issue_finalize_read_failed", { error: readError, table, id });
  if (!current) return recordNotFound();
  if (current.status === "finalized") {
    return { success: true, data: { id: current.id, status: "finalized" } };
  }
  if (current.status !== "draft") return recordLocked();

  const { data, error } = await supabase
    .from(table)
    .update({
      status: "finalized",
      finalized_at: new Date().toISOString(),
      finalized_by: user.id,
    })
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .eq("status", "draft")
    .select("id")
    .maybeSingle();
  if (error) return mutationFailure("clinical_issue_finalize_failed", { error, table, id });
  if (data) return { success: true, data: { id: data.id, status: "finalized" } };

  const { data: raced } = await supabase
    .from(table)
    .select("id, status")
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  return raced?.status === "finalized"
    ? { success: true, data: { id: raced.id, status: "finalized" } }
    : recordLocked();
}

export async function voidClinicalRecord(
  table: "prescriptions" | "lab_requests" | "sick_leaves",
  id: string,
): Promise<ClinicalActionResult<{ id: string; status: "void" }>> {
  const user = await requireClinicalMutation();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from(table)
    .update({ status: "void" })
    .eq("id", id)
    .eq("clinic_id", user.clinicId)
    .eq("status", "finalized")
    .select("id")
    .maybeSingle();
  if (error) return mutationFailure();
  if (!data) return recordLocked();
  return { success: true, data: { id: data.id, status: "void" } };
}
