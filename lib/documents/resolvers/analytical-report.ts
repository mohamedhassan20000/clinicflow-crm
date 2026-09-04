import "server-only";

import { z } from "zod";
import { inlineClinicLogo } from "@/lib/documents/assets";
import { getDocumentCatalogEntry } from "@/lib/documents/catalog";
import { resolveDateRange } from "@/lib/date-range";
import {
  getCancellationReportData,
  getDoctorPerformanceData,
  getNoShowReportData,
  getReceptionistPerformanceData,
} from "@/lib/reports/data";
import type { AuthedUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { resolveFollowupPatientIds } from "@/lib/followups/data";

export const P74_ANALYTICAL_DOCUMENT_CODES = [
  "FOLLOW_UP_PAGE_REPORT",
  "CANCELLATION_REPORT",
  "NO_SHOW_REPORT",
  "SALES_REPORT",
  "FOLLOW_UP_ANALYTICS_REPORT",
  "DOCTOR_PERFORMANCE_REPORT",
  "RECEPTIONIST_PERFORMANCE_REPORT",
] as const;

export type P74AnalyticalDocumentCode =
  (typeof P74_ANALYTICAL_DOCUMENT_CODES)[number];

const documentTypeSchema = z.enum(P74_ANALYTICAL_DOCUMENT_CODES);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (value) => Number.isFinite(new Date(`${value}T00:00:00.000Z`).valueOf()),
  "Invalid calendar date",
);

const followUpOutcomeParamSchema = z.enum(["all_fine", "has_problem", "no_response"]);
const followUpPatientFilterSchema = z.string().trim().min(1).max(200).nullable().optional();

export const analyticalDocumentParamsSchema = z.object({
  documentType: documentTypeSchema,
  from: isoDateSchema,
  to: isoDateSchema,
  doctorId: z.string().uuid().nullable().optional(),
  departmentId: z.string().uuid().nullable().optional(),
  receptionistId: z.string().uuid().nullable().optional(),
  outcome: followUpOutcomeParamSchema.nullable().optional(),
  patientQuery: followUpPatientFilterSchema,
  patientName: followUpPatientFilterSchema,
  patientFileNumber: followUpPatientFilterSchema,
  patientNationalId: followUpPatientFilterSchema,
  patientPhone: followUpPatientFilterSchema,
}).refine((value) => value.from <= value.to, {
  message: "The start date must not be after the end date",
  path: ["to"],
});

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

const followUpOutcomeSchema = z.enum(["all_fine", "has_problem", "no_response"]);
const cancellationSchema = z.object({
  kind: z.literal("cancellation"),
  totalAppointments: z.number(),
  cancelledCount: z.number(),
  cancellationRate: z.number(),
  replacedCount: z.number(),
  replacementRate: z.number(),
  byDoctor: z.array(z.object({
    doctorId: z.string(),
    doctorName: z.string(),
    total: z.number(),
    cancelled: z.number(),
    rate: z.number(),
  })),
  byReason: z.array(z.object({ reason: z.string(), count: z.number() })),
});
const noShowSchema = z.object({
  kind: z.literal("no-show"),
  totalAppointments: z.number(),
  noShowCount: z.number(),
  noShowRate: z.number(),
  replacedCount: z.number(),
  replacementRate: z.number(),
  byDoctor: z.array(z.object({
    doctorId: z.string(),
    doctorName: z.string(),
    total: z.number(),
    noShow: z.number(),
    rate: z.number(),
  })),
});
const salesSchema = z.object({
  kind: z.literal("sales"),
  serviceTotal: z.number(),
  primaryTotal: z.number(),
  secondaryTotal: z.number(),
  insuranceTotal: z.number(),
  depositTotal: z.number(),
  settlementTotal: z.number(),
  outstandingTotal: z.number(),
  collectedTotal: z.number(),
  transactionCount: z.number(),
  settlementCount: z.number(),
  paymentMethods: z.array(z.object({ method: z.string(), amount: z.number() })),
});
const followUpAnalyticsSchema = z.object({
  kind: z.literal("follow-up-analytics"),
  completedCount: z.number(),
  allFineCount: z.number(),
  hasProblemCount: z.number(),
  noResponseCount: z.number(),
  outcomes: z.array(z.object({
    outcome: followUpOutcomeSchema,
    count: z.number(),
    rate: z.number(),
  })),
});
const followUpPageSchema = z.object({
  kind: z.literal("follow-up-page"),
  pendingCount: z.number(),
  completedCount: z.number(),
  allFineCount: z.number(),
  hasProblemCount: z.number(),
  noResponseCount: z.number(),
  rows: z.array(z.object({
    id: z.string(),
    recordedAt: z.string(),
    outcome: followUpOutcomeSchema,
    notes: z.string().nullable(),
    patientName: z.string(),
    patientFileNumber: z.string().nullable(),
    doctorName: z.string(),
    departmentName: z.string().nullable(),
  })),
});
const doctorPerformanceSchema = z.object({
  kind: z.literal("doctor-performance"),
  doctors: z.array(z.object({
    doctorId: z.string(),
    doctorName: z.string(),
    departmentId: z.string().nullable(),
    sessions: z.number(),
    completed: z.number(),
    cancelled: z.number(),
    noShow: z.number(),
    uniquePatients: z.number(),
    revenue: z.number(),
    completionRate: z.number(),
    cancellationRate: z.number(),
    noShowRate: z.number(),
    deptPatientShare: z.number(),
    clinicPatientShare: z.number(),
    deptRevenueShare: z.number(),
    clinicRevenueShare: z.number(),
  })),
});
const receptionistPerformanceSchema = z.object({
  kind: z.literal("receptionist-performance"),
  receptionists: z.array(z.object({
    id: z.string(),
    name: z.string(),
    appointmentsBooked: z.number(),
    appointmentShare: z.number(),
    followupsHandled: z.number(),
    followupShare: z.number(),
  })),
});

