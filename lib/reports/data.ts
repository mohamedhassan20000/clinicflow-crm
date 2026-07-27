import "server-only";

import { dateRangeToRpcArgs, resolveDateRange, type DateRangePreset } from "@/lib/date-range";
import { createClient } from "@/lib/supabase/server";
import type { AuthedUser } from "@/lib/rbac";
import type { Database } from "@/types/database";
import type {
  CancellationByDoctor,
  CancellationByReason,
  CancellationReportResponse,
  ClinicPrintMeta,
  DoctorPerformanceReportResponse,
  DoctorPerformanceRow,
  FollowupsReportResponse,
  MyAssistantPerformanceReportResponse,
  MyAssistantPerformanceRow,
  MyPerformanceSummaryReportResponse,
  MyRevenueSummaryReportResponse,
  NoShowByDoctor,
  NoShowReportResponse,
  ReceptionistPerformanceReportResponse,
  ReceptionistPerformanceRow,
  ReportDateRange,
  RevenueMethodBreakdown,
  RevenueSummaryReportResponse,
} from "@/types/reports";

export type ReportsSearchParams = {
  preset?: string;
  from?: string;
  to?: string;
  doctor?: string;
  department?: string;
  outcome?: string;
  receptionist?: string;
};

export type ReportOption = {
  id: string;
  name: string;
};

export type FollowupOutcome = Database["public"]["Enums"]["follow_up_outcome"];

export const ALL_FILTER_VALUE = "all";

export const EMPTY_CANCELLATION: CancellationReportResponse = {
  totalAppointments: 0,
  cancelledCount: 0,
  cancellationRate: 0,
  replacedCount: 0,
  replacementRate: 0,
  byDoctor: [],
  byReason: [],
};

export const EMPTY_NO_SHOW: NoShowReportResponse = {
  totalAppointments: 0,
  noShowCount: 0,
  noShowRate: 0,
  replacedCount: 0,
  replacementRate: 0,
  byDoctor: [],
};

