import { z } from "zod";

const emptyToNull = (value: unknown) =>
  value === "" || value === "none" || value === undefined ? null : value;

const positiveInteger = (label: string) =>
  z.coerce
    .number({ message: `${label} must be a number` })
    .int(`${label} must be a whole number`)
    .positive(`${label} must be greater than 0`)
    .max(10000, `${label} is too large`);

const nonNegativeMoney = (label: string) =>
  z.preprocess(
    emptyToNull,
    z.coerce
      .number({ message: `${label} must be a number` })
      .min(0, `${label} cannot be negative`)
      .max(99999999.99, `${label} is too large`)
      .nullable(),
  );

const notes = z.preprocess(
  (value) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  },
  z.string().max(500, "Notes must be 500 characters or fewer").nullable(),
);

const basePackageTemplateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Template name is required")
    .max(120, "Template name must be 120 characters or fewer"),
  department_id: z.string().uuid("Select a department"),
  total_sessions: positiveInteger("Total sessions"),
  price_per_session: nonNegativeMoney("Price per session"),
  total_price: nonNegativeMoney("Total price"),
  notes,
});

export const createPackageTemplateSchema = basePackageTemplateSchema;

export const updatePackageTemplateSchema = basePackageTemplateSchema.extend({
  template_id: z.string().uuid("Invalid template"),
});

export const templateIdSchema = z.object({
  template_id: z.string().uuid("Invalid template"),
});

export type CreatePackageTemplateValues = z.infer<typeof createPackageTemplateSchema>;
export type UpdatePackageTemplateValues = z.infer<typeof updatePackageTemplateSchema>;
