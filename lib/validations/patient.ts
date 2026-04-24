import { z } from "zod";

const TR_PHONE_REGEX = /^(\+90|0)?\s?(\(?\d{3}\)?)\s?\d{3}\s?\d{2}\s?\d{2}$/;

export const patientSchema = z.object({
  full_name: z
    .string()
    .min(2, "Name must be at least 2 characters")
    .max(100, "Name too long"),
  national_id: z
    .string()
    .min(5, "National ID is required")
    .max(32, "National ID too long")
    .regex(/^[A-Za-z0-9]+$/, "National ID must be letters or digits only"),
  date_of_birth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format")
    .refine((d) => {
      const date = new Date(d);
      const now = new Date();
      const minYear = new Date("1900-01-01");
      return date >= minYear && date <= now;
    }, "Date of birth must be between 1900 and today"),
  phone: z
    .string()
    .min(1, "Phone is required")
    .regex(TR_PHONE_REGEX, "Enter a valid Turkish phone number"),
  email: z.string().min(1, "Email is required").email("Enter a valid email"),
  blood_type: z
    .enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"])
    .optional()
    .nullable(),
  department_id: z.string().uuid().optional().nullable(),
  assigned_doctor_id: z.string().uuid().optional().nullable(),
});

export type PatientFormValues = z.infer<typeof patientSchema>;

export const medicalNoteSchema = z.object({
  patient_id: z.string().uuid(),
  note: z.string().min(1, "Note cannot be empty").max(5000, "Note too long"),
});

export type MedicalNoteFormValues = z.infer<typeof medicalNoteSchema>;
