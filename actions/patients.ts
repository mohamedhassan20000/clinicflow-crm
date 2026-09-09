"use server";

import { domainFailureToActionResult } from "@/actions/_domain";
import {
  addPatientDepositMutation,
  settleOutstandingMutation,
} from "@/lib/billing/mutations";
import {
  addMedicalNoteMutation,
  archivePatientMutation,
  createPatientMutation,
  deleteMedicalNoteMutation,
  restoreMedicalNoteMutation,
  restorePatientMutation,
  softDeletePatientMutation,
  updateMedicalNoteMutation,
  updatePatientMutation,
} from "@/lib/patients/mutations";
import { requireMutationRole } from "@/lib/rbac";
import { redirect } from "next/navigation";
import {
  archiveAllTrashPatients as legacyArchiveAllTrashPatients,
  getArchivePatients as legacyGetArchivePatients,
  getPatientAccountBalance as legacyGetPatientAccountBalance,
  getTrashPatients as legacyGetTrashPatients,
} from "@/actions/patients-legacy";

export type ActionResult = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  success?: boolean;
  patientId?: string;
};
export type { PatientStub } from "@/actions/patients-legacy";

function nullableFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return value && value !== "none" ? value : null;
}

function patientFormInput(formData: FormData) {
  return {
    full_name: formData.get("full_name"),
    // Optional, patient-facing, and absent unless a person typed one. The
    // mutation drops a blank rather than storing `""` — see
    // `stripBlankDisplayNames` — which also keeps the write working on a
    // database where the additive migration has not been applied yet.
    full_name_ar: formData.get("full_name_ar") || null,
    full_name_en: formData.get("full_name_en") || null,
    national_id: formData.get("national_id"),
    date_of_birth: formData.get("date_of_birth"),
    phone: formData.get("phone"),
    email: formData.get("email"),
    blood_type: nullableFormValue(formData, "blood_type"),
    department_id: nullableFormValue(formData, "department_id"),
    assigned_doctor_id: nullableFormValue(formData, "assigned_doctor_id"),
    insurance_provider_id: nullableFormValue(
      formData,
      "insurance_provider_id",
    ),
  };
}

export async function createPatient(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const result = await createPatientMutation(user, patientFormInput(formData));
  if (!result.ok) return domainFailureToActionResult(result);
  return { success: true, patientId: result.data.patient_id };
}

export async function updatePatient(
  id: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const result = await updatePatientMutation(user, {
    patient_id: id,
    ...patientFormInput(formData),
  });
  if (!result.ok) return domainFailureToActionResult(result);
  redirect(`/patients/${id}`);
}

export async function softDeletePatient(id: string): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const result = await softDeletePatientMutation(user, { patient_id: id });
  if (!result.ok) return domainFailureToActionResult(result);
  redirect("/patients");
}

export async function restorePatient(id: string): Promise<ActionResult> {
  const user = await requireMutationRole("admin");
  const result = await restorePatientMutation(user, { patient_id: id });
  return result.ok ? {} : domainFailureToActionResult(result);
}

export async function archivePatient(id: string): Promise<ActionResult> {
  const user = await requireMutationRole("admin");
  const result = await archivePatientMutation(user, { patient_id: id });
  return result.ok
    ? { success: true }
    : domainFailureToActionResult(result);
}

export async function restoreArchivedPatient(id: string): Promise<ActionResult> {
  return restorePatient(id);
}

export async function addMedicalNote(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "doctor"]);
  const result = await addMedicalNoteMutation(user, {
    patient_id: formData.get("patient_id"),
    appointment_id: formData.get("appointment_id") || null,
    note: formData.get("note"),
  });
  return result.ok ? {} : domainFailureToActionResult(result);
}

export async function updateMedicalNote(
  noteId: string,
  note: string,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "doctor"]);
  const result = await updateMedicalNoteMutation(user, {
    note_id: noteId,
    note,
  });
  return result.ok ? {} : domainFailureToActionResult(result);
}

export async function deleteMedicalNote(noteId: string): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "doctor"]);
  const result = await deleteMedicalNoteMutation(user, { note_id: noteId });
  return result.ok
    ? { success: true }
    : domainFailureToActionResult(result);
}

export async function restoreMedicalNote(noteId: string): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "doctor"]);
  const result = await restoreMedicalNoteMutation(user, { note_id: noteId });
  return result.ok
    ? { success: true }
    : domainFailureToActionResult(result);
}

// Read helpers, bulk archive, and the Phase 5d billing adapters retain their
// existing UI behavior until their respective extraction boundary.
export async function getTrashPatients(...args: Parameters<typeof legacyGetTrashPatients>) {
  return legacyGetTrashPatients(...args);
}
export async function getArchivePatients(...args: Parameters<typeof legacyGetArchivePatients>) {
  return legacyGetArchivePatients(...args);
}
export async function archiveAllTrashPatients(...args: Parameters<typeof legacyArchiveAllTrashPatients>) {
  return legacyArchiveAllTrashPatients(...args);
}
export async function getPatientAccountBalance(...args: Parameters<typeof legacyGetPatientAccountBalance>) {
  return legacyGetPatientAccountBalance(...args);
}
export async function addPatientDeposit(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const result = await addPatientDepositMutation(user, {
    patient_id: String(formData.get("patient_id") ?? ""),
    amount: Number(formData.get("amount") ?? 0),
    payment_method: String(formData.get("payment_method") ?? ""),
    note: String(formData.get("note") ?? "").trim() || null,
  });
  return result.ok ? {} : domainFailureToActionResult(result);
}
export async function settleOutstanding(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const result = await settleOutstandingMutation(user, {
    patient_id: String(formData.get("patient_id") ?? ""),
    appointment_id: String(formData.get("appointment_id") ?? "") || null,
    amount: Number(formData.get("amount") ?? 0),
    payment_method: String(formData.get("payment_method") ?? ""),
    secondary_amount: Number(formData.get("secondary_amount") ?? 0),
    secondary_payment_method:
      String(formData.get("secondary_payment_method") ?? "") || null,
    note: String(formData.get("note") ?? "").trim() || null,
  });
  return result.ok ? {} : domainFailureToActionResult(result);
}
