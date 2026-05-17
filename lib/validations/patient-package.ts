import { z } from "zod";

const emptyToNull = (value: unknown) =>
  value === "" || value === "none" || value === undefined ? null : value;

const optionalUuid = z.preprocess(
  emptyToNull,
  z.string().uuid("Select a valid option").nullable(),
);

const positiveInteger = (label: string) =>
  z.coerce
    .number({ message: `${label} must be a number` })
    .int(`${label} must be a whole number`)
    .positive(`${label} must be greater than 0`)
    .max(10000, `${label} is too large`);

const nonNegativeMoney = z.preprocess(
  emptyToNull,
  z.coerce
    .number({ message: "Price per session must be a number" })
    .min(0, "Price per session cannot be negative")
    .max(99999999.99, "Price per session is too large")
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

const basePackageSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Package name is required")
    .max(120, "Package name must be 120 characters or fewer"),
  total_sessions: positiveInteger("Total sessions"),
  price_per_session: nonNegativeMoney,
  notes,
  department_id: optionalUuid,
  service_id: optionalUuid,
});

export const createPatientPackageSchema = basePackageSchema
  .extend({
    patient_id: z.string().uuid("Invalid patient"),
    used_sessions: z.coerce
      .number({ message: "Used sessions must be a number" })
      .int("Used sessions must be a whole number")
      .min(0, "Used sessions cannot be negative")
      .default(0),
  })
  .refine((value) => value.used_sessions <= value.total_sessions, {
    path: ["used_sessions"],
    message: "Used sessions cannot exceed total sessions",
  });

export const updatePatientPackageSchema = basePackageSchema.extend({
  package_id: z.string().uuid("Invalid package"),
  is_active: z.coerce.boolean(),
});

export const deactivatePatientPackageSchema = z.object({
  package_id: z.string().uuid("Invalid package"),
});

export type CreatePatientPackageValues = z.infer<
  typeof createPatientPackageSchema
>;
export type UpdatePatientPackageValues = z.infer<
  typeof updatePatientPackageSchema
>;
export type DeactivatePatientPackageValues = z.infer<
  typeof deactivatePatientPackageSchema
>;
