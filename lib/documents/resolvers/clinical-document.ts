import "server-only";

import { z } from "zod";
import { inlineClinicLogo, inlineClinicianSignature } from "@/lib/documents/assets";
import { getDocumentCatalogEntry } from "@/lib/documents/catalog";
import type { AuthedUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";

export const P76_CLINICAL_DOCUMENT_CODES = [
  "PRESCRIPTION", "LAB_REQUEST", "SICK_LEAVE_CERTIFICATE",
] as const;
export type P76ClinicalDocumentCode = typeof P76_CLINICAL_DOCUMENT_CODES[number];

const documentTypeSchema = z.enum(P76_CLINICAL_DOCUMENT_CODES);
export const clinicalDocumentParamsSchema = z.object({
  documentType: documentTypeSchema,
  recordId: z.string().uuid(),
});

const nullableText = z.string().nullable();
const brandingSchema = z.object({
  name: z.string(), logoSrc: nullableText, address: nullableText, phone: nullableText,
  email: nullableText, website: nullableText, licenseNo: nullableText, taxId: nullableText,
  footerText: nullableText,
});
const settingsSchema = z.object({
  watermark: nullableText, qrEnabled: z.boolean(), numberingPrefix: z.string(),
  numberingYearlyReset: z.boolean(), sequencePadding: z.number().int().min(1).max(12),
});
const subjectSchema = z.object({
  patientId: z.string().uuid().nullable(), fullName: z.string(), dateOfBirth: nullableText,
  nationalId: nullableText, fileNumber: nullableText, phone: nullableText, bloodType: nullableText,
});
const physicianSchema = z.object({
  id: z.string().uuid(), fullName: z.string(), professionalLicenseNo: nullableText,
  specialty: nullableText, professionalTitle: nullableText, departmentName: nullableText,
  signatureSrc: nullableText,
});
const commonRecord = {
  id: z.string().uuid(), appointmentId: z.string().uuid().nullable(), createdAt: z.string(),
  finalizedAt: nullableText, createdBy: z.object({ id: z.string().uuid(), fullName: z.string() }),
};
const dataSchema = z.discriminatedUnion("kind", [
  z.object({ ...commonRecord, kind: z.literal("prescription"), validUntil: nullableText,
    notes: nullableText, medications: z.array(z.object({ id: z.string().uuid(), drugName: z.string(),
      dose: nullableText, frequency: nullableText, duration: nullableText, route: nullableText,
      quantity: nullableText, instructions: nullableText, isControlled: z.boolean() })) }),
  z.object({ ...commonRecord, kind: z.literal("lab-request"), priority: z.enum(["routine", "urgent", "stat"]),
    laboratoryName: nullableText, clinicalContext: nullableText, instructions: nullableText,
    tests: z.array(z.object({ id: z.string().uuid(), testName: z.string(), notes: nullableText })) }),
  z.object({ ...commonRecord, kind: z.literal("sick-leave"), leaveStartDate: z.string(),
    leaveEndDate: z.string(), recipientOrganization: nullableText, recipientReference: nullableText,
    restrictions: nullableText, returnDate: nullableText }),
]);

export const clinicalDocumentSnapshotSchema = z.object({
  version: z.literal(1), documentType: documentTypeSchema, generatedAt: z.string(),
  sourceRecordId: z.string().uuid(), subject: subjectSchema, physician: physicianSchema,
  branding: brandingSchema,
  format: z.object({ timeZone: z.string(), timeFormat: z.enum(["12h", "24h"]) }),
  settings: settingsSchema, data: dataSchema,
});
export type ClinicalDocumentParams = z.infer<typeof clinicalDocumentParamsSchema>;
export type ClinicalDocumentSnapshot = z.infer<typeof clinicalDocumentSnapshotSchema>;

function text(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

export function mapClinicalCreatorProfile(profile: {
  id: string;
  full_name: string | null;
}): { id: string; fullName: string } {
  const fullName = text(profile.full_name);
  if (!fullName) {
    throw new Error("Clinical document preparer is missing a display name");
  }
  return { id: profile.id, fullName };
}

type ClinicalSnapshotOptions = { allowDraft?: boolean };

async function loadRecord(
  user: AuthedUser,
  params: ClinicalDocumentParams,
  options: ClinicalSnapshotOptions,
) {
  const supabase = await createClient();
  const allowedStatuses = options.allowDraft ? ["draft", "finalized"] : ["finalized"];
  if (params.documentType === "PRESCRIPTION") {
    const { data, error } = await supabase.from("prescriptions")
      .select("*, prescription_medications(*)")
      .eq("clinic_id", user.clinicId).eq("id", params.recordId).in("status", allowedStatuses)
      .order("sort_order", { referencedTable: "prescription_medications" }).maybeSingle();
    if (error || !data || (!options.allowDraft && !data.finalized_at)) {
      throw new Error(error?.message ?? "Prescription not found");
    }
    return { header: data, data: { kind: "prescription" as const, id: data.id,
      appointmentId: data.appointment_id, createdAt: data.created_at, finalizedAt: data.finalized_at,
      validUntil: data.valid_until, notes: text(data.notes), medications: data.prescription_medications.map((item) => ({
        id: item.id, drugName: item.drug_name, dose: text(item.dose), frequency: text(item.frequency),
        duration: text(item.duration), route: text(item.route), quantity: text(item.quantity),
        instructions: text(item.instructions), isControlled: item.is_controlled_snapshot,
      })) } };
  }
  if (params.documentType === "LAB_REQUEST") {
    const { data, error } = await supabase.from("lab_requests")
      .select("*, lab_request_tests(*)")
      .eq("clinic_id", user.clinicId).eq("id", params.recordId).in("status", allowedStatuses)
      .order("sort_order", { referencedTable: "lab_request_tests" }).maybeSingle();
    if (error || !data || (!options.allowDraft && !data.finalized_at)) {
      throw new Error(error?.message ?? "Lab request not found");
    }
    return { header: data, data: { kind: "lab-request" as const, id: data.id,
      appointmentId: data.appointment_id, createdAt: data.created_at, finalizedAt: data.finalized_at,
      priority: data.priority as "routine" | "urgent" | "stat", laboratoryName: text(data.laboratory_name),
      clinicalContext: text(data.clinical_context), instructions: text(data.instructions),
      tests: data.lab_request_tests.map((item) => ({ id: item.id, testName: item.test_name, notes: text(item.notes) })) } };
  }
  const { data, error } = await supabase.from("sick_leaves").select("*")
    .eq("clinic_id", user.clinicId).eq("id", params.recordId).in("status", allowedStatuses).maybeSingle();
  if (error || !data || (!options.allowDraft && !data.finalized_at)) {
    throw new Error(error?.message ?? "Sick leave not found");
  }
  return { header: data, data: { kind: "sick-leave" as const, id: data.id,
    appointmentId: data.appointment_id, createdAt: data.created_at, finalizedAt: data.finalized_at,
    leaveStartDate: data.leave_start_date, leaveEndDate: data.leave_end_date,
    recipientOrganization: text(data.recipient_organization), recipientReference: text(data.recipient_reference),
    restrictions: text(data.restrictions), returnDate: data.return_date } };
}

export async function resolveClinicalDocumentSnapshot(
  user: AuthedUser,
  rawParams: ClinicalDocumentParams,
  options: ClinicalSnapshotOptions = {},
): Promise<ClinicalDocumentSnapshot> {
  const params = clinicalDocumentParamsSchema.parse(rawParams);
  const supabase = await createClient();
  const record = await loadRecord(user, params, options);
  const [clinicResult, settingsResult, doctorResult, patientResult, creatorResult] = await Promise.all([
    supabase.from("clinics").select("name, logo_url, address, phone, email, website, license_no, tax_id, document_footer, timezone, time_format")
      .eq("id", user.clinicId).single(),
    supabase.from("document_settings").select("doc_type, watermark_enabled, watermark_text, qr_enabled, numbering_prefix, numbering_yearly_reset")
      .eq("clinic_id", user.clinicId).or(`doc_type.is.null,doc_type.eq.${params.documentType}`),
    supabase.from("profiles").select("id, full_name, department_id, professional_license_no, specialty, professional_title, signature_path")
      .eq("clinic_id", user.clinicId).eq("id", record.header.responsible_doctor_id).eq("role", "doctor").single(),
    record.header.patient_id ? supabase.from("patients").select("id, full_name, date_of_birth, national_id, file_number, phone, blood_type")
      .eq("clinic_id", user.clinicId).eq("id", record.header.patient_id).single() : Promise.resolve({ data: null, error: null }),
    supabase.from("profiles").select("id, full_name").eq("clinic_id", user.clinicId).eq("id", record.header.created_by).single(),
  ]);
  if (clinicResult.error || !clinicResult.data) throw new Error(clinicResult.error?.message ?? "Clinic not found");
  if (settingsResult.error) throw new Error(settingsResult.error.message);
  if (doctorResult.error || !doctorResult.data) throw new Error(doctorResult.error?.message ?? "Physician not found");
  if (patientResult.error) throw new Error(patientResult.error.message);
  if (creatorResult.error || !creatorResult.data) throw new Error(creatorResult.error?.message ?? "Preparer not found");
  const clinic = clinicResult.data;
  const doctor = doctorResult.data;
  const patient = patientResult.data;
  const departmentResult = doctor.department_id
    ? await supabase.from("departments").select("name").eq("clinic_id", user.clinicId).eq("id", doctor.department_id).maybeSingle()
    : { data: null, error: null };
  if (departmentResult.error) throw new Error(departmentResult.error.message);
  const rows = settingsResult.data ?? [];
  const typeSettings = rows.find((row) => row.doc_type === params.documentType);
  const globalSettings = rows.find((row) => row.doc_type === null);
  const effective = typeSettings ?? globalSettings;
  const catalog = getDocumentCatalogEntry(params.documentType);
  const generatedAt = new Date().toISOString();
  return clinicalDocumentSnapshotSchema.parse({
    version: 1, documentType: params.documentType, generatedAt, sourceRecordId: params.recordId,
    subject: patient ? { patientId: patient.id, fullName: patient.full_name, dateOfBirth: patient.date_of_birth,
      nationalId: text(patient.national_id), fileNumber: text(patient.file_number), phone: text(patient.phone),
      bloodType: patient.blood_type } : { patientId: null, fullName: record.header.subject_full_name,
      dateOfBirth: record.header.subject_dob, nationalId: record.header.subject_national_id,
      fileNumber: null, phone: null, bloodType: null },
    physician: { id: doctor.id, fullName: doctor.full_name,
      professionalLicenseNo: text(doctor.professional_license_no), specialty: text(doctor.specialty),
      professionalTitle: text(doctor.professional_title), departmentName: text(departmentResult.data?.name),
      signatureSrc: await inlineClinicianSignature(doctor.signature_path, user.clinicId, doctor.id) },
    branding: { name: clinic.name, logoSrc: await inlineClinicLogo(clinic.logo_url, user.clinicId),
      address: clinic.address, phone: clinic.phone, email: clinic.email, website: clinic.website,
      licenseNo: clinic.license_no, taxId: clinic.tax_id, footerText: clinic.document_footer },
    format: { timeZone: clinic.timezone, timeFormat: clinic.time_format === "12h" ? "12h" : "24h" },
    settings: { watermark: (effective?.watermark_enabled ?? true)
      ? effective?.watermark_text?.trim() || clinic.name : null,
      qrEnabled: effective?.qr_enabled ?? true,
      numberingPrefix: typeSettings?.numbering_prefix?.trim() || globalSettings?.numbering_prefix?.trim()
        || catalog.numbering.prefix,
      numberingYearlyReset: effective?.numbering_yearly_reset ?? catalog.numbering.yearlyReset,
      sequencePadding: catalog.numbering.sequencePadding },
    data: { ...record.data, createdBy: mapClinicalCreatorProfile(creatorResult.data) },
  });
}

export function parseClinicalDocumentSnapshot(value: unknown): ClinicalDocumentSnapshot {
  return clinicalDocumentSnapshotSchema.parse(value);
}
