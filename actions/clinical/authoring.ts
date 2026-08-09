"use server";

import { createClient } from "@/lib/supabase/server";
import { requireClinicalRead } from "@/actions/clinical/_shared";
import type {
  ClinicalAppointmentOption,
  ClinicalDoctorOption,
  ClinicalPatientOption,
  DrugCatalogOption,
  LabTestCatalogOption,
} from "@/components/clinical/types";

export type ClinicalAuthoringOptions = {
  doctors: ClinicalDoctorOption[];
  patients: ClinicalPatientOption[];
  appointments: ClinicalAppointmentOption[];
  drugs: DrugCatalogOption[];
  labTests: LabTestCatalogOption[];
};

/**
 * P7-8 — the reference data the shared `components/clinical/*` authoring forms
 * need when the Central Document Factory launches administrative authoring
 * (any patient / responsible doctor / optional encounter, plus the clinic's
 * autocomplete catalogs). Everything is read through the RLS user client, so a
 * scoped clinical role only sees its own patients/encounters.
 */
export async function listClinicalAuthoringOptions(): Promise<ClinicalAuthoringOptions> {
  const user = await requireClinicalRead();
  const supabase = await createClient();

  const [doctors, patients, appointments, drugs, labTests] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name, department_id")
      .eq("clinic_id", user.clinicId)
      .eq("role", "doctor")
      .eq("is_active", true)
      .eq("is_deleted", false)
      .is("deleted_at", null)
      .order("full_name"),
    supabase
      .from("patients")
      .select("id, full_name, file_number")
      .eq("clinic_id", user.clinicId)
      .is("deleted_at", null)
      .order("full_name")
      .limit(500),
    supabase
      .from("appointments")
      .select("id, patient_id, scheduled_at")
      .eq("clinic_id", user.clinicId)
      .is("deleted_at", null)
      .order("scheduled_at", { ascending: false })
      .limit(300),
    supabase
      .from("drug_catalog")
      .select("id, name, form, strength, is_controlled, drug_catalog_departments(department_id)")
      .eq("clinic_id", user.clinicId)
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("lab_test_catalog")
      .select("id, name, lab_test_catalog_departments(department_id)")
      .eq("clinic_id", user.clinicId)
      .eq("is_active", true)
      .order("name"),
  ]);

  return {
    doctors: (doctors.data ?? []).map((row) => ({
      id: row.id,
      fullName: row.full_name,
      departmentId: row.department_id,
    })),
    patients: (patients.data ?? []).map((row) => ({
      id: row.id,
      fullName: row.full_name,
      fileNumber: row.file_number,
    })),
    appointments: (appointments.data ?? []).map((row) => ({
      id: row.id,
      patientId: row.patient_id,
      label: new Date(row.scheduled_at).toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    })),
    drugs: (drugs.data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      form: row.form,
      strength: row.strength,
      isControlled: row.is_controlled,
      departmentIds: (row.drug_catalog_departments ?? []).map((entry) => entry.department_id),
    })),
    labTests: (labTests.data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      departmentIds: (row.lab_test_catalog_departments ?? []).map((entry) => entry.department_id),
    })),
  };
}
