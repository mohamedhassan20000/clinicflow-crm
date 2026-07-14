import "@/lib/validations/error-map";
import { z } from "zod";

const emptyToNull = (value: unknown) =>
  value === "" || value === "none" || value === undefined ? null : value;

const optionalUuid = z.preprocess(
  emptyToNull,
  z.string().uuid("validation.invalidFormat").nullable(),
);

const positiveInteger = (label: string) =>
  z.coerce
    .number({ message: "validation.invalidFormat" })
    .int("validation.invalidType")
    .positive("validation.tooSmall")
    .max(10000, "validation.tooBig");

const nonNegativeMoney = z.preprocess(
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

const basePackageSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "validation.tooSmall")
    .max(120, "validation.tooBig"),
  total_sessions: positiveInteger("Total sessions"),
  price_per_session: nonNegativeMoney,
  notes,
  department_id: optionalUuid,
  service_id: optionalUuid,
});

export const createPatientPackageSchema = basePackageSchema
  .extend({
    patient_id: z.string().uuid("validation.invalidFormat"),
    used_sessions: z.coerce
      .number({ message: "validation.invalidFormat" })
      .int("validation.invalidType")
      .min(0, "validation.tooSmall")
      .default(0),
  })
  .refine((value) => value.used_sessions <= value.total_sessions, {
    path: ["used_sessions"],
    message: "validation.invalidFormat",
  });

export const updatePatientPackageSchema = basePackageSchema.extend({
  package_id: z.string().uuid("validation.invalidFormat"),
  is_active: z.coerce.boolean(),
});

export const deactivatePatientPackageSchema = z.object({
  package_id: z.string().uuid("validation.invalidFormat"),
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
