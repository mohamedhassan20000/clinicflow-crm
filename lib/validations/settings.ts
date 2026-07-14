import "@/lib/validations/error-map";
import { z } from "zod";
import { normalizePhone } from "@/lib/phone/registry";

const optionalPhone = z.string().optional().nullable().refine((value) => !value || normalizePhone(value), "validation.invalidFormat");

// ── Staff ────────────────────────────────────────────────────────────────────

export const createStaffSchema = z.object({
  full_name: z.string().min(2, "validation.tooSmall").max(100),
  email: z.string().email("validation.invalidEmail"),
  temporary_password: z
    .string()
    .min(8, "validation.tooSmall")
    .regex(/[A-Z]/, "validation.invalidFormat")
    .regex(/[0-9]/, "validation.invalidFormat"),
  role: z.enum(["admin", "doctor", "receptionist", "manager"], {
    error: "validation.required",
  }),
  department_id: z.string().uuid().optional().nullable(),
  phone: optionalPhone,
});

export type CreateStaffValues = z.infer<typeof createStaffSchema>;

export const updateStaffSchema = z.object({
  full_name: z.string().min(2).max(100),
  role: z.enum(["admin", "doctor", "receptionist", "manager"]),
  department_id: z.string().uuid().optional().nullable(),
  phone: optionalPhone,
  is_active: z.boolean(),
});

export type UpdateStaffValues = z.infer<typeof updateStaffSchema>;

// ── Department ───────────────────────────────────────────────────────────────

export const departmentSchema = z.object({
  name: z.string().min(2, "validation.tooSmall").max(100),
  color: z
    .string()
    .regex(/^#([0-9a-fA-F]{6})$/, "validation.invalidFormat"),
  description: z.string().max(500).optional().nullable(),
});

export type DepartmentValues = z.infer<typeof departmentSchema>;

// ── Insurance ────────────────────────────────────────────────────────────────

export const insuranceSchema = z.object({
  name: z.string().min(2, "validation.tooSmall").max(100),
  code: z.string().max(20).optional().nullable(),
});

export type InsuranceValues = z.infer<typeof insuranceSchema>;

// ── Clinic ───────────────────────────────────────────────────────────────────

export const clinicSchema = z.object({
  name: z.string().min(2, "validation.tooSmall").max(100),
  phone: optionalPhone,
  address: z.string().max(500).optional().nullable(),
  time_format: z.enum(["12h", "24h"]).default("24h"),
});

export type ClinicValues = z.infer<typeof clinicSchema>;

// ── Service ──────────────────────────────────────────────────────────────────

export const serviceSchema = z.object({
  department_id: z.string().uuid("validation.invalidFormat"),
  name: z.string().min(2, "validation.tooSmall").max(100),
  price: z
    .number({ message: "validation.invalidFormat" })
    .min(0, "validation.tooSmall"),
});

export type ServiceValues = z.infer<typeof serviceSchema>;

// ── Clinic working hours ──────────────────────────────────────────────────────

const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

export const clinicShiftSchema = z
  .object({
    shift_start: z.string().regex(timeRegex, "validation.invalidFormat"),
    shift_end: z.string().regex(timeRegex, "validation.invalidFormat"),
  })
  .refine((d) => d.shift_end > d.shift_start, {
    path: ["shift_end"],
    message: "validation.invalidFormat",
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
    start_time: z.string().regex(timeRegex, "validation.invalidFormat").optional().nullable(),
    end_time: z.string().regex(timeRegex, "validation.invalidFormat").optional().nullable(),
  })
  .refine(
    (d) =>
      !d.works ||
      (!!d.start_time && !!d.end_time && d.end_time > d.start_time),
    { path: ["end_time"], message: "validation.invalidFormat" },
  );

export const doctorScheduleSchema = z.array(doctorDayScheduleSchema);
export type DoctorScheduleValues = z.infer<typeof doctorScheduleSchema>;
