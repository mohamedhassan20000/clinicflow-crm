import "@/lib/validations/error-map";
import { z } from "zod";
import { normalizePhone } from "@/lib/phone/registry";
import {
  clinicShiftsOverlap,
  clockMinutes,
  MAX_ENABLED_SHIFT_TEMPLATES,
  mergeIntervals,
} from "@/lib/scheduling/clock";

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

/**
 * An optional clinic-authored display name, in one language.
 *
 * Length only. A check that tried to validate "is this really Arabic?" would
 * reject a clinic's own transliterated brand name.
 *
 * Blank is normalised to null at the write rather than here, so the resolver's
 * input and output types stay identical and the settings forms keep working
 * with a plain `Control` — and because an empty string and an unset name mean
 * the same thing to the reader either way (see
 * `lib/settings/display-names.ts`).
 */
const optionalDisplayName = (max: number) =>
  z.string().max(max).optional().nullable();

export const staffProfileSectionSchema = z.object({
  full_name: staffFields.full_name,
  phone: optionalPhone,
  // The name patients are shown, which is not always the legal full name above
  // — and, for an Arabic conversation about a doctor stored under a Latin-script
  // name, is the only way to show one without inventing it.
  display_name_ar: optionalDisplayName(120),
  display_name_en: optionalDisplayName(120),
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
  // Patient-facing display names. `name` stays canonical and required; these
  // are what an Arabic or English conversation shows when the clinic has
  // authored one. Never generated — see the migration's own note.
  name_ar: optionalDisplayName(120),
  name_en: optionalDisplayName(120),
});

export type DepartmentValues = z.infer<typeof departmentSchema>;

// ── Insurance ────────────────────────────────────────────────────────────────

export const insuranceSchema = z.object({
  name: z.string().min(2, "validation.tooSmall").max(100),
  code: z.string().max(20).optional().nullable(),
  // The insurer's name as patients read it, in each language. `name` above
  // stays the canonical record every claim, allocation and report speaks; these
  // are display only, are typed by a person at the clinic, and are never
  // generated — «أكسا» is a name somebody wrote, not a transliteration of AXA
  // this system produced.
  name_ar: optionalDisplayName(100),
  name_en: optionalDisplayName(100),
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
  name_ar: optionalDisplayName(160),
  name_en: optionalDisplayName(160),
});

export type ServiceValues = z.infer<typeof serviceSchema>;

// ── Clinic working hours ──────────────────────────────────────────────────────

const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

export const clinicShiftSchema = z
  .object({
    shift_start: z.string().regex(timeRegex, "validation.invalidFormat"),
    shift_end: z.string().regex(timeRegex, "validation.invalidFormat"),
  })
  .refine((d) => (clockMinutes(d.shift_end) ?? -1) > (clockMinutes(d.shift_start) ?? -1), {
    path: ["shift_end"],
    message: "validation.invalidFormat",
  });

export const clinicDayScheduleSchema = z
  .object({
    day_of_week: z.number().int().min(0).max(6),
    open: z.boolean(),
    shifts: z.array(clinicShiftSchema).max(2),
  })
  .superRefine((day, ctx) => {
    if (clinicShiftsOverlap(day.shifts)) {
      ctx.addIssue({
        code: "custom",
        path: ["shifts"],
        message: "validation.invalidFormat",
      });
    }
  });

export const clinicWorkingHoursSchema = z.array(clinicDayScheduleSchema);
export type ClinicWorkingHoursValues = z.infer<typeof clinicWorkingHoursSchema>;

// ── Staff shift templates ─────────────────────────────────────────────────────
// Reusable named staff shifts. Deliberately NOT clinic opening intervals:
// two templates may overlap (Morning 09:00–17:00 with Evening 15:00–22:00),
// so no overlap refinement is applied here.

export const staffShiftTemplateSchema = z
  .object({
    id: z.string().uuid().optional().nullable(),
    name: z.string().trim().min(1, "validation.required").max(60),
    start_time: z.string().regex(timeRegex, "validation.invalidFormat"),
    end_time: z.string().regex(timeRegex, "validation.invalidFormat"),
    is_enabled: z.boolean(),
    sort_order: z.number().int().min(0).max(99),
  })
  .refine((t) => (clockMinutes(t.end_time) ?? -1) > (clockMinutes(t.start_time) ?? -1), {
    path: ["end_time"],
    message: "validation.invalidFormat",
  });

