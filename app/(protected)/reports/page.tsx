import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { dateRangeToRpcArgs, resolveDateRange, type DateRangePreset } from "@/lib/date-range";
import { createClient } from "@/lib/supabase/server";
import { ReportsPageClient } from "@/components/reports/reports-page-client";
import type {
  CancellationByDoctor,
  CancellationByReason,
  CancellationReportResponse,
  DoctorPerformanceReportResponse,
  DoctorPerformanceRow,
  FollowupsReportResponse,
  NoShowByDoctor,
  NoShowReportResponse,
  ReceptionistPerformanceReportResponse,
  ReceptionistPerformanceRow,
  RevenueMethodBreakdown,
  RevenueSummaryReportResponse,
} from "@/types/reports";
import { canSeePerformanceReports } from "@/types/reports";

export const metadata: Metadata = { title: "Reports" };

interface PageProps {
  searchParams: Promise<{
    preset?: string;
    from?: string;
    to?: string;
  }>;
}

const EMPTY_CANCELLATION: CancellationReportResponse = {
  totalAppointments: 0,
  cancelledCount: 0,
  cancellationRate: 0,
  byDoctor: [],
  byReason: [],
};

const EMPTY_NO_SHOW: NoShowReportResponse = {
  totalAppointments: 0,
  noShowCount: 0,
  noShowRate: 0,
  byDoctor: [],
};

const EMPTY_REVENUE: RevenueSummaryReportResponse = {
  totalAmount: 0,
  primaryTotal: 0,
  secondaryTotal: 0,
  insuranceTotal: 0,
  depositTotal: 0,
  outstandingTotal: 0,
  settlementsTotal: 0,
  grossTotal: 0,
  transactionCount: 0,
  settlementCount: 0,
  methodBreakdown: [],
};

const EMPTY_FOLLOWUPS: FollowupsReportResponse = {
  completedCount: 0,
  allFineCount: 0,
  hasProblemCount: 0,
  noResponseCount: 0,
};

const EMPTY_DOCTOR_PERFORMANCE: DoctorPerformanceReportResponse = { doctors: [] };
const EMPTY_RECEPTIONIST_PERFORMANCE: ReceptionistPerformanceReportResponse = {
  receptionists: [],
};

