import "server-only";

import { z } from "zod";
import { getDocumentCatalogEntry } from "@/lib/documents/catalog";
import { inlineClinicLogo } from "@/lib/documents/assets";
import { resolveDateRange } from "@/lib/date-range";
import { createClient } from "@/lib/supabase/server";
import { getRevenueSummaryData } from "@/lib/reports/data";
import type { AuthedUser } from "@/lib/rbac";

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (value) => Number.isFinite(new Date(`${value}T00:00:00.000Z`).valueOf()),
  "Invalid calendar date",
);

export const revenueDocumentParamsSchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  doctorId: z.string().uuid().nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
}).refine((value) => value.from <= value.to, {
  message: "The start date must not be after the end date",
  path: ["to"],
});

const revenueSummarySchema = z.object({
  totalAmount: z.number(),
  primaryTotal: z.number(),
  secondaryTotal: z.number(),
  insuranceTotal: z.number(),
  depositTotal: z.number(),
  outstandingTotal: z.number(),
  settlementsTotal: z.number(),
  patientCollectedTotal: z.number(),
  grossTotal: z.number(),
  transactionCount: z.number(),
  settlementCount: z.number(),
  methodBreakdown: z.array(z.object({ method: z.string(), amount: z.number() })),
});

const revenueTransactionSchema = z.object({
  id: z.string().uuid(),
  paidAt: z.string(),
  patientName: z.string(),
  doctorName: z.string(),
  departmentName: z.string().nullable(),
  totalAmount: z.number(),
  primaryAmount: z.number(),
  secondaryAmount: z.number(),
  insuranceAmount: z.number(),
  depositAmount: z.number(),
  outstandingAmount: z.number(),
});

export const revenueDocumentSnapshotSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  range: z.object({
    from: isoDateSchema,
    to: isoDateSchema,
    start: z.string(),
    end: z.string(),
  }),
  filters: z.object({
    doctorId: z.string().uuid().nullable(),
    departmentId: z.string().uuid().nullable(),
  }),
  branding: z.object({
    name: z.string(),
    logoSrc: z.string().nullable(),
    address: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    website: z.string().nullable(),
    licenseNo: z.string().nullable(),
    taxId: z.string().nullable(),
    footerText: z.string().nullable(),
  }),
  format: z.object({
    currency: z.string(),
    timeZone: z.string(),
    timeFormat: z.enum(["12h", "24h"]),
  }),
  settings: z.object({
    watermark: z.string().nullable(),
    qrEnabled: z.boolean(),
    numberingPrefix: z.string(),
    numberingYearlyReset: z.boolean(),
    sequencePadding: z.number().int().min(1).max(12),
  }),
  summary: revenueSummarySchema,
  transactions: z.array(revenueTransactionSchema),
});

export type RevenueDocumentParams = z.infer<typeof revenueDocumentParamsSchema>;
export type RevenueDocumentSnapshot = z.infer<typeof revenueDocumentSnapshotSchema>;

type RelationName = { full_name?: string | null; name?: string | null } | null;
type TransactionRow = {
  id: string;
  paid_at: string | null;
  total_amount: number | null;
  paid_amount: number | null;
  secondary_amount: number | null;
  insurance_amount: number | null;
  deposit_amount: number | null;
  outstanding_amount: number | null;
  patient: RelationName;
  doctor: RelationName;
  department: RelationName;
};

function relationText(relation: RelationName, key: "full_name" | "name"): string {
  return relation?.[key]?.trim() || "—";
}

