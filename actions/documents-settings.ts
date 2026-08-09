"use server";

import { revalidatePath } from "next/cache";
import { actionError } from "@/lib/i18n/action-errors";
import { requireMutationRole, requireRole } from "@/lib/rbac";
import { isPrimaryClinicAdmin } from "@/lib/primary-admin";
import { createClient } from "@/lib/supabase/server";
import { loadClinicDocumentCounters } from "@/lib/supabase/admin";
import {
  DOCUMENT_CATALOG,
  type RegisteredDocumentTypeCode,
} from "@/lib/documents/catalog";
import {
  configurableDocumentTypeCodes,
  resolveEffectiveDocumentSettings,
  type DocumentPrintOptions,
  type EffectiveDocumentSettings,
  type StoredDocumentSettings,
} from "@/lib/documents/settings-config";
import {
  documentSettingsInputSchema,
  documentSettingsResetSchema,
  type DocumentSettingsInput,
} from "@/lib/validations/documents-settings";

export type DocumentSettingsActionResult = {
  error?: string;
  success?: boolean;
};

/** Which branding fields the shared document header/footer needs (doc 09 §1.5). */
export type BrandingCompletenessField =
  | "name"
  | "logo"
  | "address"
  | "phone"
  | "email"
  | "website"
  | "license"
  | "taxId"
  | "footer";

export type BrandingCompleteness = {
  fields: Record<BrandingCompletenessField, boolean>;
  /** Missing fields that block a fully-branded header/footer (name is required). */
  missingRequired: BrandingCompletenessField[];
  /** Tax/VAT specifically gates a compliant "Tax Invoice" (doc 09 §1.5). */
  taxIdMissing: boolean;
};

export type ClinicianCompletenessRow = {
  id: string;
  fullName: string;
  hasLicense: boolean;
  hasSpecialty: boolean;
  hasTitle: boolean;
  hasSignature: boolean;
  complete: boolean;
};

export type CatalogCompleteness = {
  drugCount: number;
  activeDrugCount: number;
  labTestCount: number;
  activeLabTestCount: number;
};

export type DocumentTypeSettingsView = EffectiveDocumentSettings & {
  code: RegisteredDocumentTypeCode;
  titleKey: string;
  archetype: string;
  /** The catalog fallback prefix, shown so admins see what an override replaces. */
  defaultPrefix: string;
  /** Live next sequence for the current period (yearly reset ⇒ current year). */
  nextSequence: number;
};

export type DocumentSettingsOverview = {
  branding: BrandingCompleteness;
  global: StoredDocumentSettings;
  types: DocumentTypeSettingsView[];
  clinicians: ClinicianCompletenessRow[];
  catalogs: CatalogCompleteness;
  verificationBaseUrl: string;
};

const GLOBAL_DEFAULT: StoredDocumentSettings = {
  docType: null,
  watermarkEnabled: true,
  watermarkText: null,
  qrEnabled: true,
  numberingPrefix: null,
  numberingYearlyReset: true,
  printOptions: {},
};

type SettingsRow = {
  doc_type: string | null;
  watermark_enabled: boolean;
  watermark_text: string | null;
  qr_enabled: boolean;
  numbering_prefix: string | null;
  numbering_yearly_reset: boolean;
  print_options: unknown;
};

function normalisePrintOptions(value: unknown): DocumentPrintOptions {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const row = value as Record<string, unknown>;
    return {
      includeAttachments:
        typeof row.includeAttachments === "boolean"
          ? row.includeAttachments
          : undefined,
    };
  }
  return {};
}

function toStored(row: SettingsRow): StoredDocumentSettings {
  return {
    docType: (row.doc_type as RegisteredDocumentTypeCode | null) ?? null,
    watermarkEnabled: row.watermark_enabled,
    watermarkText: row.watermark_text,
    qrEnabled: row.qr_enabled,
    numberingPrefix: row.numbering_prefix,
    numberingYearlyReset: row.numbering_yearly_reset,
    printOptions: normalisePrintOptions(row.print_options),
  };
}

/** The counter period key mirrors the numbering RPC: yearly reset ⇒ 'YYYY', else ''. */
function currentPeriodKey(yearlyReset: boolean): string {
  return yearlyReset ? String(new Date().getUTCFullYear()) : "";
}

async function requirePrimaryAdmin() {
  const user = await requireRole("admin");
  if (!(await isPrimaryClinicAdmin(user.id, user.clinicId))) {
    return {
      error: await actionError(
        "page-permissions.onlyThePrimaryClinicAdminCanCustomizePageVisibility",
      ),
    };
  }
  return { user };
}

