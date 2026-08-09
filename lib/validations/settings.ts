import "@/lib/validations/error-map";
import { z } from "zod";
import { normalizePhone } from "@/lib/phone/registry";

const optionalPhone = z.string().optional().nullable().refine((value) => !value || normalizePhone(value), "validation.invalidFormat");

// ── Staff ────────────────────────────────────────────────────────────────────

const staffFields = {
  full_name: z.string().min(2, "validation.tooSmall").max(100),
  role: z.enum(["admin", "doctor", "receptionist", "manager", "assistant"], {
    error: "validation.required",
  }),
  department_id: z.string().uuid().optional().nullable(),
  // Assistant-only: the supervising doctors whose data scope this assistant may
  // read (union). Ignored for non-assistant roles. Drives DATA SCOPE only.
  supervising_doctor_ids: z.array(z.string().uuid()).optional(),
  phone: optionalPhone,
} as const;

function requireAssistantSupervisorIds<
  T extends { role: string; supervising_doctor_ids?: string[] },
>(data: T, ctx: z.RefinementCtx) {
  if (
    data.role === "assistant" &&
    (data.supervising_doctor_ids?.length ?? 0) === 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["supervising_doctor_ids"],
      message: "validation.required",
    });
  }
}

export const createStaffSchema = z.object({
  ...staffFields,
  email: z.string().email("validation.invalidEmail"),
  temporary_password: z
    .string()
    .min(8, "validation.tooSmall")
    .regex(/[A-Z]/, "validation.invalidFormat")
    .regex(/[0-9]/, "validation.invalidFormat"),
}).superRefine(requireAssistantSupervisorIds);

export const updateStaffSchema = z.object({
  ...staffFields,
  is_active: z.boolean(),
}).superRefine(requireAssistantSupervisorIds);

export const staffProfileSectionSchema = z.object({
  full_name: staffFields.full_name,
  phone: optionalPhone,
});

export type CreateStaffValues = z.infer<typeof createStaffSchema>;
export type UpdateStaffValues = z.infer<typeof updateStaffSchema>;
export type StaffProfileSectionValues = z.infer<typeof staffProfileSectionSchema>;

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

const optionalTrimmedText = (max: number) =>
  z.string().max(max).optional().nullable().transform((value) => value?.trim() || null);

const optionalEmail = z.string()
  .max(254)
  .optional()
  .nullable()
  .transform((value) => value?.trim() || null)
  .refine((value) => !value || z.string().email().safeParse(value).success, {
    message: "validation.invalidEmail",
  });

const optionalWebsite = z.string()
  .max(500)
  .optional()
  .nullable()
  .transform((value) => value?.trim() || null)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }, { message: "validation.invalidFormat" });

export const brandingMetadataJsonSchema = z.string()
  .max(16_384)
  .default("{}")
  .superRefine((value, ctx) => {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        ctx.addIssue({ code: "custom", message: "validation.invalidFormat" });
      }
    } catch {
      ctx.addIssue({ code: "custom", message: "validation.invalidFormat" });
    }
  });

export const clinicSchema = z.object({
  name: z.string().min(2, "validation.tooSmall").max(100),
  phone: optionalPhone,
  address: z.string().max(500).optional().nullable(),
  email: optionalEmail,
  website: optionalWebsite,
  license_no: optionalTrimmedText(120),
  tax_id: optionalTrimmedText(120),
  document_footer: optionalTrimmedText(500),
  branding_metadata: brandingMetadataJsonSchema,
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
