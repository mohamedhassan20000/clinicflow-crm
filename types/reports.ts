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
  "admin" | "manager" | "receptionist" | "doctor"
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