function isDateRangePreset(value: string | undefined): value is DateRangePreset {
  return (
    value === "today" ||
    value === "this_week" ||
    value === "this_month" ||
    value === "custom"
  );
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toNumber(value: unknown) {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function toString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function toNullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function normalizeArray<T>(value: unknown, parser: (entry: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => parser(toRecord(entry)));
}

function normalizeCancellationReport(value: unknown): CancellationReportResponse {
  const raw = toRecord(value);
  return {
    totalAppointments: toNumber(raw.totalAppointments),
    cancelledCount: toNumber(raw.cancelledCount),
    cancellationRate: toNumber(raw.cancellationRate),
    byDoctor: normalizeArray<CancellationByDoctor>(raw.byDoctor, (row) => ({
      doctorId: toString(row.doctorId),
      doctorName: toString(row.doctorName),
      total: toNumber(row.total),
      cancelled: toNumber(row.cancelled),
      rate: toNumber(row.rate),
    })),
    byReason: normalizeArray<CancellationByReason>(raw.byReason, (row) => ({
      reason: toString(row.reason) || "Unspecified",
      count: toNumber(row.count),
    })),
  };
}

function normalizeNoShowReport(value: unknown): NoShowReportResponse {
  const raw = toRecord(value);
  return {
    totalAppointments: toNumber(raw.totalAppointments),
    noShowCount: toNumber(raw.noShowCount),
    noShowRate: toNumber(raw.noShowRate),
    byDoctor: normalizeArray<NoShowByDoctor>(raw.byDoctor, (row) => ({
      doctorId: toString(row.doctorId),
      doctorName: toString(row.doctorName),
      total: toNumber(row.total),
      noShow: toNumber(row.noShow),
      rate: toNumber(row.rate),
    })),
  };
}

function normalizeRevenueSummary(value: unknown): RevenueSummaryReportResponse {
  const raw = toRecord(value);
  return {
    totalAmount: toNumber(raw.totalAmount),
    primaryTotal: toNumber(raw.primaryTotal),
    secondaryTotal: toNumber(raw.secondaryTotal),
    insuranceTotal: toNumber(raw.insuranceTotal),
    depositTotal: toNumber(raw.depositTotal),
    outstandingTotal: toNumber(raw.outstandingTotal),
    settlementsTotal: toNumber(raw.settlementsTotal),
    grossTotal: toNumber(raw.grossTotal),
    transactionCount: toNumber(raw.transactionCount),
    settlementCount: toNumber(raw.settlementCount),
    methodBreakdown: normalizeArray<RevenueMethodBreakdown>(raw.methodBreakdown, (row) => ({
      method: toString(row.method),
      amount: toNumber(row.amount),
    })).filter((row) => row.method.length > 0),
  };
}

function normalizeFollowups(value: unknown): FollowupsReportResponse {
  const raw = toRecord(value);
  const summary = toRecord(raw.summary);
  return {
    completedCount: toNumber(summary.completedCount),
    allFineCount: toNumber(summary.allFineCount),
    hasProblemCount: toNumber(summary.hasProblemCount),
    noResponseCount: toNumber(summary.noResponseCount),
  };
}

function normalizeDoctorPerformance(value: unknown): DoctorPerformanceReportResponse {
  const raw = toRecord(value);
  return {
    doctors: normalizeArray<DoctorPerformanceRow>(raw.doctors, (row) => ({
      doctorId: toString(row.doctorId),
      doctorName: toString(row.doctorName),
      departmentId: toNullableString(row.departmentId),
      sessions: toNumber(row.sessions),
      completed: toNumber(row.completed),
      cancelled: toNumber(row.cancelled),
      noShow: toNumber(row.noShow),
      uniquePatients: toNumber(row.uniquePatients),
      revenue: toNumber(row.revenue),
      completionRate: toNumber(row.completionRate),
      cancellationRate: toNumber(row.cancellationRate),
      noShowRate: toNumber(row.noShowRate),
      deptPatientShare: toNumber(row.deptPatientShare),
      clinicPatientShare: toNumber(row.clinicPatientShare),
      deptRevenueShare: toNumber(row.deptRevenueShare),
      clinicRevenueShare: toNumber(row.clinicRevenueShare),
    })),
  };
}

function normalizeReceptionistPerformance(value: unknown): ReceptionistPerformanceReportResponse {
  const raw = toRecord(value);
  return {
    receptionists: normalizeArray<ReceptionistPerformanceRow>(raw.receptionists, (row) => ({
      id: toString(row.id),
      name: toString(row.name),
      appointmentsBooked: toNumber(row.appointmentsBooked),
      appointmentShare: toNumber(row.appointmentShare),
      followupsHandled: toNumber(row.followupsHandled),
      followupShare: toNumber(row.followupShare),
    })),
  };
}

export default async function ReportsPage({ searchParams }: PageProps) {
  const user = await requireRole(["admin", "manager", "receptionist"]);
  const canViewPerformance = canSeePerformanceReports(user.role);
  const sp = await searchParams;
  const range = resolveDateRange({
    preset: isDateRangePreset(sp.preset) ? sp.preset : undefined,
    from: sp.from,
    to: sp.to,
  });
  const args = dateRangeToRpcArgs(range);
  const supabase = await createClient();

  const baseReportPromises = [
    supabase.rpc("get_cancellation_report", args),
    supabase.rpc("get_no_show_report", args),
    supabase.rpc("get_revenue_summary", {
      ...args,
      p_department_id: undefined,
      p_doctor_id: undefined,
      p_patient_ids: undefined,
    }),
    supabase.rpc("get_followups_dashboard", {
      ...args,
      p_department_id: undefined,
      p_doctor_id: undefined,
      p_patient_ids: undefined,
      p_outcome: undefined,
      p_pending_limit: 0,
      p_done_limit: 0,
      p_done_offset: 0,
    }),
    supabase
      .from("clinics")
      .select("name, address, phone, logo_url")
      .eq("id", user.clinicId)
      .single(),
  ] as const;

  const performancePromises = canViewPerformance
    ? [
        supabase.rpc("get_doctor_performance_report", args),
        supabase.rpc("get_receptionist_performance_report", args),
      ] as const
    : null;

  const [
    [
      cancellationResult,
      noShowResult,
      revenueResult,
      followupsResult,
      clinicResult,
    ],
    [doctorPerformanceResult, receptionistPerformanceResult],
  ] = await Promise.all([
    Promise.all(baseReportPromises),
    performancePromises ? Promise.all(performancePromises) : Promise.resolve([null, null] as const),
  ]);

  const firstError =
    cancellationResult.error ??
    noShowResult.error ??
    revenueResult.error ??
    followupsResult.error ??
    clinicResult.error ??
    doctorPerformanceResult?.error ??
    receptionistPerformanceResult?.error;

  if (firstError) {
    throw new Error(firstError.message);
  }

  const generatedAt = new Date().toLocaleString("en-GB", {
    dateStyle: "long",
    timeStyle: "short",
  });

  return (
    <ReportsPageClient
      range={range}
      canSeePerformanceReports={canViewPerformance}
      clinic={{
        clinicName: clinicResult.data?.name ?? "ClinicFlow",
        clinicAddress: clinicResult.data?.address ?? null,
        clinicPhone: clinicResult.data?.phone ?? null,
        clinicLogoUrl: clinicResult.data?.logo_url ?? null,
        generatedAt,
      }}
      cancellation={
        cancellationResult.data
          ? normalizeCancellationReport(cancellationResult.data)
          : EMPTY_CANCELLATION
      }
      noShow={noShowResult.data ? normalizeNoShowReport(noShowResult.data) : EMPTY_NO_SHOW}
      revenueSummary={
        revenueResult.data ? normalizeRevenueSummary(revenueResult.data) : EMPTY_REVENUE
      }
      followups={followupsResult.data ? normalizeFollowups(followupsResult.data) : EMPTY_FOLLOWUPS}
      doctorPerformance={
        canViewPerformance && doctorPerformanceResult?.data
          ? normalizeDoctorPerformance(doctorPerformanceResult.data)
          : EMPTY_DOCTOR_PERFORMANCE
      }
      receptionistPerformance={
        canViewPerformance && receptionistPerformanceResult?.data
          ? normalizeReceptionistPerformance(receptionistPerformanceResult.data)
          : EMPTY_RECEPTIONIST_PERFORMANCE
      }
    />
  );
}