const analyticalDataSchema = z.discriminatedUnion("kind", [
  followUpPageSchema,
  cancellationSchema,
  noShowSchema,
  salesSchema,
  followUpAnalyticsSchema,
  doctorPerformanceSchema,
  receptionistPerformanceSchema,
]);

export const analyticalDocumentSnapshotSchema = z.object({
  version: z.literal(1),
  documentType: documentTypeSchema,
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
    receptionistId: z.string().uuid().nullable(),
    // Back-compat: snapshots issued before follow-up outcome forwarding have no
    // `outcome` key; default to null so historical documents still parse.
    outcome: followUpOutcomeParamSchema.nullable().default(null),
    patientQuery: z.string().nullable().default(null),
    patientName: z.string().nullable().default(null),
    patientFileNumber: z.string().nullable().default(null),
    patientNationalId: z.string().nullable().default(null),
    patientPhone: z.string().nullable().default(null),
  }),
  branding: brandingSchema,
  format: z.object({
    currency: z.string(),
    timeZone: z.string(),
    timeFormat: z.enum(["12h", "24h"]),
  }),
  settings: settingsSchema,
  data: analyticalDataSchema,
});

export type AnalyticalDocumentParams = z.infer<typeof analyticalDocumentParamsSchema>;
export type AnalyticalDocumentSnapshot = z.infer<typeof analyticalDocumentSnapshotSchema>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function loadFollowUpPage(
  user: AuthedUser,
  range: ReturnType<typeof resolveDateRange>,
  params: AnalyticalDocumentParams,
) {
  const supabase = await createClient();
  const patientIds = await resolveFollowupPatientIds(user.clinicId, {
    query: params.patientQuery,
    name: params.patientName,
    fileNumber: params.patientFileNumber,
    nationalId: params.patientNationalId,
    phone: params.patientPhone,
  }, supabase);
  const { data, error } = await supabase.rpc("get_followups_dashboard", {
    p_start: range.start.toISOString(),
    p_end: range.end.toISOString(),
    p_department_id: params.departmentId ?? undefined,
    p_doctor_id: params.doctorId ?? undefined,
    p_patient_ids: patientIds ?? undefined,
    p_outcome: params.outcome ?? undefined,
    p_pending_limit: 0,
    p_done_limit: 1_000,
    p_done_offset: 0,
  });
  if (error) throw new Error(error.message);
  const payload = record(data);
  const summary = record(payload.summary);
  const done = Array.isArray(payload.done) ? payload.done : [];
  return followUpPageSchema.parse({
    kind: "follow-up-page",
    pendingCount: number(summary.pendingCount),
    completedCount: number(summary.completedCount),
    allFineCount: number(summary.allFineCount),
    hasProblemCount: number(summary.hasProblemCount),
    noResponseCount: number(summary.noResponseCount),
    rows: done.map((value) => {
      const row = record(value);
      const patient = record(row.patients);
      const appointment = record(row.appointment);
      const doctor = record(appointment.profiles);
      const department = record(appointment.departments);
      const outcome = followUpOutcomeSchema.safeParse(row.outcome);
      return {
        id: text(row.id),
        recordedAt: text(row.recorded_at, range.end.toISOString()),
        outcome: outcome.success ? outcome.data : "no_response",
        notes: nullableText(row.notes),
        patientName: text(patient.full_name),
        patientFileNumber: nullableText(patient.file_number),
        doctorName: text(doctor.full_name),
        departmentName: nullableText(department.name),
      };
    }),
  });
}

async function loadSales(range: ReturnType<typeof resolveDateRange>) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_document_sales_report", {
    p_start: range.start.toISOString(),
    p_end: range.end.toISOString(),
  });
  if (error) throw new Error(error.message);
  const row = record(data);
  const methods = Array.isArray(row.paymentMethods) ? row.paymentMethods : [];
  return salesSchema.parse({
    kind: "sales",
    serviceTotal: number(row.serviceTotal),
    primaryTotal: number(row.primaryTotal),
    secondaryTotal: number(row.secondaryTotal),
    insuranceTotal: number(row.insuranceTotal),
    depositTotal: number(row.depositTotal),
    settlementTotal: number(row.settlementTotal),
    outstandingTotal: number(row.outstandingTotal),
    collectedTotal: number(row.collectedTotal),
    transactionCount: number(row.transactionCount),
    settlementCount: number(row.settlementCount),
    paymentMethods: methods.map((value) => {
      const method = record(value);
      return { method: text(method.method, "other"), amount: number(method.amount) };
    }),
  });
}

