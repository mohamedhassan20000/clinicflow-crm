import "server-only";

import { z } from "zod";
import { inlineClinicLogo } from "@/lib/documents/assets";
import { getDocumentCatalogEntry } from "@/lib/documents/catalog";
import type { AuthedUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import {
  computeBillingTotals,
  isClinicalDocumentType,
  loadAppointmentHistory,
  loadPatientDeposits,
  resolveHistoryRange,
} from "@/lib/patients/file-data";

/**
 * P7-12 — patient history & financial document resolvers.
 *
 * These four document types are patient-subject history/financial statements
 * (doc 16 §9). They introduce **no new financial schema and no new query
 * logic**: every read reuses the single shared P7-11 patient-file data layer
 * (`lib/patients/file-data.ts`) — the unified appointment-history query, the
 * derived deposit balance, and the audited billing computation — and freezes the
 * result into an immutable engine snapshot at issue time.
 *
 * Security is preserved exactly as P7-11 established it:
 * - The resolver reads through the caller's RLS-scoped client (`createClient`),
 *   so a doctor only ever resolves a patient they may access; an inaccessible
 *   patient fails closed (row not found → throw).
 * - Scoped clinical roles (doctor / assistant) never receive financial columns:
 *   `loadAppointmentHistory` is called with `isScopedClinical` and the two
 *   financial statement types are gated out entirely at the catalog `pageRoles`
 *   layer (admin / manager / receptionist only).
 */

export const P712_PATIENT_HISTORY_DOCUMENT_CODES = [
  "APPOINTMENT_HISTORY_REPORT",
  "PACKAGE_HISTORY_REPORT",
  "DEPOSIT_STATEMENT",
  "PATIENT_FINANCIAL_SUMMARY",
] as const;
export type P712PatientHistoryDocumentCode =
  (typeof P712_PATIENT_HISTORY_DOCUMENT_CODES)[number];

const documentTypeSchema = z.enum(P712_PATIENT_HISTORY_DOCUMENT_CODES);
const presetSchema = z
  .enum(["all", "last_week", "last_month", "last_year", "custom"])
  .nullable()
  .optional();

export const patientHistoryDocumentParamsSchema = z.object({
  documentType: documentTypeSchema,
  patientId: z.string().uuid(),
  preset: presetSchema,
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
});
export type PatientHistoryDocumentParams = z.infer<
  typeof patientHistoryDocumentParamsSchema
>;

const brandingSchema = z.object({
  name: z.string(),
  logoSrc: z.string().nullable(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  website: z.string().nullable(),
  licenseNo: z.string().nullable(),
  taxId: z.string().nullable(),
  footerText: z.string().nullable(),
});
const settingsSchema = z.object({
  watermark: z.string().nullable(),
  qrEnabled: z.boolean(),
  numberingPrefix: z.string(),
  numberingYearlyReset: z.boolean(),
  sequencePadding: z.number().int().min(1).max(12),
});
const patientHeaderSchema = z.object({
  fullName: z.string(),
  fileNumber: z.string().nullable(),
  phone: z.string().nullable(),
});
const rangeSchema = z.object({
  preset: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
});

// --- per-type body shapes -------------------------------------------------

const appointmentEntrySchema = z.object({
  id: z.string(),
  scheduledAt: z.string(),
  status: z.string(),
  doctorName: z.string(),
  departmentName: z.string(),
  followUps: z.array(
    z.object({
      outcome: z.string(),
      notes: z.string().nullable(),
      recordedAt: z.string(),
    }),
  ),
  note: z.string().nullable(),
  relatedDocuments: z.array(
    z.object({ docType: z.string(), documentNumber: z.string() }),
  ),
  billing: z
    .object({
      total: z.number(),
      collected: z.number(),
      outstanding: z.number(),
    })
    .nullable(),
});

const packageEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  departmentName: z.string(),
  purchasedSessions: z.number(),
  usedSessions: z.number(),
  remainingSessions: z.number(),
  pricePerSession: z.number().nullable(),
  isActive: z.boolean(),
  createdAt: z.string(),
});

const depositTransactionSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  amount: z.number(),
  note: z.string().nullable(),
  recordedByName: z.string().nullable(),
  runningBalance: z.number(),
});

const dataSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("appointment-history"),
    financialVisible: z.boolean(),
    totalCount: z.number(),
    entries: z.array(appointmentEntrySchema),
    billingTotals: z
      .object({
        billed: z.number(),
        collected: z.number(),
        outstanding: z.number(),
      })
      .nullable(),
  }),
  z.object({
    kind: z.literal("package-history"),
    packages: z.array(packageEntrySchema),
    totals: z.object({
      purchasedSessions: z.number(),
      usedSessions: z.number(),
      remainingSessions: z.number(),
    }),
  }),
  z.object({
    kind: z.literal("deposit-statement"),
    openingBalance: z.number(),
    currentBalance: z.number(),
    totalDeposited: z.number(),
    totalSpent: z.number(),
    transactions: z.array(depositTransactionSchema),
  }),
  z.object({
    kind: z.literal("financial-summary"),
    appointmentCharges: z.number(),
    payments: z.number(),
    outstanding: z.number(),
    depositsBalance: z.number(),
    totalDeposited: z.number(),
    packageBalance: z.number(),
    activePackages: z.number(),
  }),
]);

export const patientHistoryDocumentSnapshotSchema = z.object({
  version: z.literal(1),
  documentType: documentTypeSchema,
  generatedAt: z.string(),
  range: rangeSchema,
  branding: brandingSchema,
  format: z.object({
    currency: z.string(),
    timeZone: z.string(),
    timeFormat: z.enum(["12h", "24h"]),
  }),
  settings: settingsSchema,
  patient: patientHeaderSchema,
  data: dataSchema,
});
export type PatientHistoryDocumentSnapshot = z.infer<
  typeof patientHistoryDocumentSnapshotSchema
>;

const MAX_HISTORY_ROWS = 500;

function text(value: string | null | undefined, fallback = "—"): string {
  return value?.trim() || fallback;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isScopedClinicalRole(user: AuthedUser): boolean {
  return user.role === "doctor" || user.role === "assistant";
}

/** Enforce the doctor department/assignment access gate before resolving. */
async function loadPatientHeader(
  user: AuthedUser,
  patientId: string,
): Promise<z.infer<typeof patientHeaderSchema>> {
  const supabase = await createClient();
  const { data: patient, error } = await supabase
    .from("patients")
    .select(
      "id, full_name, file_number, phone, assigned_doctor_id, department_id",
    )
    .eq("id", patientId)
    .eq("clinic_id", user.clinicId)
    .single();
  if (error || !patient) throw new Error(error?.message ?? "Patient not found");
  if (user.role === "doctor") {
    const canAccess =
      patient.assigned_doctor_id === user.id ||
      (!!user.departmentId && patient.department_id === user.departmentId);
    if (!canAccess) throw new Error("Patient not found");
  }
  return {
    fullName: text(patient.full_name),
    fileNumber: patient.file_number?.trim() || null,
    phone: patient.phone?.trim() || null,
  };
}

async function loadAppointmentHistoryData(
  user: AuthedUser,
  params: PatientHistoryDocumentParams,
  range: { from: string | null; to: string | null },
): Promise<Extract<PatientHistoryDocumentSnapshot["data"], { kind: "appointment-history" }>> {
  const supabase = await createClient();
  const scoped = isScopedClinicalRole(user);
  const { entries, totalCount, settlementsByAppointment } =
    await loadAppointmentHistory(supabase, {
      clinicId: user.clinicId,
      patientId: params.patientId,
      isScopedClinical: scoped,
      from: range.from,
      to: range.to,
      limit: MAX_HISTORY_ROWS,
    });

  const rows = entries.map((entry) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = entry.appointment as any;
    const settlements = settlementsByAppointment.get(a.id) ?? [];
    const settled = settlements.reduce((sum, s) => sum + s.amount, 0);
    const billing =
      scoped || a.total_amount == null
        ? null
        : {
            total: round2(Number(a.total_amount ?? 0)),
            collected: round2(
              Number(a.paid_amount ?? 0) +
                Number(a.insurance_amount ?? 0) +
                Number(a.secondary_amount ?? 0) +
                Number(a.deposit_amount ?? 0) +
                settled,
            ),
            outstanding: round2(Math.max(0, Number(a.outstanding_amount ?? 0) - settled)),
          };
    return {
      id: a.id as string,
      scheduledAt: a.scheduled_at as string,
      status: a.status as string,
      doctorName: text(a.profiles?.full_name),
      departmentName: text(a.departments?.name),
      followUps: entry.followups.map((f) => ({
        outcome: f.outcome,
        notes: f.notes,
        recordedAt: f.recorded_at,
      })),
      note: entry.notes[0]?.note ?? null,
      relatedDocuments: entry.documents
        // Scoped clinical roles never see financial documents (defence in depth;
        // loadAppointmentHistory already filters these out).
        .filter((d) => !scoped || isClinicalDocumentType(d.docType))
        .map((d) => ({ docType: d.docType, documentNumber: d.documentNumber })),
      billing,
    };
  });

  // Account-wide billing totals over ALL completed appointments (not just the
  // in-range preview) — reuses the audited computation, non-scoped roles only.
  let billingTotals: Extract<
    PatientHistoryDocumentSnapshot["data"],
    { kind: "appointment-history" }
  >["billingTotals"] = null;
  if (!scoped) {
    const { data: amounts } = await supabase
      .from("appointments")
      .select(
        "status, total_amount, paid_amount, insurance_amount, secondary_amount, deposit_amount, outstanding_amount",
      )
      .eq("patient_id", params.patientId)
      .eq("clinic_id", user.clinicId)
      .is("deleted_at", null);
    const totals = computeBillingTotals(amounts ?? []);
    billingTotals = {
      billed: round2(totals.billed),
      collected: round2(totals.collected),
      outstanding: round2(totals.outstanding),
    };
  }

  return {
    kind: "appointment-history",
    financialVisible: !scoped,
    totalCount,
    entries: rows,
    billingTotals,
  };
}

