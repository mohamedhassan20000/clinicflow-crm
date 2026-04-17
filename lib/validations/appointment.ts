import { z } from "zod";

export const appointmentSchema = z.object({
  patient_id: z.string().uuid("Select a patient"),
  doctor_id: z.string().uuid("Select a doctor"),
  department_id: z.string().uuid().optional().nullable(),
  scheduled_at: z
    .string()
    .min(1, "Select a date and time")
    .refine((v) => !isNaN(Date.parse(v)), "Invalid date/time"),
  duration_minutes: z.number().int().min(15).max(240).default(30),
  insurance_provider_id: z.string().uuid().optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});

export type AppointmentFormValues = z.infer<typeof appointmentSchema>;

export const STATUS_TRANSITIONS: Record<string, string[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["completed", "cancelled", "no_show"],
  completed: [],
  cancelled: [],
  no_show: [],
};