async function loadRevenueTransactions(
  user: AuthedUser,
  params: RevenueDocumentParams,
  range: ReturnType<typeof resolveDateRange>,
): Promise<RevenueDocumentSnapshot["transactions"]> {
  const supabase = await createClient();
  const pageSize = 1_000;
  const rows: TransactionRow[] = [];

  for (let offset = 0; ; offset += pageSize) {
    let query = supabase
      .from("appointments")
      .select(`
        id, paid_at, total_amount, paid_amount, secondary_amount,
        insurance_amount, deposit_amount, outstanding_amount,
        patient:patients!appointments_patient_id_fkey(full_name),
        doctor:profiles!appointments_doctor_id_fkey(full_name),
        department:departments!appointments_department_id_fkey(name)
      `)
      .eq("clinic_id", user.clinicId)
      .eq("status", "completed")
      .is("deleted_at", null)
      .gte("paid_at", range.start.toISOString())
      .lte("paid_at", range.end.toISOString())
      .order("paid_at", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (params.doctorId) query = query.eq("doctor_id", params.doctorId);
    if (params.departmentId) query = query.eq("department_id", params.departmentId);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as TransactionRow[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }

  return rows.map((row) => ({
    id: row.id,
    paidAt: row.paid_at ?? range.end.toISOString(),
    patientName: relationText(row.patient, "full_name"),
    doctorName: relationText(row.doctor, "full_name"),
    departmentName: row.department?.name?.trim() || null,
    totalAmount: Number(row.total_amount ?? 0),
    primaryAmount: Number(row.paid_amount ?? 0),
    secondaryAmount: Number(row.secondary_amount ?? 0),
    insuranceAmount: Number(row.insurance_amount ?? 0),
    depositAmount: Number(row.deposit_amount ?? 0),
    outstandingAmount: Number(row.outstanding_amount ?? 0),
  }));
}

export async function resolveRevenueDocumentSnapshot(
  user: AuthedUser,
  rawParams: RevenueDocumentParams,
  options: { inlineLogo?: boolean } = {},
): Promise<RevenueDocumentSnapshot> {
  const params = revenueDocumentParamsSchema.parse(rawParams);
  const range = resolveDateRange({
    preset: "custom",
    from: params.from,
    to: params.to,
  });
  const supabase = await createClient();
  const [clinicResult, settingsResult, summary, transactions] = await Promise.all([
    supabase
      .from("clinics")
      .select(
        "name, logo_url, address, phone, email, website, license_no, tax_id, document_footer, currency, timezone, time_format",
      )
      .eq("id", user.clinicId)
      .single(),
    supabase
      .from("document_settings")
      .select(
        "doc_type, watermark_enabled, watermark_text, qr_enabled, numbering_prefix, numbering_yearly_reset",
      )
      .eq("clinic_id", user.clinicId)
      .or("doc_type.is.null,doc_type.eq.REVENUE_REPORT"),
    getRevenueSummaryData(
      range,
      params.doctorId ?? null,
      params.departmentId ?? null,
    ),
    loadRevenueTransactions(user, params, range),
  ]);

  if (clinicResult.error || !clinicResult.data) {
    throw new Error(clinicResult.error?.message ?? "Clinic branding was not found");
  }
  if (settingsResult.error) throw new Error(settingsResult.error.message);

  const clinic = clinicResult.data;
  const rows = settingsResult.data ?? [];
  const typeSettings = rows.find((row) => row.doc_type === "REVENUE_REPORT");
  const globalSettings = rows.find((row) => row.doc_type === null);
  const effectiveSettings = typeSettings ?? globalSettings;
  const catalog = getDocumentCatalogEntry("REVENUE_REPORT");
  const watermarkEnabled = effectiveSettings?.watermark_enabled ?? true;
  const watermark = watermarkEnabled
    ? effectiveSettings?.watermark_text?.trim() || clinic.name
    : null;
  const logoSrc = options.inlineLogo
    ? await inlineClinicLogo(clinic.logo_url, user.clinicId)
    : clinic.logo_url;

  return revenueDocumentSnapshotSchema.parse({
    version: 1,
    generatedAt: new Date().toISOString(),
    range: {
      from: params.from,
      to: params.to,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
    },
    filters: {
      doctorId: params.doctorId ?? null,
      departmentId: params.departmentId ?? null,
    },
    branding: {
      name: clinic.name,
      logoSrc,
      address: clinic.address,
      phone: clinic.phone,
      email: clinic.email,
      website: clinic.website,
      licenseNo: clinic.license_no,
      taxId: clinic.tax_id,
      footerText: clinic.document_footer,
    },
    format: {
      currency: clinic.currency,
      timeZone: clinic.timezone,
      timeFormat: clinic.time_format === "12h" ? "12h" : "24h",
    },
    settings: {
      watermark,
      qrEnabled: effectiveSettings?.qr_enabled ?? true,
      numberingPrefix:
        typeSettings?.numbering_prefix?.trim()
        || globalSettings?.numbering_prefix?.trim()
        || catalog.numbering.prefix,
      numberingYearlyReset:
        effectiveSettings?.numbering_yearly_reset
        ?? catalog.numbering.yearlyReset,
      sequencePadding: catalog.numbering.sequencePadding,
    },
    summary,
    transactions,
  });
}

export function parseRevenueDocumentSnapshot(value: unknown): RevenueDocumentSnapshot {
  return revenueDocumentSnapshotSchema.parse(value);
}
