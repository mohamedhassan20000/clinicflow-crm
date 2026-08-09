import "server-only";

import { inlineClinicLogo } from "@/lib/documents/assets";
import { getDocumentCatalogEntry } from "@/lib/documents/catalog";
import {
  GENERIC_DOCUMENT_CODE,
  genericDocumentParamsSchema,
  genericDocumentSnapshotSchema,
  type GenericDocumentParams,
  type GenericDocumentSnapshot,
} from "@/lib/documents/generic-shared";
import type { AuthedUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";

/**
 * P7 Phase 4 — server-only resolver for the generic free-form ("Create document
 * from scratch") type. The authored title + block body arrive as params (no
 * source table); the resolver only frames them with the clinic branding/settings
 * the shared engine resolves for every other type. Client-safe schema/parsing
 * live in `@/lib/documents/generic-shared`.
 */

export {
  GENERIC_DOCUMENT_CODE,
  MAX_GENERIC_BLOCKS,
  MAX_GENERIC_BLOCK_LENGTH,
  MAX_GENERIC_TITLE_LENGTH,
  genericDocumentParamsSchema,
  genericDocumentSnapshotSchema,
  parseGenericBody,
  parseGenericDocumentSnapshot,
  type GenericDocumentBlock,
  type GenericDocumentParams,
  type GenericDocumentSnapshot,
} from "@/lib/documents/generic-shared";

export async function resolveGenericDocumentSnapshot(
  user: AuthedUser,
  rawParams: GenericDocumentParams,
  options: { inlineAssets?: boolean } = {},
): Promise<GenericDocumentSnapshot> {
  const params = genericDocumentParamsSchema.parse(rawParams);
  const supabase = await createClient();
  const [clinicResult, settingsResult] = await Promise.all([
    supabase.from("clinics").select(
      "name, logo_url, address, phone, email, website, license_no, tax_id, document_footer, timezone, time_format",
    ).eq("id", user.clinicId).single(),
    supabase.from("document_settings").select(
      "doc_type, watermark_enabled, watermark_text, qr_enabled, numbering_prefix, numbering_yearly_reset",
    ).eq("clinic_id", user.clinicId).or(`doc_type.is.null,doc_type.eq.${GENERIC_DOCUMENT_CODE}`),
  ]);
  if (clinicResult.error || !clinicResult.data) {
    throw new Error(clinicResult.error?.message ?? "Clinic not found");
  }
  if (settingsResult.error) throw new Error(settingsResult.error.message);
  const clinic = clinicResult.data;
  const typeSettings = (settingsResult.data ?? []).find((row) => row.doc_type === GENERIC_DOCUMENT_CODE);
  const globalSettings = (settingsResult.data ?? []).find((row) => row.doc_type === null);
  const effective = typeSettings ?? globalSettings;
  const catalog = getDocumentCatalogEntry(GENERIC_DOCUMENT_CODE);

  return genericDocumentSnapshotSchema.parse({
    version: 1,
    documentType: GENERIC_DOCUMENT_CODE,
    generatedAt: new Date().toISOString(),
    title: params.title,
    blocks: params.blocks,
    branding: {
      name: clinic.name,
      logoSrc: options.inlineAssets ? await inlineClinicLogo(clinic.logo_url, user.clinicId) : clinic.logo_url,
      address: clinic.address, phone: clinic.phone, email: clinic.email, website: clinic.website,
      licenseNo: clinic.license_no, taxId: clinic.tax_id, footerText: clinic.document_footer,
    },
    format: { timeZone: clinic.timezone, timeFormat: clinic.time_format === "12h" ? "12h" : "24h" },
    settings: {
      watermark: (effective?.watermark_enabled ?? true)
        ? effective?.watermark_text?.trim() || clinic.name : null,
      qrEnabled: effective?.qr_enabled ?? true,
      numberingPrefix: typeSettings?.numbering_prefix?.trim()
        || globalSettings?.numbering_prefix?.trim() || catalog.numbering.prefix,
      numberingYearlyReset: effective?.numbering_yearly_reset ?? catalog.numbering.yearlyReset,
      sequencePadding: catalog.numbering.sequencePadding,
    },
  });
}
