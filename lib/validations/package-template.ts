import "@/lib/validations/error-map";
import { z } from "zod";

const emptyToNull = (value: unknown) =>
  value === "" || value === "none" || value === undefined ? null : value;

const positiveInteger = (label: string) =>
  z.coerce
    .number({ message: "validation.invalidFormat" })
    .int("validation.invalidType")
    .positive("validation.tooSmall")
    .max(10000, "validation.tooBig");

const nonNegativeMoney = (label: string) =>
  z.preprocess(
    emptyToNull,
    z.coerce
      .number({ message: "validation.invalidFormat" })
      .min(0, "validation.tooSmall")
      .max(99999999.99, "validation.tooBig")
      .nullable(),
  );

const notes = z.preprocess(
  (value) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  },
  z.string().max(500, "validation.tooBig").nullable(),
);

const basePackageTemplateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "validation.tooSmall")
    .max(120, "validation.tooBig"),
  department_id: z.string().uuid("validation.invalidFormat"),
  total_sessions: positiveInteger("Total sessions"),
  price_per_session: nonNegativeMoney("Price per session"),
  total_price: nonNegativeMoney("Total price"),
  notes,
});

export const createPackageTemplateSchema = basePackageTemplateSchema;

export const updatePackageTemplateSchema = basePackageTemplateSchema.extend({
  template_id: z.string().uuid("validation.invalidFormat"),
});

export const templateIdSchema = z.object({
  template_id: z.string().uuid("validation.invalidFormat"),
});

export type CreatePackageTemplateValues = z.infer<typeof createPackageTemplateSchema>;
export type UpdatePackageTemplateValues = z.infer<typeof updatePackageTemplateSchema>;