export const EMPTY_REVENUE: RevenueSummaryReportResponse = {
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

export const EMPTY_MY_REVENUE: MyRevenueSummaryReportResponse = {
  totalAmount: 0,
  primaryTotal: 0,
  secondaryTotal: 0,
  insuranceTotal: 0,
  depositTotal: 0,
  outstandingTotal: 0,
  grossTotal: 0,
  transactionCount: 0,
  methodBreakdown: [],
};

export const EMPTY_MY_PERFORMANCE: MyPerformanceSummaryReportResponse = {
  appointmentCount: 0,
  completedCount: 0,
  cancelledCount: 0,
  cancellationRate: 0,
  noShowCount: 0,
  noShowRate: 0,
  replacedCount: 0,
  replacementRate: 0,
  uniquePatients: 0,
  activeDays: 0,
  averagePatientsPerDay: 0,
  followupsEligible: 0,
  followupsCompleted: 0,
  followupCompletionRate: 0,
  overdueFollowups: 0,
  previousCompletedCount: 0,
  completedTrendPct: null,
};

export const EMPTY_MY_ASSISTANT_PERFORMANCE: MyAssistantPerformanceReportResponse = {
  assistants: [],
};

export const EMPTY_FOLLOWUPS: FollowupsReportResponse = {
  completedCount: 0,
  allFineCount: 0,
  hasProblemCount: 0,
  noResponseCount: 0,
};

export const EMPTY_DOCTOR_PERFORMANCE: DoctorPerformanceReportResponse = { doctors: [] };

export const EMPTY_RECEPTIONIST_PERFORMANCE: ReceptionistPerformanceReportResponse = {
  receptionists: [],
};

export function isDateRangePreset(value: string | undefined): value is DateRangePreset {
  return (
    value === "today" ||
    value === "this_week" ||
    value === "this_month" ||
    value === "custom"
  );
}

export function resolveReportsRange(searchParams: ReportsSearchParams): ReportDateRange {
  return resolveDateRange({
    preset: isDateRangePreset(searchParams.preset) ? searchParams.preset : undefined,
    from: searchParams.from,
    to: searchParams.to,
  });
}

export function cleanFilter(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return !trimmed || trimmed === ALL_FILTER_VALUE ? null : trimmed;
}

export function parseFollowupOutcome(value: string | undefined): FollowupOutcome | null {
  if (value === "all_fine" || value === "has_problem" || value === "no_response") return value;
  return null;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toNumber(value: unknown) {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function toString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function normalizeArray<T>(value: unknown, parser: (entry: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => parser(toRecord(entry)));
}

export function normalizeCancellationReport(value: unknown): CancellationReportResponse {
  const raw = toRecord(value);
  return {
    totalAppointments: toNumber(raw.totalAppointments),
    cancelledCount: toNumber(raw.cancelledCount),
    cancellationRate: toNumber(raw.cancellationRate),
    replacedCount: toNumber(raw.replacedCount),
    replacementRate: toNumber(raw.replacementRate),
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

export function normalizeNoShowReport(value: unknown): NoShowReportResponse {
  const raw = toRecord(value);
  return {
    totalAppointments: toNumber(raw.totalAppointments),
    noShowCount: toNumber(raw.noShowCount),
    noShowRate: toNumber(raw.noShowRate),
    replacedCount: toNumber(raw.replacedCount),
    replacementRate: toNumber(raw.replacementRate),
    byDoctor: normalizeArray<NoShowByDoctor>(raw.byDoctor, (row) => ({
      doctorId: toString(row.doctorId),
      doctorName: toString(row.doctorName),
      total: toNumber(row.total),
      noShow: toNumber(row.noShow),
      rate: toNumber(row.rate),
    })),
  };
}

export function normalizeRevenueSummary(value: unknown): RevenueSummaryReportResponse {
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

export function normalizeMyRevenueSummary(value: unknown): MyRevenueSummaryReportResponse {
  const raw = toRecord(value);
  return {
    totalAmount: toNumber(raw.totalAmount),
    primaryTotal: toNumber(raw.primaryTotal),
    secondaryTotal: toNumber(raw.secondaryTotal),
    insuranceTotal: toNumber(raw.insuranceTotal),
    depositTotal: toNumber(raw.depositTotal),
    outstandingTotal: toNumber(raw.outstandingTotal),
    grossTotal: toNumber(raw.grossTotal),
    transactionCount: toNumber(raw.transactionCount),
    methodBreakdown: normalizeArray<RevenueMethodBreakdown>(raw.methodBreakdown, (row) => ({
      method: toString(row.method),
      amount: toNumber(row.amount),
    })).filter((row) => row.method.length > 0),
  };
}

export function normalizeMyPerformanceSummary(
  value: unknown,
): MyPerformanceSummaryReportResponse {
  const raw = toRecord(value);
  return {
    appointmentCount: toNumber(raw.appointmentCount),
    completedCount: toNumber(raw.completedCount),
    cancelledCount: toNumber(raw.cancelledCount),
    cancellationRate: toNumber(raw.cancellationRate),
    noShowCount: toNumber(raw.noShowCount),
    noShowRate: toNumber(raw.noShowRate),
    replacedCount: toNumber(raw.replacedCount),
    replacementRate: toNumber(raw.replacementRate),
    uniquePatients: toNumber(raw.uniquePatients),
    activeDays: toNumber(raw.activeDays),
    averagePatientsPerDay: toNumber(raw.averagePatientsPerDay),
    followupsEligible: toNumber(raw.followupsEligible),
    followupsCompleted: toNumber(raw.followupsCompleted),
    followupCompletionRate: toNumber(raw.followupCompletionRate),
    overdueFollowups: toNumber(raw.overdueFollowups),
    previousCompletedCount: toNumber(raw.previousCompletedCount),
    // Preserved as null (no prior baseline) rather than coerced to 0.
    completedTrendPct: toNullableNumber(raw.completedTrendPct),
  };
}

export function normalizeMyAssistantPerformance(
  value: unknown,
): MyAssistantPerformanceReportResponse {
  const raw = toRecord(value);
  return {
    assistants: normalizeArray<MyAssistantPerformanceRow>(raw.assistants, (row) => ({
      assistantId: toString(row.assistantId),
      assistantName: toString(row.assistantName),
      totalActions: toNumber(row.totalActions),
      appointmentsBooked: toNumber(row.appointmentsBooked),
      confirmations: toNumber(row.confirmations),
      checkIns: toNumber(row.checkIns),
      completions: toNumber(row.completions),
      cancellations: toNumber(row.cancellations),
      noShows: toNumber(row.noShows),
      reschedules: toNumber(row.reschedules),
      replacements: toNumber(row.replacements),
      statusChanges: toNumber(row.statusChanges),
      followUpsRecorded: toNumber(row.followUpsRecorded),
      followUpUpdates: toNumber(row.followUpUpdates),
    })).filter((row) => row.assistantId.length > 0),
  };
}

export function normalizeFollowups(value: unknown): FollowupsReportResponse {
  const raw = toRecord(value);
  const summary = toRecord(raw.summary);
  return {
    completedCount: toNumber(summary.completedCount),
    allFineCount: toNumber(summary.allFineCount),
    hasProblemCount: toNumber(summary.hasProblemCount),
    noResponseCount: toNumber(summary.noResponseCount),
  };
}

export function normalizeDoctorPerformance(value: unknown): DoctorPerformanceReportResponse {
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

export function normalizeReceptionistPerformance(value: unknown): ReceptionistPerformanceReportResponse {
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

export async function getClinicPrintMeta(user: AuthedUser): Promise<ClinicPrintMeta> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clinics")
    .select("name, address, phone, logo_url")
    .eq("id", user.clinicId)
    .single();

  if (error) throw new Error(error.message);

  return {
    clinicName: data?.name ?? "ClinicFlow",
    clinicAddress: data?.address ?? null,
    clinicPhone: data?.phone ?? null,
    clinicLogoUrl: data?.logo_url ?? null,
    generatedAt: new Date().toLocaleString("en-GB", {
      dateStyle: "long",
      timeStyle: "short",
    }),
  };
}

export async function getDoctorOptions(user: AuthedUser): Promise<ReportOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("clinic_id", user.clinicId)
    .eq("role", "doctor")
    .eq("is_active", true)
    .eq("is_deleted", false)
    .is("deleted_at", null)
    .order("full_name");

  if (error) throw new Error(error.message);
  return (data ?? []).map((doctor) => ({ id: doctor.id, name: doctor.full_name }));
}

export async function getReceptionistOptions(user: AuthedUser): Promise<ReportOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("clinic_id", user.clinicId)
    .eq("role", "receptionist")
    .eq("is_active", true)
    .eq("is_deleted", false)
    .is("deleted_at", null)
    .order("full_name");

  if (error) throw new Error(error.message);
  return (data ?? []).map((receptionist) => ({
    id: receptionist.id,
    name: receptionist.full_name,
  }));
}

export async function getDepartmentOptions(user: AuthedUser): Promise<ReportOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("departments")
    .select("id, name")
    .eq("clinic_id", user.clinicId)
    .eq("is_active", true)
    .order("name");

  if (error) throw new Error(error.message);
  return (data ?? []).map((department) => ({ id: department.id, name: department.name }));
}

export async function getCancellationReportData(
  user: AuthedUser,
  range: ReportDateRange,
  doctorId: string | null,
) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_cancellation_report", dateRangeToRpcArgs(range));
  if (error) throw new Error(error.message);

  const report = data ? normalizeCancellationReport(data) : EMPTY_CANCELLATION;
  if (!doctorId) return report;

  const doctorRow = report.byDoctor.find((row) => row.doctorId === doctorId);
  const { data: reasonRows, error: reasonError } = await supabase
    .from("appointments")
    .select("cancellation_reason")
    .eq("clinic_id", user.clinicId)
    .eq("doctor_id", doctorId)
    .eq("status", "cancelled")
    .is("deleted_at", null)
    .gte("scheduled_at", range.start.toISOString())
    .lte("scheduled_at", range.end.toISOString());

  if (reasonError) throw new Error(reasonError.message);

  const reasonCounts = new Map<string, number>();
  for (const row of reasonRows ?? []) {
    const reason = row.cancellation_reason?.trim() || "Unspecified";
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }

  return {
    totalAppointments: doctorRow?.total ?? 0,
    cancelledCount: doctorRow?.cancelled ?? 0,
    cancellationRate: doctorRow?.rate ?? 0,
    // Replacement is a range-level reschedule KPI, carried through unchanged.
    replacedCount: report.replacedCount,
    replacementRate: report.replacementRate,
    byDoctor: doctorRow ? [doctorRow] : [],
    byReason: Array.from(reasonCounts.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
  };
}

export async function getNoShowReportData(range: ReportDateRange, doctorId: string | null) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_no_show_report", dateRangeToRpcArgs(range));
  if (error) throw new Error(error.message);

  const report = data ? normalizeNoShowReport(data) : EMPTY_NO_SHOW;
  if (!doctorId) return report;

  const doctorRow = report.byDoctor.find((row) => row.doctorId === doctorId);
  return {
    totalAppointments: doctorRow?.total ?? 0,
    noShowCount: doctorRow?.noShow ?? 0,
    noShowRate: doctorRow?.rate ?? 0,
    replacedCount: report.replacedCount,
    replacementRate: report.replacementRate,
    byDoctor: doctorRow ? [doctorRow] : [],
  };
}

export async function getRevenueSummaryData(
  range: ReportDateRange,
  doctorId: string | null,
  departmentId: string | null,
) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_revenue_summary", {
    ...dateRangeToRpcArgs(range),
    p_department_id: departmentId ?? undefined,
    p_doctor_id: doctorId ?? undefined,
    p_patient_ids: undefined,
  });

  if (error) throw new Error(error.message);
  return data ? normalizeRevenueSummary(data) : EMPTY_REVENUE;
}

