"use server";

import { domainFailureToActionResult } from "@/actions/_domain";
import {
  createPatientPackageMutation,
  deactivatePatientPackageMutation,
  updatePatientPackageMutation,
} from "@/lib/billing/mutations";
import { requireMutationRole } from "@/lib/rbac";

export type PatientPackageActionResult = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  success?: boolean;
};

export async function createPatientPackage(
  _prev: PatientPackageActionResult | null,
  formData: FormData,
): Promise<PatientPackageActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const result = await createPatientPackageMutation(user, {
    patient_id: formData.get("patient_id"),
    name: formData.get("name"),
    total_sessions: formData.get("total_sessions"),
    used_sessions: formData.get("used_sessions") ?? 0,
    price_per_session: formData.get("price_per_session"),
    notes: formData.get("notes"),
    department_id: formData.get("department_id"),
    service_id: formData.get("service_id"),
  });
  return result.ok
    ? { success: true }
    : domainFailureToActionResult(result);
}

export async function updatePatientPackage(
  _prev: PatientPackageActionResult | null,
  formData: FormData,
): Promise<PatientPackageActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const result = await updatePatientPackageMutation(user, {
    package_id: formData.get("package_id"),
    name: formData.get("name"),
    total_sessions: formData.get("total_sessions"),
    price_per_session: formData.get("price_per_session"),
    notes: formData.get("notes"),
    department_id: formData.get("department_id"),
    service_id: formData.get("service_id"),
    is_active: formData.get("is_active") === "true",
  });
  return result.ok
    ? { success: true }
    : domainFailureToActionResult(result);
}

export async function deactivatePatientPackage(
  _prev: PatientPackageActionResult | null,
  formData: FormData,
): Promise<PatientPackageActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);
  const result = await deactivatePatientPackageMutation(user, {
    package_id: formData.get("package_id"),
  });
  return result.ok
    ? { success: true }
    : domainFailureToActionResult(result);
}