async function loadPackageHistoryData(
  user: AuthedUser,
  params: PatientHistoryDocumentParams,
  range: { from: string | null; to: string | null },
): Promise<Extract<PatientHistoryDocumentSnapshot["data"], { kind: "package-history" }>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("patient_packages")
    .select(
      "id, name, total_sessions, used_sessions, price_per_session, is_active, created_at, departments(name)",
    )
    .eq("patient_id", params.patientId)
    .eq("clinic_id", user.clinicId)
    .order("is_active", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  const inRange = (created: string) => {
    if (range.from && created < `${range.from}T00:00:00.000Z`) return false;
    if (range.to && created > `${range.to}T23:59:59.999Z`) return false;
    return true;
  };

  const packages = (data ?? [])
    .filter((row) => inRange(row.created_at))
    .map((row) => {
      const purchased = Number(row.total_sessions ?? 0);
      const used = Number(row.used_sessions ?? 0);
      return {
        id: row.id,
        name: text(row.name),
        departmentName: text(
          (row.departments as { name?: string | null } | null)?.name,
        ),
        purchasedSessions: purchased,
        usedSessions: used,
        remainingSessions: Math.max(0, purchased - used),
        pricePerSession:
          row.price_per_session == null ? null : Number(row.price_per_session),
        isActive: !!row.is_active,
        createdAt: row.created_at,
      };
    });

  const totals = packages.reduce(
    (acc, p) => {
      acc.purchasedSessions += p.purchasedSessions;
      acc.usedSessions += p.usedSessions;
      acc.remainingSessions += p.remainingSessions;
      return acc;
    },
    { purchasedSessions: 0, usedSessions: 0, remainingSessions: 0 },
  );

  return { kind: "package-history", packages, totals };
}

async function loadDepositStatementData(
  user: AuthedUser,
  params: PatientHistoryDocumentParams,
  range: { from: string | null; to: string | null },
): Promise<Extract<PatientHistoryDocumentSnapshot["data"], { kind: "deposit-statement" }>> {
  const supabase = await createClient();
  const { state, transactions } = await loadPatientDeposits(supabase, {
    clinicId: user.clinicId,
    patientId: params.patientId,
    from: range.from,
    to: range.to,
  });

  // Statement lines oldest→newest with a running balance. The opening balance is
  // the current derived balance minus the sum of the in-range deposit lines so
  // the running balance closes on the current account balance.
  const ordered = [...transactions].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
  const inRangeDeposits = ordered.reduce((sum, t) => sum + t.amount, 0);
  const openingBalance = round2(state.accountBalance - inRangeDeposits);
  let running = openingBalance;
  const lines = ordered.map((t) => {
    running = round2(running + t.amount);
    return {
      id: t.id,
      createdAt: t.created_at,
      amount: round2(t.amount),
      note: t.note,
      recordedByName: t.recorded_by_name,
      runningBalance: running,
    };
  });

  return {
    kind: "deposit-statement",
    openingBalance,
    currentBalance: round2(state.accountBalance),
    totalDeposited: round2(state.totalDeposited),
    totalSpent: round2(state.totalSpent),
    transactions: lines,
  };
}