async function loadFollowUpAnalytics(
  range: ReturnType<typeof resolveDateRange>,
  doctorId: string | null,
) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(
    "get_document_follow_up_analytics_report",
    {
      p_start: range.start.toISOString(),
      p_end: range.end.toISOString(),
      p_doctor_id: doctorId ?? undefined,
    },
  );
  if (error) throw new Error(error.message);
  const row = record(data);
  const outcomes = Array.isArray(row.outcomes) ? row.outcomes : [];
  return followUpAnalyticsSchema.parse({
    kind: "follow-up-analytics",
    completedCount: number(row.completedCount),
    allFineCount: number(row.allFineCount),
    hasProblemCount: number(row.hasProblemCount),
    noResponseCount: number(row.noResponseCount),
    outcomes: outcomes.map((value) => {
      const outcome = record(value);
      return {
        outcome: outcome.outcome,
        count: number(outcome.count),
        rate: number(outcome.rate),
      };
    }),
  });
}

async function loadAnalyticalData(
  user: AuthedUser,
  params: AnalyticalDocumentParams,
  range: ReturnType<typeof resolveDateRange>,
): Promise<AnalyticalDocumentSnapshot["data"]> {
  switch (params.documentType) {
    case "FOLLOW_UP_PAGE_REPORT":
      return loadFollowUpPage(user, range, params);
    case "CANCELLATION_REPORT": {
      const data = await getCancellationReportData(user, range, params.doctorId ?? null);
      return cancellationSchema.parse({ kind: "cancellation", ...data });
    }
    case "NO_SHOW_REPORT": {
      const data = await getNoShowReportData(range, params.doctorId ?? null);
      return noShowSchema.parse({ kind: "no-show", ...data });
    }
    case "SALES_REPORT":
      return loadSales(range);
    case "FOLLOW_UP_ANALYTICS_REPORT":
      return loadFollowUpAnalytics(range, params.doctorId ?? null);
    case "DOCTOR_PERFORMANCE_REPORT": {
      const data = await getDoctorPerformanceData(range, params.doctorId ?? null);
      const doctors = params.departmentId
        ? data.doctors.filter((doctor) => doctor.departmentId === params.departmentId)
        : data.doctors;
      return doctorPerformanceSchema.parse({ kind: "doctor-performance", doctors });
    }
    case "RECEPTIONIST_PERFORMANCE_REPORT": {
      const data = await getReceptionistPerformanceData(
        range,
        params.receptionistId ?? null,
      );
      return receptionistPerformanceSchema.parse({
        kind: "receptionist-performance",
        receptionists: data.receptionists,
      });
    }
  }
}

export async function resolveAnalyticalDocumentSnapshot(
  user: AuthedUser,
  rawParams: AnalyticalDocumentParams,
): Promise<AnalyticalDocumentSnapshot> {
  const params = analyticalDocumentParamsSchema.parse(rawParams);
  const range = resolveDateRange({ preset: "custom", from: params.from, to: params.to });
  const supabase = await createClient();
  const [clinicResult, settingsResult, data] = await Promise.all([
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
    loadAnalyticalData(user, params, range),
  ]);

  if (clinicResult.error || !clinicResult.data) {
    throw new Error(clinicResult.error?.message ?? "Clinic branding was not found");
  }
  if (settingsResult.error) throw new Error(settingsResult.error.message);

  const clinic = clinicResult.data;
  const settingsRows = settingsResult.data ?? [];
  const typeSettings = settingsRows.find((row) => row.doc_type === params.documentType);
  const globalSettings = settingsRows.find((row) => row.doc_type === null);
  const effectiveSettings = typeSettings ?? globalSettings;
  const catalog = getDocumentCatalogEntry(params.documentType);
  const watermarkEnabled = effectiveSettings?.watermark_enabled ?? true;
  // Always inlined: the canonical PDF renderer blocks remote requests, so a
  // snapshot holding an `https:` logo URL prints with no logo at all.
  const logoSrc = await inlineClinicLogo(clinic.logo_url, user.clinicId);

  return analyticalDocumentSnapshotSchema.parse({
    version: 1,
    documentType: params.documentType,
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
      receptionistId: params.receptionistId ?? null,
      outcome: params.outcome ?? null,
      patientQuery: params.patientQuery ?? null,
      patientName: params.patientName ?? null,
      patientFileNumber: params.patientFileNumber ?? null,
      patientNationalId: params.patientNationalId ?? null,
      patientPhone: params.patientPhone ?? null,
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
      watermark: watermarkEnabled
        ? effectiveSettings?.watermark_text?.trim() || clinic.name
        : null,
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
    data,
  });
}

export function parseAnalyticalDocumentSnapshot(
  value: unknown,
): AnalyticalDocumentSnapshot {
  return analyticalDocumentSnapshotSchema.parse(value);
}