/** Reads the whole Documents Settings surface. Primary-admin only. */
export async function getDocumentSettingsOverview(): Promise<
  { data?: DocumentSettingsOverview; error?: string }
> {
  const access = await requirePrimaryAdmin();
  if ("error" in access) return { error: access.error };
  const { user } = access;
  const supabase = await createClient();

  const [clinicResult, settingsResult, cliniciansResult, drugResult, labResult] =
    await Promise.all([
      supabase
        .from("clinics")
        .select("name, logo_url, address, phone, email, website, license_no, tax_id, document_footer")
        .eq("id", user.clinicId)
        .single(),
      supabase
        .from("document_settings")
        .select("doc_type, watermark_enabled, watermark_text, qr_enabled, numbering_prefix, numbering_yearly_reset, print_options")
        .eq("clinic_id", user.clinicId),
      supabase
        .from("profiles")
        .select("id, full_name, professional_license_no, specialty, professional_title, signature_path")
        .eq("clinic_id", user.clinicId)
        .eq("role", "doctor")
        .eq("is_active", true)
        .is("deleted_at", null)
        .order("full_name", { ascending: true }),
      supabase
        .from("drug_catalog")
        .select("id, is_active")
        .eq("clinic_id", user.clinicId),
      supabase
        .from("lab_test_catalog")
        .select("id, is_active")
        .eq("clinic_id", user.clinicId),
    ]);

  // Keep the user-facing message generic, but always log the real cause so
  // schema drift / RLS / missing-table failures are diagnosable server-side.
  // (drug/lab errors stay non-fatal — their counts simply degrade to zero.)
  if (
    clinicResult.error ||
    !clinicResult.data ||
    settingsResult.error ||
    cliniciansResult.error ||
    drugResult.error ||
    labResult.error
  ) {
    console.error("document_settings_overview_query_error", {
      clinicId: user.clinicId,
      clinicError: clinicResult.error?.message ?? null,
      settingsError: settingsResult.error?.message ?? null,
      cliniciansError: cliniciansResult.error?.message ?? null,
      drugError: drugResult.error?.message ?? null,
      labError: labResult.error?.message ?? null,
    });
  }

  if (clinicResult.error || !clinicResult.data) {
    return {
      error: await actionError(
        "page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain",
      ),
    };
  }
  if (settingsResult.error || cliniciansResult.error) {
    return {
      error: await actionError(
        "page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain",
      ),
    };
  }

  const rows = (settingsResult.data ?? []) as SettingsRow[];
  const global = rows.find((row) => row.doc_type === null);
  const globalStored = global ? toStored(global) : GLOBAL_DEFAULT;
  const byType = new Map<string, StoredDocumentSettings>();
  for (const row of rows) {
    if (row.doc_type !== null && Object.hasOwn(DOCUMENT_CATALOG, row.doc_type)) {
      byType.set(row.doc_type, toStored(row));
    }
  }

  // Counters are server-only; the primary-admin gate above authorizes this
  // reviewed metadata-only read for the numbering view (doc 09 §1.2).
  const countersResult = await loadClinicDocumentCounters(user.clinicId);
  const nextSeqByKey = new Map<string, number>();
  for (const row of countersResult.data ?? []) {
    nextSeqByKey.set(`${row.doc_type}::${row.period_key}`, row.next_seq);
  }

  const types: DocumentTypeSettingsView[] = configurableDocumentTypeCodes().map(
    (code) => {
      const catalog = DOCUMENT_CATALOG[code];
      const effective = resolveEffectiveDocumentSettings(
        code,
        globalStored,
        byType.get(code) ?? null,
      );
      const periodKey = currentPeriodKey(effective.numberingYearlyReset);
      return {
        ...effective,
        titleKey: catalog.titleKey,
        archetype: catalog.archetype,
        defaultPrefix: catalog.numbering.prefix,
        nextSequence: nextSeqByKey.get(`${code}::${periodKey}`) ?? 1,
      };
    },
  );

  const clinic = clinicResult.data;
  const brandingFields: Record<BrandingCompletenessField, boolean> = {
    name: Boolean(clinic.name?.trim()),
    logo: Boolean(clinic.logo_url),
    address: Boolean(clinic.address?.trim()),
    phone: Boolean(clinic.phone?.trim()),
    email: Boolean(clinic.email?.trim()),
    website: Boolean(clinic.website?.trim()),
    license: Boolean(clinic.license_no?.trim()),
    taxId: Boolean(clinic.tax_id?.trim()),
    footer: Boolean(clinic.document_footer?.trim()),
  };
  const branding: BrandingCompleteness = {
    fields: brandingFields,
    missingRequired: brandingFields.name ? [] : ["name"],
    taxIdMissing: !brandingFields.taxId,
  };

  const clinicians: ClinicianCompletenessRow[] = (cliniciansResult.data ?? []).map(
    (row) => {
      const hasLicense = Boolean(row.professional_license_no?.trim());
      const hasSpecialty = Boolean(row.specialty?.trim());
      const hasTitle = Boolean(row.professional_title?.trim());
      const hasSignature = Boolean(row.signature_path);
      return {
        id: row.id,
        fullName: row.full_name,
        hasLicense,
        hasSpecialty,
        hasTitle,
        hasSignature,
        // A clinical document needs the licence to render its credential block
        // and a signature/stamp (or the manual fallback) to be valid (doc 16 §6).
        complete: hasLicense && hasSignature,
      };
    },
  );

  const drugs = drugResult.data ?? [];
  const labs = labResult.data ?? [];
  const catalogs: CatalogCompleteness = {
    drugCount: drugs.length,
    activeDrugCount: drugs.filter((entry) => entry.is_active).length,
    labTestCount: labs.length,
    activeLabTestCount: labs.filter((entry) => entry.is_active).length,
  };

  return {
    data: {
      branding,
      global: globalStored,
      types,
      clinicians,
      catalogs,
      verificationBaseUrl: "clinicflow.fit/verify",
    },
  };
}