/**
 * "My Revenue" — doctor/assistant self-scoped collected revenue. The dedicated
 * `get_my_revenue_summary` RPC is SECURITY INVOKER over RLS-scoped appointments
 * and hard-denies non-doctor/assistant callers, so the scope is enforced in the
 * database regardless of who invokes this helper. No doctor filter: the result
 * is already the caller's own / their supervised-doctor union.
 */
export async function getMyRevenueSummaryData(range: ReportDateRange) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_my_revenue_summary", dateRangeToRpcArgs(range));
  if (error) throw new Error(error.message);
  return data ? normalizeMyRevenueSummary(data) : EMPTY_MY_REVENUE;
}

/**
 * "My Performance" — a doctor's own operational KPIs (Phase 8B). The dedicated
 * `get_my_performance_summary` RPC is SECURITY INVOKER and hard-denies every
 * role except `doctor`, filtering to the caller's own sessions in the database.
 * No doctor filter here: the scope is the caller themselves by construction.
 */
export async function getMyPerformanceSummaryData(range: ReportDateRange) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(
    "get_my_performance_summary",
    dateRangeToRpcArgs(range),
  );
  if (error) throw new Error(error.message);
  return data ? normalizeMyPerformanceSummary(data) : EMPTY_MY_PERFORMANCE;
}

