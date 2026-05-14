import { z } from "zod";

// ── Staff ────────────────────────────────────────────────────────────────────

export const createStaffSchema = z.object({
  full_name: z.string().min(2, "Name must be at least 2 characters").max(100),
  email: z.string().email("Invalid email address"),
  temporary_password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Password must contain an uppercase letter")
    .regex(/[0-9]/, "Password must contain a number"),
  role: z.enum(["admin", "doctor", "receptionist", "manager"], {
    error: "Select a role",
  }),
  department_id: z.string().uuid().optional().nullable(),
  phone: z.string().optional().nullable(),
});

export type CreateStaffValues = z.infer<typeof createStaffSchema>;

export const updateStaffSchema = z.object({
  full_name: z.string().min(2).max(100),
  role: z.enum(["admin", "doctor", "receptionist", "manager"]),
  department_id: z.string().uuid().optional().nullable(),
  phone: z.string().optional().nullable(),
  is_active: z.boolean(),
});

export type UpdateStaffValues = z.infer<typeof updateStaffSchema>;

// ── Department ───────────────────────────────────────────────────────────────

export const departmentSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(100),
  color: z
    .string()
    .regex(/^#([0-9a-fA-F]{6})$/, "Must be a valid hex color like #0D9488"),
  description: z.string().max(500).optional().nullable(),
});

export type DepartmentValues = z.infer<typeof departmentSchema>;

// ── Insurance ────────────────────────────────────────────────────────────────

export const insuranceSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(100),
  code: z.string().max(20).optional().nullable(),
});

export type InsuranceValues = z.infer<typeof insuranceSchema>;

// ── Clinic ───────────────────────────────────────────────────────────────────

export const clinicSchema = z.object({
  name: z.string().min(2, "Clinic name must be at least 2 characters").max(100),
  phone: z
    .string()
    .regex(/^(\+90|0)?\s?(\(?\d{3}\)?)\s?\d{3}\s?\d{2}\s?\d{2}$/, "Invalid Turkish phone number")
    .optional()
    .nullable()
    .or(z.literal("")),
  address: z.string().max(500).optional().nullable(),
  time_format: z.enum(["12h", "24h"]).default("24h"),
});

export type ClinicValues = z.infer<typeof clinicSchema>;

// ── Service ──────────────────────────────────────────────────────────────────

export const serviceSchema = z.object({
  department_id: z.string().uuid("Select a department"),
  name: z.string().min(2, "Name must be at least 2 characters").max(100),
  price: z
    .number({ message: "Enter a valid price" })
    .min(0, "Price cannot be negative"),
});

export type ServiceValues = z.infer<typeof serviceSchema>;

// ── Clinic working hours ──────────────────────────────────────────────────────

const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

export const clinicShiftSchema = z
  .object({
    shift_start: z.string().regex(timeRegex, "Invalid time format"),
    shift_end: z.string().regex(timeRegex, "Invalid time format"),
  })
  .refine((d) => d.shift_end > d.shift_start, {
    path: ["shift_end"],
    message: "End time must be after start time",
  });

export const clinicDayScheduleSchema = z.object({
  day_of_week: z.number().int().min(0).max(6),
  open: z.boolean(),
  shifts: z.array(clinicShiftSchema).max(2),
});

export const clinicWorkingHoursSchema = z.array(clinicDayScheduleSchema);
export type ClinicWorkingHoursValues = z.infer<typeof clinicWorkingHoursSchema>;

// ── Doctor schedule ───────────────────────────────────────────────────────────

export const doctorDayScheduleSchema = z
  .object({
    day_of_week: z.number().int().min(0).max(6),
    works: z.boolean(),
    start_time: z.string().regex(timeRegex, "Invalid time").optional().nullable(),
    end_time: z.string().regex(timeRegex, "Invalid time").optional().nullable(),
  })
  .refine(
    (d) =>
      !d.works ||
      (!!d.start_time && !!d.end_time && d.end_time > d.start_time),
    { path: ["end_time"], message: "Working days must have valid start and end times" },
  );

export const doctorScheduleSchema = z.array(doctorDayScheduleSchema);
export type DoctorScheduleValues = z.infer<typeof doctorScheduleSchema>;