async function findSettingsRowId(
  clinicId: string,
  docType: RegisteredDocumentTypeCode | null,
): Promise<{ id: string | null; error: boolean }> {
  const supabase = await createClient();
  let query = supabase
    .from("document_settings")
    .select("id")
    .eq("clinic_id", clinicId);
  query = docType === null ? query.is("doc_type", null) : query.eq("doc_type", docType);
  const { data, error } = await query.maybeSingle();
  if (error) return { id: null, error: true };
  return { id: data?.id ?? null, error: false };
}

/** Upserts one settings row (global when docType is null; else a per-type override). */
export async function saveDocumentSettings(
  input: DocumentSettingsInput,
): Promise<DocumentSettingsActionResult> {
  const parsed = documentSettingsInputSchema.safeParse(input);
  if (!parsed.success) {
    return { error: await actionError("page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain") };
  }
  const user = await requireMutationRole("admin");
  if (!(await isPrimaryClinicAdmin(user.id, user.clinicId))) {
    return {
      error: await actionError(
        "page-permissions.onlyThePrimaryClinicAdminCanCustomizePageVisibility",
      ),
    };
  }

  const values = parsed.data;
  const supabase = await createClient();
  const payload = {
    watermark_enabled: values.watermarkEnabled,
    watermark_text: values.watermarkText,
    qr_enabled: values.qrEnabled,
    numbering_prefix: values.numberingPrefix,
    numbering_yearly_reset: values.numberingYearlyReset,
    print_options: values.printOptions,
    updated_by: user.id,
  };

  const existing = await findSettingsRowId(user.clinicId, values.docType);
  if (existing.error) {
    return { error: await actionError("page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain") };
  }

  const write = existing.id
    ? await supabase
        .from("document_settings")
        .update(payload)
        .eq("id", existing.id)
        .eq("clinic_id", user.clinicId)
    : await supabase.from("document_settings").insert({
        ...payload,
        clinic_id: user.clinicId,
        doc_type: values.docType,
      });

  if (write.error) {
    return { error: await actionError("page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain") };
  }

  revalidatePath("/settings/documents");
  return { success: true };
}

/** Removes a row so the type falls back to the global default / catalog default. */
export async function resetDocumentSettings(input: {
  docType: RegisteredDocumentTypeCode | null;
}): Promise<DocumentSettingsActionResult> {
  const parsed = documentSettingsResetSchema.safeParse(input);
  if (!parsed.success) {
    return { error: await actionError("page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain") };
  }
  const user = await requireMutationRole("admin");
  if (!(await isPrimaryClinicAdmin(user.id, user.clinicId))) {
    return {
      error: await actionError(
        "page-permissions.onlyThePrimaryClinicAdminCanCustomizePageVisibility",
      ),
    };
  }

  const supabase = await createClient();
  let query = supabase
    .from("document_settings")
    .delete()
    .eq("clinic_id", user.clinicId);
  query =
    parsed.data.docType === null
      ? query.is("doc_type", null)
      : query.eq("doc_type", parsed.data.docType);
  const { error } = await query;
  if (error) {
    return { error: await actionError("page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain") };
  }

  revalidatePath("/settings/documents");
  return { success: true };
}