/**
 * "My Assistant Performance" (Phase 8C) — the operational activity of the
 * assistants assigned to the calling doctor, each shown separately. The dedicated
 * `get_my_assistant_performance` RPC is SECURITY DEFINER, hard-denies every role
 * except `doctor`, and constrains every read to the caller's own clinic and own
 * doctor_id, so it never widens data access. Counts come from the Phase 8D
 * activity trail; activity an assistant performed for a different doctor never
 * enters this report.
 */
export async function getMyAssistantPerformanceData(range: ReportDateRange) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(
    "get_my_assistant_performance",
    dateRangeToRpcArgs(range),
  );
  if (error) throw new Error(error.message);
  return data ? normalizeMyAssistantPerformance(data) : EMPTY_MY_ASSISTANT_PERFORMANCE;
}

export async function getFollowupsReportData(range: ReportDateRange, outcome: FollowupOutcome | null) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_followups_dashboard", {
    ...dateRangeToRpcArgs(range),
    p_department_id: undefined,
    p_doctor_id: undefined,
    p_patient_ids: undefined,
    p_outcome: outcome ?? undefined,
    p_pending_limit: 0,
    p_done_limit: 0,
    p_done_offset: 0,
  });

  if (error) throw new Error(error.message);
  return data ? normalizeFollowups(data) : EMPTY_FOLLOWUPS;
}

export async function getDoctorPerformanceData(range: ReportDateRange, doctorId: string | null) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_doctor_performance_report", dateRangeToRpcArgs(range));
  if (error) throw new Error(error.message);

  const report = data ? normalizeDoctorPerformance(data) : EMPTY_DOCTOR_PERFORMANCE;
  if (!doctorId) return report;
  return { doctors: report.doctors.filter((doctor) => doctor.doctorId === doctorId) };
}

export async function getReceptionistPerformanceData(
  range: ReportDateRange,
  receptionistId: string | null,
) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(
    "get_receptionist_performance_report",
    dateRangeToRpcArgs(range),
  );
  if (error) throw new Error(error.message);

  const report = data ? normalizeReceptionistPerformance(data) : EMPTY_RECEPTIONIST_PERFORMANCE;
  if (!receptionistId) return report;
  return {
    receptionists: report.receptionists.filter((row) => row.id === receptionistId),
  };
}
