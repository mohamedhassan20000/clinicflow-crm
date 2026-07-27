import type { DateRangePreset, ResolvedDateRange } from "@/lib/date-range";
import type { Database } from "@/types/database";

export type ReportDateRangePreset = DateRangePreset;
export type ReportDateRange = ResolvedDateRange;
export type ReportRpcArgs = { p_start: string; p_end: string };

export type ClinicPrintMeta = {
  clinicName: string;
  clinicAddress: string | null;
  clinicPhone: string | null;
  clinicLogoUrl: string | null;
  generatedAt: string;
};

export type ReportRole = Extract<
  Database["public"]["Enums"]["user_role"],
  "admin" | "manager" | "receptionist" | "doctor" | "assistant"
>;

export type CancellationByDoctor = {
  doctorId: string;
  doctorName: string;
  total: number;
  cancelled: number;
  rate: number;
};

export type CancellationByReason = {
  reason: string;
  count: number;
};

export type CancellationReportResponse = {
  totalAppointments: number;
  cancelledCount: number;
  cancellationRate: number;
  /** Dedicated reschedule KPIs — never conflated with cancellations. */
  replacedCount: number;
  replacementRate: number;
  byDoctor: CancellationByDoctor[];
  byReason: CancellationByReason[];
};

export type NoShowByDoctor = {
  doctorId: string;
  doctorName: string;
  total: number;
  noShow: number;
  rate: number;
};

export type NoShowReportResponse = {
  totalAppointments: number;
  noShowCount: number;
  noShowRate: number;
  /** Dedicated reschedule KPIs — never conflated with no-shows. */
  replacedCount: number;
  replacementRate: number;
  byDoctor: NoShowByDoctor[];
};

export type RevenueMethodBreakdown = {
  method: string;
  amount: number;
};

export type RevenueSummaryReportResponse = {
  totalAmount: number;
  primaryTotal: number;
  secondaryTotal: number;
  insuranceTotal: number;
  depositTotal: number;
  outstandingTotal: number;
  settlementsTotal: number;
  grossTotal: number;
  transactionCount: number;
  settlementCount: number;
  methodBreakdown: RevenueMethodBreakdown[];
};

/**
 * "My Revenue" — the doctor-oriented, self/assigned-scoped revenue summary.
 * Deliberately omits settlements: the scoped RPC only reads appointment payment
 * columns and never the clinic-wide settlement table doctors/assistants cannot
 * see. `grossTotal` therefore excludes settlement income.
 */
export type MyRevenueSummaryReportResponse = {
  totalAmount: number;
  primaryTotal: number;
  secondaryTotal: number;
  insuranceTotal: number;
  depositTotal: number;
  outstandingTotal: number;
  grossTotal: number;
  transactionCount: number;
  methodBreakdown: RevenueMethodBreakdown[];
};

/**
 * "My Performance" — a doctor's own operational KPIs (Phase 8B). Self-scoped to
 * the caller's own sessions (never clinic-wide rankings). Every field is factual
 * system data; there are no subjective ratings. `replaced` is a distinct
 * reschedule KPI, never folded into cancellations or no-shows.
 *
 * `completedTrendPct` is `null` when there is no prior baseline (the immediately
 * preceding equal-length period had no completed sessions), so the UI can render
 * a neutral placeholder instead of a misleading 0%.
 */
export type MyPerformanceSummaryReportResponse = {
  appointmentCount: number;
  completedCount: number;
  cancelledCount: number;
  cancellationRate: number;
  noShowCount: number;
  noShowRate: number;
  replacedCount: number;
  replacementRate: number;
  uniquePatients: number;
  activeDays: number;
  averagePatientsPerDay: number;
  followupsEligible: number;
  followupsCompleted: number;
  followupCompletionRate: number;
  overdueFollowups: number;
  previousCompletedCount: number;
  completedTrendPct: number | null;
};

/**
 * "My Assistant Performance" (Phase 8C) — a section within My Performance. One
 * row per assistant assigned to the viewing doctor, with factual actor-level
 * counts drawn from the Phase 8D activity trail and scoped to the doctor's own
 * entities (multi-assignment activity for other doctors never leaks). Every field
 * is a raw count from recorded semantic actions; there is no composite score.
 */
export type MyAssistantPerformanceRow = {
  assistantId: string;
  assistantName: string;
  totalActions: number;
  appointmentsBooked: number;
  confirmations: number;
  checkIns: number;
  completions: number;
  cancellations: number;
  noShows: number;
  reschedules: number;
  replacements: number;
  statusChanges: number;
  followUpsRecorded: number;
  followUpUpdates: number;
};

export type MyAssistantPerformanceReportResponse = {
  assistants: MyAssistantPerformanceRow[];
};

export type FollowupsReportResponse = {
  completedCount: number;
  allFineCount: number;
  hasProblemCount: number;
  noResponseCount: number;
};

export type DoctorPerformanceRow = {
  doctorId: string;
  doctorName: string;
  departmentId: string | null;
  sessions: number;
  completed: number;
  cancelled: number;
  noShow: number;
  uniquePatients: number;
  revenue: number;
  completionRate: number;
  cancellationRate: number;
  noShowRate: number;
  deptPatientShare: number;
  clinicPatientShare: number;
  deptRevenueShare: number;
  clinicRevenueShare: number;
};

export type DoctorPerformanceReportResponse = {
  doctors: DoctorPerformanceRow[];
};

export type ReceptionistPerformanceRow = {
  id: string;
  name: string;
  appointmentsBooked: number;
  appointmentShare: number;
  followupsHandled: number;
  followupShare: number;
};

export type ReceptionistPerformanceReportResponse = {
  receptionists: ReceptionistPerformanceRow[];
};

export type ReportsRpcResponses = {
  cancellation: CancellationReportResponse;
  noShow: NoShowReportResponse;
  revenueSummary: RevenueSummaryReportResponse;
  followups: FollowupsReportResponse;
  doctorPerformance: DoctorPerformanceReportResponse;
  receptionistPerformance: ReceptionistPerformanceReportResponse;
};

export function canSeePerformanceReports(role: ReportRole): role is Extract<ReportRole, "admin" | "manager"> {
  return role === "admin" || role === "manager";
}
