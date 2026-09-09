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

/**
 * An optional clinic-authored display name, in one language.
 *
 * Length only, and blank is normalised to null at the write (see
 * `stripBlankDisplayNames`) rather than here, so the form keeps working with a
 * plain string field. A check that tried to validate "is this really Arabic?"
 * would reject a clinic's own transliterated brand name.
 */
const optionalDisplayName = z
  .string()
  .max(120, "validation.tooBig")
  .optional()
  .nullable();

/**
 * One service line in a package.
 *
 * A package is a basket: zero, one or many services from the package's own
 * department, each with its own session count and its own price. The price
 * here is the clinic's *package* price — it is seeded from the service's
 * catalogue price when a person picks the service in the form, and from that
 * moment it is an independent number. Nothing recomputes it from the catalogue
 * and nothing writes it back to `services.price`.
 */
export const packageTemplateItemSchema = z.object({
  service_id: z.string().uuid("validation.invalidFormat"),
  sessions: z.coerce
    .number({ message: "validation.invalidFormat" })
    .int("validation.invalidType")
    .positive("validation.tooSmall")
    .max(10000, "validation.tooBig"),
  price_per_session: z.coerce
    .number({ message: "validation.invalidFormat" })
    .min(0, "validation.tooSmall")
    .max(99999999.99, "validation.tooBig"),
});

/**
 * The package's lines, in the order the clinic arranged them.
 *
 * Empty is valid and permanent: a department-only package is the ordinary
 * shape, every template that exists today is one, and none of them is being
 * migrated. The duplicate check mirrors the table's own
 * `package_template_items_service_once` unique constraint — two lines for one
 * service are two prices for the same thing, and the total would depend on
 * which was read first.
 */
const packageTemplateItems = z
  .array(packageTemplateItemSchema)
  .max(50, "validation.tooBig")
  .default([])
  .superRefine((items, ctx) => {
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (seen.has(item.service_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "validation.duplicateEntry",
          path: [index, "service_id"],
        });
      }
      seen.add(item.service_id);
    }
  });

/** sessions x price per session, to the cent. The only place this is defined. */
export function packageItemSubtotal(item: {
  sessions: number;
  price_per_session: number;
}): number {
  return Math.round(item.sessions * item.price_per_session * 100) / 100;
}

/**
 * The package's total: the sum of its line subtotals.
 *
 * Deterministic and one-directional. The lines are the input and this is the
 * output, so there is no cycle in which an edited total reprices a line that
 * then recomputes the total. A package with no lines has no derived total —
 * `null`, not zero — and falls back to whatever the clinic typed.
 */
export function packageItemsTotal(
  items: readonly { sessions: number; price_per_session: number }[],
): number | null {
  if (items.length === 0) return null;
  const total = items.reduce((sum, item) => sum + packageItemSubtotal(item), 0);
  return Math.round(total * 100) / 100;
}

/** The sessions a package contains, summed from its lines. */
export function packageItemsSessions(
  items: readonly { sessions: number }[],
): number | null {
  if (items.length === 0) return null;
  return items.reduce((sum, item) => sum + item.sessions, 0);
}

const basePackageTemplateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "validation.tooSmall")
    .max(120, "validation.tooBig"),
  department_id: z.string().uuid("validation.invalidFormat"),
  items: packageTemplateItems,
  total_sessions: positiveInteger("Total sessions"),
  price_per_session: nonNegativeMoney("Price per session"),
  total_price: nonNegativeMoney("Total price"),
  notes,
  // Patient-facing display names. `name` stays canonical and required; these
  // are what an Arabic or English conversation shows when the clinic has
  // authored one. Never generated.
  name_ar: optionalDisplayName,
  name_en: optionalDisplayName,
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
export type PackageTemplateItemValues = z.infer<typeof packageTemplateItemSchema>;