export const staffShiftTemplatesSchema = z
  .array(staffShiftTemplateSchema)
  .max(10)
  .superRefine((templates, ctx) => {
    const enabled = templates.filter((t) => t.is_enabled);
    if (enabled.length > MAX_ENABLED_SHIFT_TEMPLATES) {
      ctx.addIssue({ code: "custom", message: "validation.invalidFormat" });
    }
    const names = new Set<string>();
    for (const template of templates) {
      const key = template.name.trim().toLocaleLowerCase();
      if (names.has(key)) {
        ctx.addIssue({ code: "custom", path: ["name"], message: "validation.invalidFormat" });
      }
      names.add(key);
    }
  });

export type StaffShiftTemplateValues = z.infer<typeof staffShiftTemplateSchema>;
export type StaffShiftTemplatesValues = StaffShiftTemplateValues[];

// ── Doctor schedule ───────────────────────────────────────────────────────────
// A staff day resolves to one or more concrete intervals. Templates are copied
// into these intervals at selection time; the scheduling engine never reads a
// template name, so renaming or re-timing a template cannot move a saved
// schedule (see docs — persistence model B).

export const doctorShiftIntervalSchema = z
  .object({
    start_time: z.string().regex(timeRegex, "validation.invalidFormat"),
    end_time: z.string().regex(timeRegex, "validation.invalidFormat"),
  })
  .refine((d) => (clockMinutes(d.end_time) ?? -1) > (clockMinutes(d.start_time) ?? -1), {
    path: ["end_time"],
    message: "validation.invalidFormat",
  });

export type DoctorShiftInterval = z.infer<typeof doctorShiftIntervalSchema>;

export type DoctorDayScheduleValue = {
  day_of_week: number;
  works: boolean;
  /** Outer bounds, kept so pre-P14 readers keep working. */
  start_time: string | null;
  end_time: string | null;
  /** Authoritative merged, disjoint intervals for the day. */
  intervals: DoctorShiftInterval[];
};

export type DoctorScheduleValues = DoctorDayScheduleValue[];

/** Accepts the legacy single-interval payload and the P14 intervals payload. */
export const doctorDayScheduleSchema = z
  .object({
    day_of_week: z.number().int().min(0).max(6),
    works: z.boolean(),
    start_time: z.string().regex(timeRegex, "validation.invalidFormat").optional().nullable(),
    end_time: z.string().regex(timeRegex, "validation.invalidFormat").optional().nullable(),
    intervals: z.array(doctorShiftIntervalSchema).max(4).optional(),
  })
  .superRefine((day, ctx) => {
    if (!day.works) return;
    const hasIntervals = (day.intervals?.length ?? 0) > 0;
    const hasLegacy =
      !!day.start_time &&
      !!day.end_time &&
      (clockMinutes(day.end_time) ?? -1) > (clockMinutes(day.start_time) ?? -1);
    if (!hasIntervals && !hasLegacy) {
      ctx.addIssue({ code: "custom", path: ["end_time"], message: "validation.invalidFormat" });
    }
  })
  .transform((day): DoctorDayScheduleValue => {
    if (!day.works) {
      return { day_of_week: day.day_of_week, works: false, start_time: null, end_time: null, intervals: [] };
    }
    const source =
      day.intervals && day.intervals.length > 0
        ? day.intervals
        : [{ start_time: day.start_time!, end_time: day.end_time! }];
    const merged = mergeIntervals(
      source.map((i) => ({ start: i.start_time, end: i.end_time })),
    ).map((i) => ({ start_time: i.start, end_time: i.end }));
    return {
      day_of_week: day.day_of_week,
      works: merged.length > 0,
      start_time: merged[0]?.start_time ?? null,
      end_time: merged.at(-1)?.end_time ?? null,
      intervals: merged,
    };
  });

export const doctorScheduleSchema = z.array(doctorDayScheduleSchema);
