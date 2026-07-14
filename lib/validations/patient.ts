import "@/lib/validations/error-map";
import { z } from "zod";
import { normalizePatientPhone } from "@/lib/patient-phone";

const optionalUuid = z.string().uuid().optional().nullable();

export const patientSchema = z.object({
  full_name: z
    .string()
    .min(2, "validation.tooSmall")
    .max(100, "validation.tooBig"),
  national_id: z
    .string()
    .min(5, "validation.tooSmall")
    .max(32, "validation.tooBig")
    .regex(/^[A-Za-z0-9]+$/, "validation.invalidFormat"),
  date_of_birth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "validation.invalidFormat")
    .refine((d) => {
      const date = new Date(d);
      const now = new Date();
      const minYear = new Date("1900-01-01");
      return date >= minYear && date <= now;
    }, "validation.invalidFormat"),
  phone: z
    .string()
    .min(1, "validation.tooSmall")
    .refine((value) => normalizePatientPhone(value) !== null, {
      message: "validation.validPhoneRequired",
    })
    .transform((value) => normalizePatientPhone(value)!),
  email: z.string().min(1, "validation.tooSmall").email("validation.invalidEmail"),
  blood_type: z
    .enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"])
    .optional()
    .nullable(),
  department_id: optionalUuid,
  assigned_doctor_id: optionalUuid,
  insurance_provider_id: optionalUuid,
});

export type PatientFormValues = z.infer<typeof patientSchema>;

export const medicalNoteSchema = z.object({
  patient_id: z.string().uuid(),
  note: z.string().min(1, "validation.tooSmall").max(5000, "validation.tooBig"),
});

export type MedicalNoteFormValues = z.infer<typeof medicalNoteSchema>;
