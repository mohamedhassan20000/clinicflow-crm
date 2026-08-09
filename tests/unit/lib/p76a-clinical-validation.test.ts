import { describe, expect, it } from "vitest";
import {
  clinicianCredentialsSchema,
  drugCatalogEntrySchema,
  labRequestDraftSchema,
  prescriptionDraftSchema,
  sickLeaveDraftSchema,
} from "@/lib/validations/clinical";

const doctorId = "11111111-1111-4111-8111-111111111111";
const patientId = "22222222-2222-4222-8222-222222222222";
const appointmentId = "33333333-3333-4333-8333-333333333333";

describe("P7-6A shared clinical validation", () => {
  it("requires exactly one registered or external subject path", () => {
    const base = {
      responsible_doctor_id: doctorId,
      appointment_id: null,
      valid_until: null,
      notes: null,
      medications: [{ drug_name: "Amoxicillin", is_controlled_snapshot: false, sort_order: 0 }],
    };
    expect(prescriptionDraftSchema.safeParse({ ...base, patient_id: patientId }).success).toBe(true);
    expect(prescriptionDraftSchema.safeParse({ ...base, patient_id: null, subject_full_name: "External Person" }).success).toBe(true);
    expect(prescriptionDraftSchema.safeParse({ ...base, patient_id: patientId, subject_full_name: "Duplicate" }).success).toBe(false);
    expect(prescriptionDraftSchema.safeParse({ ...base, patient_id: null, subject_full_name: null }).success).toBe(false);
  });

  it("requires structured line items for prescription and lab drafts", () => {
    expect(prescriptionDraftSchema.safeParse({
      responsible_doctor_id: doctorId,
      patient_id: patientId,
      medications: [],
    }).success).toBe(false);
    expect(labRequestDraftSchema.safeParse({
      responsible_doctor_id: doctorId,
      patient_id: patientId,
      priority: "urgent",
      tests: [{ test_name: "CBC", sort_order: 0 }],
    }).success).toBe(true);
  });

  it("requires a linked appointment for registered patients and a valid leave interval", () => {
    const valid = {
      responsible_doctor_id: doctorId,
      patient_id: patientId,
      appointment_id: appointmentId,
      leave_start_date: "2026-08-02",
      leave_end_date: "2026-08-04",
      return_date: "2026-08-05",
    };
    expect(sickLeaveDraftSchema.safeParse(valid).success).toBe(true);
    expect(sickLeaveDraftSchema.safeParse({ ...valid, leave_end_date: "2026-08-01" }).success).toBe(false);
    // Registered patient without an appointment is rejected.
    expect(sickLeaveDraftSchema.safeParse({ ...valid, appointment_id: null }).success).toBe(false);
  });

  it("allows an external-subject sick leave with no appointment", () => {
    const external = {
      responsible_doctor_id: doctorId,
      patient_id: null,
      subject_full_name: "External Person",
      appointment_id: null,
      leave_start_date: "2026-08-02",
      leave_end_date: "2026-08-04",
    };
    expect(sickLeaveDraftSchema.safeParse(external).success).toBe(true);
    // External subject must still supply exactly one identity.
    expect(sickLeaveDraftSchema.safeParse({ ...external, subject_full_name: null }).success).toBe(false);
    // An external subject may not also carry an appointment (no registered patient to match).
    expect(
      sickLeaveDraftSchema.safeParse({ ...external, appointment_id: appointmentId }).success,
    ).toBe(false);
  });

  it("normalizes optional catalog and credential text", () => {
    expect(drugCatalogEntrySchema.parse({ name: " Aspirin ", form: " ", department_ids: [] })).toMatchObject({ name: "Aspirin", form: null });
    expect(clinicianCredentialsSchema.parse({ professional_license_no: " LIC-42 ", specialty: " " })).toMatchObject({ professional_license_no: "LIC-42", specialty: null });
  });
});