async function loadFinancialSummaryData(
  user: AuthedUser,
  params: PatientHistoryDocumentParams,
  range: { from: string | null; to: string | null },
): Promise<Extract<PatientHistoryDocumentSnapshot["data"], { kind: "financial-summary" }>> {
  const supabase = await createClient();
  const [amountsResult, depositsResult, packagesResult] = await Promise.all([
    (() => {
      let q = supabase
        .from("appointments")
        .select(
          "status, scheduled_at, total_amount, paid_amount, insurance_amount, secondary_amount, deposit_amount, outstanding_amount",
        )
        .eq("patient_id", params.patientId)
        .eq("clinic_id", user.clinicId)
        .is("deleted_at", null);
      if (range.from) q = q.gte("scheduled_at", `${range.from}T00:00:00.000Z`);
      if (range.to) q = q.lte("scheduled_at", `${range.to}T23:59:59.999Z`);
      return q;
    })(),
    loadPatientDeposits(supabase, {
      clinicId: user.clinicId,
      patientId: params.patientId,
    }),
    supabase
      .from("patient_packages")
      .select("total_sessions, used_sessions, price_per_session, is_active")
      .eq("patient_id", params.patientId)
      .eq("clinic_id", user.clinicId),
  ]);

  if (amountsResult.error) throw new Error(amountsResult.error.message);
  const totals = computeBillingTotals(amountsResult.data ?? []);
  const packageRows = packagesResult.data ?? [];
  const packageBalance = packageRows.reduce((sum, row) => {
    const remaining = Math.max(
      0,
      Number(row.total_sessions ?? 0) - Number(row.used_sessions ?? 0),
    );
    return sum + remaining * Number(row.price_per_session ?? 0);
  }, 0);
  const activePackages = packageRows.filter((row) => row.is_active).length;

  return {
    kind: "financial-summary",
    appointmentCharges: round2(totals.billed),
    payments: round2(totals.collected),
    outstanding: round2(totals.outstanding),
    depositsBalance: round2(depositsResult.state.accountBalance),
    totalDeposited: round2(depositsResult.state.totalDeposited),
    packageBalance: round2(packageBalance),
    activePackages,
  };
}

export async function resolvePatientHistoryDocumentSnapshot(
  user: AuthedUser,
  rawParams: PatientHistoryDocumentParams,
  options: { inlineAssets?: boolean } = {},
): Promise<PatientHistoryDocumentSnapshot> {
  const params = patientHistoryDocumentParamsSchema.parse(rawParams);
  const supabase = await createClient();
  const range = resolveHistoryRange({
    preset: params.preset,
    from: params.from,
    to: params.to,
  });

  const [patient, clinicResult, settingsResult, data] = await Promise.all([
    loadPatientHeader(user, params.patientId),
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
      .or(`doc_type.is.null,doc_type.eq.${params.documentType}`),
    params.documentType === "APPOINTMENT_HISTORY_REPORT"
      ? loadAppointmentHistoryData(user, params, range)
      : params.documentType === "PACKAGE_HISTORY_REPORT"
        ? loadPackageHistoryData(user, params, range)
        : params.documentType === "DEPOSIT_STATEMENT"
          ? loadDepositStatementData(user, params, range)
          : loadFinancialSummaryData(user, params, range),
  ]);

  if (clinicResult.error || !clinicResult.data) {
    throw new Error(clinicResult.error?.message ?? "Clinic branding was not found");
  }
  if (settingsResult.error) throw new Error(settingsResult.error.message);

  const clinic = clinicResult.data;
  const settingRows = settingsResult.data ?? [];
  const typeSettings = settingRows.find((row) => row.doc_type === params.documentType);
  const globalSettings = settingRows.find((row) => row.doc_type === null);
  const effective = typeSettings ?? globalSettings;
  const catalog = getDocumentCatalogEntry(params.documentType);
  const logoSrc = options.inlineAssets
    ? await inlineClinicLogo(clinic.logo_url, user.clinicId)
    : clinic.logo_url;

  return patientHistoryDocumentSnapshotSchema.parse({
    version: 1,
    documentType: params.documentType,
    generatedAt: new Date().toISOString(),
    range: { preset: range.preset, from: range.from, to: range.to },
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
      watermark: (effective?.watermark_enabled ?? true)
        ? effective?.watermark_text?.trim() || clinic.name
        : null,
      qrEnabled: effective?.qr_enabled ?? true,
      numberingPrefix:
        typeSettings?.numbering_prefix?.trim() ||
        globalSettings?.numbering_prefix?.trim() ||
        catalog.numbering.prefix,
      numberingYearlyReset:
        effective?.numbering_yearly_reset ?? catalog.numbering.yearlyReset,
      sequencePadding: catalog.numbering.sequencePadding,
    },
    patient,
    data,
  });
}

export function parsePatientHistoryDocumentSnapshot(
  value: unknown,
): PatientHistoryDocumentSnapshot {
  return patientHistoryDocumentSnapshotSchema.parse(value);
}
