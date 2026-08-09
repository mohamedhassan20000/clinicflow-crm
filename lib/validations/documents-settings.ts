import { z } from "zod";
import {
  DOCUMENT_CATALOG,
  type RegisteredDocumentTypeCode,
} from "@/lib/documents/catalog";
import { DOCUMENT_WATERMARK_MAX_LENGTH } from "@/lib/documents/settings-config";

/**
 * P7-9 — Documents Settings write contract. Mirrors the P7-0
 * `document_settings` column constraints so a rejected payload never reaches the
 * database (defense-in-depth), and never widens beyond the columns the settings
 * page owns (watermark / QR / numbering prefix + yearly reset / print options).
 */

const registeredDocumentTypeCode = z.custom<RegisteredDocumentTypeCode>(
  (value) => typeof value === "string" && Object.hasOwn(DOCUMENT_CATALOG, value),
  { message: "validation.invalidFormat" },
);

/** Matches the DB `document_settings_watermark_length` check (1..160 trimmed). */
const watermarkText = z
  .string()
  .trim()
  .max(DOCUMENT_WATERMARK_MAX_LENGTH, "validation.tooLong")
  .transform((value) => (value.length === 0 ? null : value))
  .nullable()
  .default(null);

/** Matches the DB `document_settings_prefix_format` check (^[A-Z][A-Z0-9-]{0,15}$). */
const numberingPrefix = z
  .string()
  .trim()
  .transform((value) => (value.length === 0 ? null : value))
  .nullable()
  .default(null)
  .refine((value) => value === null || /^[A-Z][A-Z0-9-]{0,15}$/.test(value), {
    message: "validation.invalidFormat",
  });

const printOptions = z
  .object({
    includeAttachments: z.boolean().optional(),
  })
  .strict()
  .default({});

export const documentSettingsInputSchema = z.object({
  /** null = the clinic-wide global default row; else a per-type override. */
  docType: registeredDocumentTypeCode.nullable(),
  watermarkEnabled: z.boolean().default(true),
  watermarkText,
  qrEnabled: z.boolean().default(true),
  numberingPrefix,
  numberingYearlyReset: z.boolean().default(true),
  printOptions,
});

export type DocumentSettingsInput = z.input<typeof documentSettingsInputSchema>;
export type DocumentSettingsValues = z.infer<typeof documentSettingsInputSchema>;

export const documentSettingsResetSchema = z.object({
  docType: registeredDocumentTypeCode.nullable(),
});
