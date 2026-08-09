"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { actionError } from "@/lib/i18n/action-errors";
import { createClient } from "@/lib/supabase/server";
import { requireMutationRole, requireRole } from "@/lib/rbac";
import {
  drugCatalogEntrySchema,
  labTestCatalogEntrySchema,
  type DrugCatalogEntryInput,
  type LabTestCatalogEntryInput,
} from "@/lib/validations/clinical";
import {
  mutationFailure,
  validationFailure,
  type ClinicalActionResult,
} from "@/actions/clinical/_shared";

function refreshCatalogs(clinicId: string) {
  revalidateTag(`clinical:catalogs:${clinicId}`, {});
  revalidatePath("/settings/clinical");
}

export async function listClinicalCatalogs() {
  const user = await requireRole(["admin", "manager", "receptionist", "doctor", "assistant"]);
  const supabase = await createClient();
  const [drugs, tests] = await Promise.all([
    supabase.from("drug_catalog")
      .select("*, drug_catalog_departments(department_id)")
      .eq("clinic_id", user.clinicId).order("name"),
    supabase.from("lab_test_catalog")
      .select("*, lab_test_catalog_departments(department_id)")
      .eq("clinic_id", user.clinicId).order("name"),
  ]);
  return {
    drugs: drugs.data ?? [],
    tests: tests.data ?? [],
    error: drugs.error || tests.error ? await actionError("clinical.catalogReadFailed") : null,
  };
}

export async function saveDrugCatalogEntry(
  input: DrugCatalogEntryInput,
): Promise<ClinicalActionResult<{ id: string }>> {
  const user = await requireMutationRole("admin");
  const parsed = drugCatalogEntrySchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error.issues);
  const supabase = await createClient();
  const { department_ids, id, ...entry } = parsed.data;
  let entryId = id ?? null;
  if (entryId) {
    const { data, error } = await supabase.from("drug_catalog").update(entry)
      .eq("id", entryId).eq("clinic_id", user.clinicId).select("id").maybeSingle();
    if (error || !data) return mutationFailure("drug_catalog_update_failed", { clinicId: user.clinicId, entryId, error });
  } else {
    const { data, error } = await supabase.from("drug_catalog")
      .insert({ ...entry, clinic_id: user.clinicId }).select("id").single();
    if (error || !data) return mutationFailure("drug_catalog_insert_failed", { clinicId: user.clinicId, error });
    entryId = data.id;
  }

  const { data: previous } = await supabase.from("drug_catalog_departments")
    .select("department_id").eq("drug_catalog_id", entryId);
  const removed = await supabase.from("drug_catalog_departments").delete()
    .eq("drug_catalog_id", entryId);
  if (removed.error) return mutationFailure("drug_catalog_departments_delete_failed", { clinicId: user.clinicId, entryId, error: removed.error });
  if (department_ids.length > 0) {
    const inserted = await supabase.from("drug_catalog_departments").insert(
      Array.from(new Set(department_ids)).map((department_id) => ({
        drug_catalog_id: entryId!, department_id,
      })),
    );
    if (inserted.error) {
      if ((previous?.length ?? 0) > 0) {
        await supabase.from("drug_catalog_departments").insert(
          previous!.map(({ department_id }) => ({ drug_catalog_id: entryId!, department_id })),
        );
      }
      return mutationFailure("drug_catalog_departments_insert_failed", { clinicId: user.clinicId, entryId, error: inserted.error });
    }
  }
  refreshCatalogs(user.clinicId);
  return { success: true, data: { id: entryId } };
}

export async function saveLabTestCatalogEntry(
  input: LabTestCatalogEntryInput,
): Promise<ClinicalActionResult<{ id: string }>> {
  const user = await requireMutationRole("admin");
  const parsed = labTestCatalogEntrySchema.safeParse(input);
  if (!parsed.success) return validationFailure(parsed.error.issues);
  const supabase = await createClient();
  const { department_ids, id, ...entry } = parsed.data;
  let entryId = id ?? null;
  if (entryId) {
    const { data, error } = await supabase.from("lab_test_catalog").update(entry)
      .eq("id", entryId).eq("clinic_id", user.clinicId).select("id").maybeSingle();
    if (error || !data) return mutationFailure("lab_test_catalog_update_failed", { clinicId: user.clinicId, entryId, error });
  } else {
    const { data, error } = await supabase.from("lab_test_catalog")
      .insert({ ...entry, clinic_id: user.clinicId }).select("id").single();
    if (error || !data) return mutationFailure("lab_test_catalog_insert_failed", { clinicId: user.clinicId, error });
    entryId = data.id;
  }
  const { data: previous } = await supabase.from("lab_test_catalog_departments")
    .select("department_id").eq("lab_test_catalog_id", entryId);
  const removed = await supabase.from("lab_test_catalog_departments").delete()
    .eq("lab_test_catalog_id", entryId);
  if (removed.error) return mutationFailure("lab_test_catalog_departments_delete_failed", { clinicId: user.clinicId, entryId, error: removed.error });
  if (department_ids.length > 0) {
    const inserted = await supabase.from("lab_test_catalog_departments").insert(
      Array.from(new Set(department_ids)).map((department_id) => ({
        lab_test_catalog_id: entryId!, department_id,
      })),
    );
    if (inserted.error) {
      if ((previous?.length ?? 0) > 0) {
        await supabase.from("lab_test_catalog_departments").insert(
          previous!.map(({ department_id }) => ({ lab_test_catalog_id: entryId!, department_id })),
        );
      }
      return mutationFailure("lab_test_catalog_departments_insert_failed", { clinicId: user.clinicId, entryId, error: inserted.error });
    }
  }
  refreshCatalogs(user.clinicId);
  return { success: true, data: { id: entryId } };
}
