import "@/lib/validations/error-map";
import { z } from "zod";

const optionalText = (max: number) =>
  z.string().max(max).optional().nullable().transform((value) => value?.trim() || null);
const requiredText = (max: number) => z.string().trim().min(1).max(max);
const uuid = z.string().uuid("validation.invalidFormat");
const optionalUuid = uuid.optional().nullable();
const optionalDate = z.iso.date().optional().nullable();

export const clinicalRecordStatusSchema = z.enum(["draft", "finalized", "void"]);

export const clinicalSubjectSchema = z
  .object({
    patient_id: optionalUuid,
    subject_full_name: optionalText(200),
    subject_dob: optionalDate,
    subject_national_id: optionalText(120),
  })
  .superRefine((subject, ctx) => {
    const registered = Boolean(subject.patient_id);
    const external = Boolean(subject.subject_full_name);
    if (registered === external) {
      ctx.addIssue({
        code: "custom",
        path: ["patient_id"],
        message: "validation.clinicalSubjectRequired",
      });
    }
    if (registered && (subject.subject_dob || subject.subject_national_id)) {
      ctx.addIssue({
        code: "custom",
        path: ["subject_full_name"],
        message: "validation.clinicalSubjectExclusive",
      });
    }
  });

const clinicalHeaderFields = {
  responsible_doctor_id: uuid,
  appointment_id: optionalUuid,
  patient_id: optionalUuid,
  subject_full_name: optionalText(200),
  subject_dob: optionalDate,
  subject_national_id: optionalText(120),
} as const;

function validateSubject(
  value: {
    patient_id?: string | null;
    subject_full_name?: string | null;
    subject_dob?: string | null;
    subject_national_id?: string | null;
  },
  ctx: z.RefinementCtx,
) {
  const parsed = clinicalSubjectSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  }
}

export const prescriptionMedicationSchema = z.object({
  id: optionalUuid,
  drug_catalog_id: optionalUuid,
  drug_name: requiredText(200),
  dose: optionalText(120),
  frequency: optionalText(120),
  duration: optionalText(120),
  route: optionalText(120),
  quantity: optionalText(120),
  instructions: optionalText(2000),
  is_controlled_snapshot: z.boolean().default(false),
  sort_order: z.number().int().min(0).default(0),
});

export const prescriptionDraftSchema = z
  .object({
    ...clinicalHeaderFields,
    valid_until: optionalDate,
    notes: optionalText(5000),
    medications: z.array(prescriptionMedicationSchema).min(1).max(100),
  })
  .superRefine(validateSubject);

export const labRequestTestSchema = z.object({
  id: optionalUuid,
  lab_test_catalog_id: optionalUuid,
  test_name: requiredText(200),
  notes: optionalText(2000),
  sort_order: z.number().int().min(0).default(0),
});

export const labRequestDraftSchema = z
  .object({
    ...clinicalHeaderFields,
    priority: z.enum(["routine", "urgent", "stat"]).default("routine"),
    laboratory_name: optionalText(200),
    clinical_context: optionalText(5000),
    instructions: optionalText(5000),
    tests: z.array(labRequestTestSchema).min(1).max(100),
  })
  .superRefine(validateSubject);

export const sickLeaveDraftSchema = z
  .object({
    ...clinicalHeaderFields,
    leave_start_date: z.iso.date(),
    leave_end_date: z.iso.date(),
    recipient_organization: optionalText(200),
    recipient_reference: optionalText(200),
    restrictions: optionalText(5000),
    return_date: optionalDate,
  })
  .superRefine((value, ctx) => {
    validateSubject(value, ctx);
    // Registered patients require an appointment; external subjects (no patient)
    // may not carry one — an appointment belongs to a registered patient and the
    // tenant trigger would otherwise reject the patient⇄appointment mismatch.
    if (value.patient_id && !value.appointment_id) {
      ctx.addIssue({
        code: "custom",
        path: ["appointment_id"],
        message: "validation.appointmentRequiredForPatient",
      });
    }
    if (!value.patient_id && value.appointment_id) {
      ctx.addIssue({
        code: "custom",
        path: ["appointment_id"],
        message: "validation.appointmentRequiresPatient",
      });
    }
    if (value.leave_end_date < value.leave_start_date) {
      ctx.addIssue({ code: "custom", path: ["leave_end_date"], message: "validation.invalidDateRange" });
    }
    if (value.return_date && value.return_date <= value.leave_end_date) {
      ctx.addIssue({ code: "custom", path: ["return_date"], message: "validation.invalidDateRange" });
    }
  });

export const clinicalRecordIdSchema = uuid;

export const drugCatalogEntrySchema = z.object({
  id: optionalUuid,
  name: requiredText(200),
  form: optionalText(120),
  strength: optionalText(120),
  is_controlled: z.boolean().default(false),
  is_active: z.boolean().default(true),
  department_ids: z.array(uuid).max(100).default([]),
});

export const labTestCatalogEntrySchema = z.object({
  id: optionalUuid,
  name: requiredText(200),
  is_active: z.boolean().default(true),
  department_ids: z.array(uuid).max(100).default([]),
});

export const clinicianCredentialsSchema = z.object({
  professional_license_no: optionalText(120),
  specialty: optionalText(160),
  professional_title: optionalText(160),
});

export type PrescriptionDraftInput = z.infer<typeof prescriptionDraftSchema>;
export type PrescriptionMedicationInput = z.infer<typeof prescriptionMedicationSchema>;
export type LabRequestDraftInput = z.infer<typeof labRequestDraftSchema>;
export type LabRequestTestInput = z.infer<typeof labRequestTestSchema>;
export type SickLeaveDraftInput = z.infer<typeof sickLeaveDraftSchema>;
export type DrugCatalogEntryInput = z.infer<typeof drugCatalogEntrySchema>;
export type LabTestCatalogEntryInput = z.infer<typeof labTestCatalogEntrySchema>;
export type ClinicianCredentialsInput = z.infer<typeof clinicianCredentialsSchema>;
