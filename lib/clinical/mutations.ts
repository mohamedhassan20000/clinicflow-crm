import "server-only";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import {
  assertDomainMutationRole,
  domainFailure,
  domainSuccess,
  type DomainMutationMode,
  type DomainMutationResult,
} from "@/lib/domain-mutations";
import type { AuthedUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import {
  clinicalRecordIdSchema,
  labRequestDraftSchema,
  prescriptionDraftSchema,
  sickLeaveDraftSchema,
  type LabRequestDraftInput,
  type LabRequestTestInput,
  type PrescriptionDraftInput,
  type PrescriptionMedicationInput,
} from "@/lib/validations/clinical";

export const CLINICAL_MUTATION_ROLES = [
  "admin",
  "manager",
  "receptionist",
  "doctor",
  "assistant",
] as const;

export type ClinicalTable = "prescriptions" | "lab_requests" | "sick_leaves";
export type ClinicalMutationData = {
  id: string;
  status: "draft" | "finalized" | "void";
};

export const prescriptionCreateSchema = prescriptionDraftSchema;
export const prescriptionUpdateSchema = z
  .object({ id: clinicalRecordIdSchema, draft: prescriptionDraftSchema })
  .strict();
export const labRequestCreateSchema = labRequestDraftSchema;
export const labRequestUpdateSchema = z
  .object({ id: clinicalRecordIdSchema, draft: labRequestDraftSchema })
  .strict();
export const sickLeaveCreateSchema = sickLeaveDraftSchema;
export const sickLeaveUpdateSchema = z
  .object({ id: clinicalRecordIdSchema, draft: sickLeaveDraftSchema })
  .strict();
export const clinicalRecordActionSchema = z
  .object({ id: clinicalRecordIdSchema })
  .strict();

function refreshClinical(table: ClinicalTable, clinicId: string) {
  const label =
    table === "prescriptions"
      ? "prescriptions"
      : table === "lab_requests"
        ? "lab-requests"
        : "sick-leaves";
  revalidateTag(`clinical:${label}:${clinicId}`, {});
  revalidatePath("/patients");
  revalidatePath("/documents");
}

async function hydrateMedications(
  user: AuthedUser,
  responsibleDoctorId: string,
  medications: PrescriptionMedicationInput[],
) {
  const supabase = await createClient();
  const doctor = await supabase
    .from("profiles")
    .select("department_id")
    .eq("id", responsibleDoctorId)
    .eq("clinic_id", user.clinicId)
    .eq("role", "doctor")
    .eq("is_active", true)
    .maybeSingle();
  if (doctor.error || !doctor.data) return null;
  const doctorDepartmentId = doctor.data.department_id;
  const ids = Array.from(
    new Set(
      medications
        .map((item) => item.drug_catalog_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  if (ids.length === 0) return medications;
  const catalog = await supabase
    .from("drug_catalog")
    .select(
      "id, name, form, strength, is_controlled, is_active, drug_catalog_departments(department_id)",
    )
    .eq("clinic_id", user.clinicId)
    .in("id", ids);
  if (catalog.error || catalog.data?.length !== ids.length) return null;
  const byId = new Map(catalog.data.map((entry) => [entry.id, entry]));
  return medications.map((item) => {
    if (!item.drug_catalog_id) return item;
    const entry = byId.get(item.drug_catalog_id);
    if (!entry?.is_active) return null;
    if (
      entry.drug_catalog_departments.length > 0 &&
      (!doctorDepartmentId ||
        !entry.drug_catalog_departments.some(
          (row) => row.department_id === doctorDepartmentId,
        ))
    ) {
      return null;
    }
    return {
      ...item,
      drug_name: [entry.name, entry.form, entry.strength]
        .filter(Boolean)
        .join(" · "),
      is_controlled_snapshot: entry.is_controlled,
    };
  });
}

async function hydrateTests(
  user: AuthedUser,
  responsibleDoctorId: string,
  tests: LabRequestTestInput[],
) {
  const supabase = await createClient();
  const doctor = await supabase
    .from("profiles")
    .select("department_id")
    .eq("id", responsibleDoctorId)
    .eq("clinic_id", user.clinicId)
    .eq("role", "doctor")
    .eq("is_active", true)
    .maybeSingle();
  if (doctor.error || !doctor.data) return null;
  const doctorDepartmentId = doctor.data.department_id;
  const ids = Array.from(
    new Set(
      tests
        .map((item) => item.lab_test_catalog_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  if (ids.length === 0) return tests;
  const catalog = await supabase
    .from("lab_test_catalog")
    .select("id, name, is_active, lab_test_catalog_departments(department_id)")
    .eq("clinic_id", user.clinicId)
    .in("id", ids);
  if (catalog.error || catalog.data?.length !== ids.length) return null;
  const byId = new Map(catalog.data.map((entry) => [entry.id, entry]));
  return tests.map((item) => {
    if (!item.lab_test_catalog_id) return item;
    const entry = byId.get(item.lab_test_catalog_id);
    if (!entry?.is_active) return null;
    if (
      entry.lab_test_catalog_departments.length > 0 &&
      (!doctorDepartmentId ||
        !entry.lab_test_catalog_departments.some(
          (row) => row.department_id === doctorDepartmentId,
        ))
    ) {
      return null;
    }
    return { ...item, test_name: entry.name };
  });
}

function prescriptionHeader(draft: PrescriptionDraftInput) {
  return {
    responsible_doctor_id: draft.responsible_doctor_id,
    appointment_id: draft.appointment_id ?? null,
    patient_id: draft.patient_id ?? null,
    subject_full_name: draft.subject_full_name ?? null,
    subject_dob: draft.subject_dob ?? null,
    subject_national_id: draft.subject_national_id ?? null,
    valid_until: draft.valid_until ?? null,
    notes: draft.notes ?? null,
  };
}

function prescriptionItems(
  id: string,
  medications: NonNullable<Awaited<ReturnType<typeof hydrateMedications>>>,
) {
  return medications.map((item, index) => ({
    prescription_id: id,
    drug_catalog_id: item!.drug_catalog_id ?? null,
    drug_name: item!.drug_name,
    dose: item!.dose ?? null,
    frequency: item!.frequency ?? null,
    duration: item!.duration ?? null,
    route: item!.route ?? null,
    quantity: item!.quantity ?? null,
    instructions: item!.instructions ?? null,
    is_controlled_snapshot: item!.is_controlled_snapshot,
    sort_order: item!.sort_order ?? index,
  }));
}

export async function createPrescriptionMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<ClinicalMutationData>> {
  assertDomainMutationRole(user, CLINICAL_MUTATION_ROLES);
  const parsed = prescriptionCreateSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("clinical.validationError", {
      validationError: parsed.error,
    });
  const medications = await hydrateMedications(
    user,
    parsed.data.responsible_doctor_id,
    parsed.data.medications,
  );
  if (!medications || medications.some((item) => !item))
    return domainFailure("clinical.mutationFailed");
  const header = prescriptionHeader(parsed.data);
  if (mode === "preview") {
    return domainSuccess(
      { id: "00000000-0000-0000-0000-000000000000", status: "draft" },
      {
        targetTable: "prescriptions",
        after: { ...header, medications, status: "draft" },
      },
    );
  }
  const supabase = await createClient();
  const created = await supabase
    .from("prescriptions")
    .insert({
      ...header,
      clinic_id: user.clinicId,
      created_by: user.id,
      status: "draft",
    })
    .select("id")
    .single();
  if (created.error) return domainFailure("clinical.mutationFailed");
  const items = prescriptionItems(created.data.id, medications);
  const inserted = await supabase.from("prescription_medications").insert(items);
  if (inserted.error) {
    await supabase.from("prescriptions").delete().eq("id", created.data.id);
    return domainFailure("clinical.mutationFailed");
  }
  refreshClinical("prescriptions", user.clinicId);
  return domainSuccess(
    { id: created.data.id, status: "draft" },
    {
      targetTable: "prescriptions",
      targetRecordIds: [created.data.id],
      after: { ...header, id: created.data.id, medications, status: "draft" },
    },
  );
}

export async function updatePrescriptionMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<ClinicalMutationData>> {
  assertDomainMutationRole(user, CLINICAL_MUTATION_ROLES);
  const parsed = prescriptionUpdateSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("clinical.validationError", {
      validationError: parsed.error,
    });
  const medications = await hydrateMedications(
    user,
    parsed.data.draft.responsible_doctor_id,
    parsed.data.draft.medications,
  );
  if (!medications || medications.some((item) => !item))
    return domainFailure("clinical.mutationFailed");
  const supabase = await createClient();
  const existing = await supabase
    .from("prescriptions")
    .select("*, prescription_medications(*)")
    .eq("id", parsed.data.id)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (existing.error || !existing.data || existing.data.status !== "draft")
    return domainFailure("clinical.recordLocked");
  const header = prescriptionHeader(parsed.data.draft);
  if (mode === "preview") {
    return domainSuccess(
      { id: parsed.data.id, status: "draft" },
      {
        targetTable: "prescriptions",
        targetRecordIds: [parsed.data.id],
        before: existing.data,
        after: { ...existing.data, ...header, medications },
      },
    );
  }
  const updated = await supabase
    .from("prescriptions")
    .update(header)
    .eq("id", parsed.data.id)
    .eq("clinic_id", user.clinicId)
    .eq("status", "draft");
  if (updated.error) return domainFailure("clinical.mutationFailed");
  const removed = await supabase
    .from("prescription_medications")
    .delete()
    .eq("prescription_id", parsed.data.id);
  if (removed.error) return domainFailure("clinical.mutationFailed");
  const inserted = await supabase
    .from("prescription_medications")
    .insert(prescriptionItems(parsed.data.id, medications));
  if (inserted.error) {
    const previous = existing.data.prescription_medications.map((item) => ({
      prescription_id: item.prescription_id,
      drug_catalog_id: item.drug_catalog_id,
      drug_name: item.drug_name,
      dose: item.dose,
      frequency: item.frequency,
      duration: item.duration,
      route: item.route,
      quantity: item.quantity,
      instructions: item.instructions,
      is_controlled_snapshot: item.is_controlled_snapshot,
      sort_order: item.sort_order,
    }));
    if (previous.length > 0)
      await supabase.from("prescription_medications").insert(previous);
    return domainFailure("clinical.mutationFailed");
  }
  refreshClinical("prescriptions", user.clinicId);
  return domainSuccess(
    { id: parsed.data.id, status: "draft" },
    {
      targetTable: "prescriptions",
      targetRecordIds: [parsed.data.id],
      before: existing.data,
      after: { ...existing.data, ...header, medications },
    },
  );
}

function labHeader(draft: LabRequestDraftInput) {
  return {
    responsible_doctor_id: draft.responsible_doctor_id,
    appointment_id: draft.appointment_id ?? null,
    patient_id: draft.patient_id ?? null,
    subject_full_name: draft.subject_full_name ?? null,
    subject_dob: draft.subject_dob ?? null,
    subject_national_id: draft.subject_national_id ?? null,
    priority: draft.priority,
    laboratory_name: draft.laboratory_name ?? null,
    clinical_context: draft.clinical_context ?? null,
    instructions: draft.instructions ?? null,
  };
}

function labItems(
  id: string,
  tests: NonNullable<Awaited<ReturnType<typeof hydrateTests>>>,
) {
  return tests.map((item, index) => ({
    lab_request_id: id,
    lab_test_catalog_id: item!.lab_test_catalog_id ?? null,
    test_name: item!.test_name,
    notes: item!.notes ?? null,
    sort_order: item!.sort_order ?? index,
  }));
}

export async function createLabRequestMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<ClinicalMutationData>> {
  assertDomainMutationRole(user, CLINICAL_MUTATION_ROLES);
  const parsed = labRequestCreateSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("clinical.validationError", {
      validationError: parsed.error,
    });
  const tests = await hydrateTests(
    user,
    parsed.data.responsible_doctor_id,
    parsed.data.tests,
  );
  if (!tests || tests.some((item) => !item))
    return domainFailure("clinical.mutationFailed");
  const header = labHeader(parsed.data);
  if (mode === "preview") {
    return domainSuccess(
      { id: "00000000-0000-0000-0000-000000000000", status: "draft" },
      {
        targetTable: "lab_requests",
        after: { ...header, tests, status: "draft" },
      },
    );
  }
  const supabase = await createClient();
  const created = await supabase
    .from("lab_requests")
    .insert({
      ...header,
      clinic_id: user.clinicId,
      created_by: user.id,
      status: "draft",
    })
    .select("id")
    .single();
  if (created.error) return domainFailure("clinical.mutationFailed");
  const inserted = await supabase
    .from("lab_request_tests")
    .insert(labItems(created.data.id, tests));
  if (inserted.error) {
    await supabase.from("lab_requests").delete().eq("id", created.data.id);
    return domainFailure("clinical.mutationFailed");
  }
  refreshClinical("lab_requests", user.clinicId);
  return domainSuccess(
    { id: created.data.id, status: "draft" },
    {
      targetTable: "lab_requests",
      targetRecordIds: [created.data.id],
      after: { ...header, id: created.data.id, tests, status: "draft" },
    },
  );
}

export async function updateLabRequestMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<ClinicalMutationData>> {
  assertDomainMutationRole(user, CLINICAL_MUTATION_ROLES);
  const parsed = labRequestUpdateSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("clinical.validationError", {
      validationError: parsed.error,
    });
  const tests = await hydrateTests(
    user,
    parsed.data.draft.responsible_doctor_id,
    parsed.data.draft.tests,
  );
  if (!tests || tests.some((item) => !item))
    return domainFailure("clinical.mutationFailed");
  const supabase = await createClient();
  const existing = await supabase
    .from("lab_requests")
    .select("*, lab_request_tests(*)")
    .eq("id", parsed.data.id)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (existing.error || !existing.data || existing.data.status !== "draft")
    return domainFailure("clinical.recordLocked");
  const header = labHeader(parsed.data.draft);
  if (mode === "preview") {
    return domainSuccess(
      { id: parsed.data.id, status: "draft" },
      {
        targetTable: "lab_requests",
        targetRecordIds: [parsed.data.id],
        before: existing.data,
        after: { ...existing.data, ...header, tests },
      },
    );
  }
  const updated = await supabase
    .from("lab_requests")
    .update(header)
    .eq("id", parsed.data.id)
    .eq("clinic_id", user.clinicId)
    .eq("status", "draft");
  if (updated.error) return domainFailure("clinical.mutationFailed");
  const removed = await supabase
    .from("lab_request_tests")
    .delete()
    .eq("lab_request_id", parsed.data.id);
  if (removed.error) return domainFailure("clinical.mutationFailed");
  const inserted = await supabase
    .from("lab_request_tests")
    .insert(labItems(parsed.data.id, tests));
  if (inserted.error) {
    const previous = existing.data.lab_request_tests.map((item) => ({
      lab_request_id: item.lab_request_id,
      lab_test_catalog_id: item.lab_test_catalog_id,
      test_name: item.test_name,
      notes: item.notes,
      sort_order: item.sort_order,
    }));
    if (previous.length > 0)
      await supabase.from("lab_request_tests").insert(previous);
    return domainFailure("clinical.mutationFailed");
  }
  refreshClinical("lab_requests", user.clinicId);
  return domainSuccess(
    { id: parsed.data.id, status: "draft" },
    {
      targetTable: "lab_requests",
      targetRecordIds: [parsed.data.id],
      before: existing.data,
      after: { ...existing.data, ...header, tests },
    },
  );
}

export async function createSickLeaveMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<ClinicalMutationData>> {
  assertDomainMutationRole(user, CLINICAL_MUTATION_ROLES);
  const parsed = sickLeaveCreateSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("clinical.validationError", {
      validationError: parsed.error,
    });
  if (mode === "preview") {
    return domainSuccess(
      { id: "00000000-0000-0000-0000-000000000000", status: "draft" },
      {
        targetTable: "sick_leaves",
        after: { ...parsed.data, status: "draft" },
      },
    );
  }
  const supabase = await createClient();
  const created = await supabase
    .from("sick_leaves")
    .insert({
      ...parsed.data,
      clinic_id: user.clinicId,
      created_by: user.id,
      status: "draft",
    })
    .select("id")
    .single();
  if (created.error) return domainFailure("clinical.mutationFailed");
  refreshClinical("sick_leaves", user.clinicId);
  return domainSuccess(
    { id: created.data.id, status: "draft" },
    {
      targetTable: "sick_leaves",
      targetRecordIds: [created.data.id],
      after: { ...parsed.data, id: created.data.id, status: "draft" },
    },
  );
}

export async function updateSickLeaveMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<ClinicalMutationData>> {
  assertDomainMutationRole(user, CLINICAL_MUTATION_ROLES);
  const parsed = sickLeaveUpdateSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("clinical.validationError", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  const existing = await supabase
    .from("sick_leaves")
    .select("*")
    .eq("id", parsed.data.id)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (existing.error || !existing.data || existing.data.status !== "draft")
    return domainFailure("clinical.recordLocked");
  if (mode === "preview") {
    return domainSuccess(
      { id: parsed.data.id, status: "draft" },
      {
        targetTable: "sick_leaves",
        targetRecordIds: [parsed.data.id],
        before: existing.data,
        after: { ...existing.data, ...parsed.data.draft },
      },
    );
  }
  const updated = await supabase
    .from("sick_leaves")
    .update(parsed.data.draft)
    .eq("id", parsed.data.id)
    .eq("clinic_id", user.clinicId)
    .eq("status", "draft");
  if (updated.error) return domainFailure("clinical.mutationFailed");
  refreshClinical("sick_leaves", user.clinicId);
  return domainSuccess(
    { id: parsed.data.id, status: "draft" },
    {
      targetTable: "sick_leaves",
      targetRecordIds: [parsed.data.id],
      before: existing.data,
      after: { ...existing.data, ...parsed.data.draft },
    },
  );
}

export async function transitionClinicalRecordMutation(
  user: AuthedUser,
  table: ClinicalTable,
  input: unknown,
  transition: "finalize" | "void",
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<ClinicalMutationData>> {
  assertDomainMutationRole(user, CLINICAL_MUTATION_ROLES);
  const parsed = clinicalRecordActionSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("clinical.validationError", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  const existing = await supabase
    .from(table)
    .select("id, status, patient_id, responsible_doctor_id")
    .eq("id", parsed.data.id)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (existing.error) return domainFailure("clinical.mutationFailed");
  if (!existing.data) return domainFailure("clinical.recordNotFound");
  const expected = transition === "finalize" ? "draft" : "finalized";
  const target = transition === "finalize" ? "finalized" : "void";
  if (existing.data.status !== expected)
    return domainFailure("clinical.recordLocked");
  if (transition === "finalize" && table !== "sick_leaves") {
    const count =
      table === "prescriptions"
        ? await supabase
            .from("prescription_medications")
            .select("id", { count: "exact", head: true })
            .eq("prescription_id", parsed.data.id)
        : await supabase
            .from("lab_request_tests")
            .select("id", { count: "exact", head: true })
            .eq("lab_request_id", parsed.data.id);
    if (count.error || !count.count)
      return domainFailure("clinical.mutationFailed");
  }
  const next = {
    ...existing.data,
    status: target,
    ...(transition === "finalize"
      ? { finalized_at: new Date().toISOString(), finalized_by: user.id }
      : {}),
  };
  if (mode === "preview") {
    return domainSuccess(
      { id: parsed.data.id, status: target },
      {
        targetTable: table,
        targetRecordIds: [parsed.data.id],
        before: existing.data,
        after: next,
      },
    );
  }
  const updated = await supabase
    .from(table)
    .update(
      transition === "finalize"
        ? {
            status: "finalized",
            finalized_at: next.finalized_at,
            finalized_by: user.id,
          }
        : { status: "void" },
    )
    .eq("id", parsed.data.id)
    .eq("clinic_id", user.clinicId)
    .eq("status", expected)
    .select("id")
    .maybeSingle();
  if (updated.error) return domainFailure("clinical.mutationFailed");
  if (!updated.data) return domainFailure("clinical.recordLocked");
  refreshClinical(table, user.clinicId);
  return domainSuccess(
    { id: parsed.data.id, status: target },
    {
      targetTable: table,
      targetRecordIds: [parsed.data.id],
      before: existing.data,
      after: next,
    },
  );
}
