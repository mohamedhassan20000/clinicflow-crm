import {
  DOCUMENT_CATALOG,
  type DocumentCatalogEntry,
  type RegisteredDocumentTypeCode,
} from "@/lib/documents/catalog";
import { REGISTERED_DOCUMENT_TYPE_CODES } from "@/lib/documents/module";

/**
 * P7-9 — Documents Settings configuration model.
 *
 * Pure, dependency-free shapes + resolution helpers for the Documents Settings
 * surface. The at-issue authority for watermark/QR/numbering stays inside each
 * resolver (per-type override → clinic global default → catalog default, doc 09
 * §2); this module re-states the *same* resolution order for the settings UI's
 * "what will apply" preview, and never duplicates issuance business logic. A new
 * document type appears here automatically because the rows derive from
 * `DOCUMENT_CATALOG` — no per-type list is hardcoded.
 */

export const DOCUMENT_WATERMARK_MAX_LENGTH = 160;

/** Additive print options bag (doc 09 §1.4). Extensible without a schema change. */
export type DocumentPrintOptions = {
  /** Only Patient File / Staff File support attachment merge (catalog). */
  includeAttachments?: boolean;
};

/** One stored `document_settings` row, normalised to the app's camelCase shape. */
export type StoredDocumentSettings = {
  docType: RegisteredDocumentTypeCode | null;
  watermarkEnabled: boolean;
  watermarkText: string | null;
  qrEnabled: boolean;
  numberingPrefix: string | null;
  numberingYearlyReset: boolean;
  printOptions: DocumentPrintOptions;
};

/** The effective values that will apply to a type at issue time (display only). */
export type EffectiveDocumentSettings = {
  code: RegisteredDocumentTypeCode;
  /** null when the watermark is disabled; otherwise the text (empty ⇒ clinic name). */
  watermarkEnabled: boolean;
  watermarkText: string | null;
  qrEnabled: boolean;
  numberingPrefix: string;
  numberingYearlyReset: boolean;
  sequencePadding: number;
  supportsAttachments: boolean;
  includeAttachments: boolean;
  /** True when this type has a per-type override row (vs inheriting global/default). */
  hasOverride: boolean;
};

/** Codes shown in the settings table, in the catalog's registration order. */
export function configurableDocumentTypeCodes(): RegisteredDocumentTypeCode[] {
  return [...REGISTERED_DOCUMENT_TYPE_CODES];
}

function catalogFor(code: RegisteredDocumentTypeCode): DocumentCatalogEntry {
  return DOCUMENT_CATALOG[code];
}

/**
 * Resolve the effective settings for one type given the stored global default
 * and the type's own override, mirroring the resolver resolution order.
 */
export function resolveEffectiveDocumentSettings(
  code: RegisteredDocumentTypeCode,
  globalRow: StoredDocumentSettings | null,
  typeRow: StoredDocumentSettings | null,
): EffectiveDocumentSettings {
  const catalog = catalogFor(code);
  const effective = typeRow ?? globalRow;
  const numberingPrefix =
    typeRow?.numberingPrefix?.trim() ||
    globalRow?.numberingPrefix?.trim() ||
    catalog.numbering.prefix;
  return {
    code,
    watermarkEnabled: effective?.watermarkEnabled ?? true,
    watermarkText: effective?.watermarkText?.trim() || null,
    qrEnabled: effective?.qrEnabled ?? true,
    numberingPrefix,
    numberingYearlyReset:
      effective?.numberingYearlyReset ?? catalog.numbering.yearlyReset,
    sequencePadding: catalog.numbering.sequencePadding,
    supportsAttachments: catalog.supportsAttachments ?? false,
    includeAttachments:
      (catalog.supportsAttachments ?? false) &&
      (typeRow?.printOptions.includeAttachments ??
        globalRow?.printOptions.includeAttachments ??
        false),
    hasOverride: typeRow !== null,
  };
}
