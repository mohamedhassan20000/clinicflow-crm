"use server";

import { actionError } from "@/lib/i18n/action-errors";
import { localizeZodFieldErrors } from "@/lib/validations/server";
import { revalidatePath } from "next/cache";
import { requireMutationRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import {
  createPatientPackageSchema,
  deactivatePatientPackageSchema,
  updatePatientPackageSchema,
} from "@/lib/validations/patient-package";

export type PatientPackageActionResult = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  success?: boolean;
};

async function getPatientForClinic(patientId: string, clinicId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("patients")
    .select("id")
    .eq("id", patientId)
    .eq("clinic_id", clinicId)
    .eq("is_deleted", false)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getPackageForClinic(packageId: string, clinicId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("patient_packages")
    .select("id, patient_id, used_sessions, total_sessions")
    .eq("id", packageId)
    .eq("clinic_id", clinicId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function validateDepartmentAndService(input: {
  clinicId: string;
  departmentId: string | null;
  serviceId: string | null;
}): Promise<PatientPackageActionResult | null> {
  const supabase = await createClient();

  if (input.departmentId) {
    const { data, error } = await supabase
      .from("departments")
      .select("id")
      .eq("id", input.departmentId)
      .eq("clinic_id", input.clinicId)
      .maybeSingle();

    if (error) return { error: await actionError("patient-packages.failedToValidateDepartment") };
    if (!data) {
      return {
        fieldErrors: { department_id: [await actionError("patient-packages.selectADepartmentFromThisClinic")] },
      };
    }
  }

  if (!input.serviceId) return null;

  const { data, error } = await supabase
    .from("services")
    .select("id, department_id")
    .eq("id", input.serviceId)
    .eq("clinic_id", input.clinicId)
    .eq("is_active", true)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) return { error: await actionError("patient-packages.failedToValidateService") };
  if (!data) {
    return {
      fieldErrors: { service_id: [await actionError("patient-packages.selectAnActiveServiceFromThisClinic")] },
    };
  }
  if (input.departmentId && data.department_id !== input.departmentId) {
    return {
      fieldErrors: {
        service_id: [await actionError("patient-packages.selectAServiceThatBelongsToTheSelectedDepartment")],
      },
    };
  }

  return null;
}

function revalidatePatient(patientId: string) {
  revalidatePath(`/patients/${patientId}`);
  revalidatePath("/patients");
}

export async function createPatientPackage(
  _prev: PatientPackageActionResult | null,
  formData: FormData,
): Promise<PatientPackageActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);

  const parsed = createPatientPackageSchema.safeParse({
    patient_id: formData.get("patient_id"),
    name: formData.get("name"),
    total_sessions: formData.get("total_sessions"),
    used_sessions: formData.get("used_sessions") ?? 0,
    price_per_session: formData.get("price_per_session"),
    notes: formData.get("notes"),
    department_id: formData.get("department_id"),
    service_id: formData.get("service_id"),
  });

  if (!parsed.success) {
    return { fieldErrors: await localizeZodFieldErrors(parsed.error) };
  }

  try {
    const patient = await getPatientForClinic(parsed.data.patient_id, user.clinicId);
    if (!patient) return { error: await actionError("patient-packages.patientNotFound") };

    const referenceError = await validateDepartmentAndService({
      clinicId: user.clinicId,
      departmentId: parsed.data.department_id,
      serviceId: parsed.data.service_id,
    });
    if (referenceError) return referenceError;

    const supabase = await createClient();
    const { error } = await supabase.from("patient_packages").insert({
      clinic_id: user.clinicId,
      patient_id: parsed.data.patient_id,
      name: parsed.data.name,
      total_sessions: parsed.data.total_sessions,
      used_sessions: parsed.data.used_sessions,
      price_per_session: parsed.data.price_per_session,
      notes: parsed.data.notes,
      department_id: parsed.data.department_id,
      service_id: parsed.data.service_id,
      created_by: user.id,
      is_active: true,
    });

    if (error) return { error: await actionError("patient-packages.failedToCreatePackagePleaseTryAgain") };

    revalidatePatient(parsed.data.patient_id);
    return { success: true };
  } catch (error) {
    console.error("Patient package creation failed", { error });
    return { error: await actionError("patient-packages.unexpected") };
  }
}

export async function updatePatientPackage(
  _prev: PatientPackageActionResult | null,
  formData: FormData,
): Promise<PatientPackageActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);

  const parsed = updatePatientPackageSchema.safeParse({
    package_id: formData.get("package_id"),
    name: formData.get("name"),
    total_sessions: formData.get("total_sessions"),
    price_per_session: formData.get("price_per_session"),
    notes: formData.get("notes"),
    department_id: formData.get("department_id"),
    service_id: formData.get("service_id"),
    is_active: formData.get("is_active") === "true",
  });

  if (!parsed.success) {
    return { fieldErrors: await localizeZodFieldErrors(parsed.error) };
  }

  try {
    const pkg = await getPackageForClinic(parsed.data.package_id, user.clinicId);
    if (!pkg) return { error: await actionError("patient-packages.packageNotFound") };
    if (parsed.data.total_sessions < pkg.used_sessions) {
      return {
        fieldErrors: {
          total_sessions: [
            await actionError("patient-packages.totalSessionsBelowUsed", { used: pkg.used_sessions }),
          ],
        },
      };
    }

    const patient = await getPatientForClinic(pkg.patient_id, user.clinicId);
    if (!patient) return { error: await actionError("patient-packages.patientNotFound") };

    const referenceError = await validateDepartmentAndService({
      clinicId: user.clinicId,
      departmentId: parsed.data.department_id,
      serviceId: parsed.data.service_id,
    });
    if (referenceError) return referenceError;

    const supabase = await createClient();
    const { error } = await supabase
      .from("patient_packages")
      .update({
        name: parsed.data.name,
        total_sessions: parsed.data.total_sessions,
        price_per_session: parsed.data.price_per_session,
        notes: parsed.data.notes,
        department_id: parsed.data.department_id,
        service_id: parsed.data.service_id,
        is_active: parsed.data.is_active,
      })
      .eq("id", parsed.data.package_id)
      .eq("clinic_id", user.clinicId);

    if (error) return { error: await actionError("patient-packages.failedToUpdatePackagePleaseTryAgain") };

    revalidatePatient(pkg.patient_id);
    return { success: true };
  } catch (error) {
    console.error("Patient package update failed", { error });
    return { error: await actionError("patient-packages.unexpected") };
  }
}

export async function deactivatePatientPackage(
  _prev: PatientPackageActionResult | null,
  formData: FormData,
): Promise<PatientPackageActionResult> {
  const user = await requireMutationRole(["admin", "receptionist"]);

  const parsed = deactivatePatientPackageSchema.safeParse({
    package_id: formData.get("package_id"),
  });

  if (!parsed.success) {
    return { fieldErrors: await localizeZodFieldErrors(parsed.error) };
  }

  try {
    const pkg = await getPackageForClinic(parsed.data.package_id, user.clinicId);
    if (!pkg) return { error: await actionError("patient-packages.packageNotFound") };

    const patient = await getPatientForClinic(pkg.patient_id, user.clinicId);
    if (!patient) return { error: await actionError("patient-packages.patientNotFound") };

    const supabase = await createClient();
    const { error } = await supabase
      .from("patient_packages")
      .update({ is_active: false })
      .eq("id", parsed.data.package_id)
      .eq("clinic_id", user.clinicId);

    if (error) return { error: await actionError("patient-packages.failedToDeactivatePackagePleaseTryAgain") };

    revalidatePatient(pkg.patient_id);
    return { success: true };
  } catch (error) {
    console.error("Patient package deactivation failed", { error });
    return { error: await actionError("patient-packages.unexpected") };
  }
}
