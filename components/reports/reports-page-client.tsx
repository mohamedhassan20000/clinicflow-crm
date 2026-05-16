"use client";

import type {
  CancellationReportResponse,
  ClinicPrintMeta,
  DoctorPerformanceReportResponse,
  FollowupsReportResponse,
  NoShowReportResponse,
  ReceptionistPerformanceReportResponse,
  ReportDateRange,
  RevenueSummaryReportResponse,
} from "@/types/reports";
import { CancellationReport } from "@/components/reports/cancellation-report";
import { DoctorPerformanceReport } from "@/components/reports/doctor-performance-report";
import { FollowupsReport } from "@/components/reports/followups-report";
import { NoShowReport } from "@/components/reports/no-show-report";
import { PrintAllButton } from "@/components/reports/print-all-button";
import { ReceptionistPerformanceReport } from "@/components/reports/receptionist-performance-report";
import { ReportsDateFilter } from "@/components/reports/reports-date-filter";
import { RevenueSummaryReport } from "@/components/reports/revenue-summary-report";
import { formatDateRangeLabel } from "@/components/reports/report-formatters";

export function ReportsPageClient({
  range,
  canSeePerformanceReports,
  clinic,
  cancellation,
  noShow,
  revenueSummary,
  followups,
  doctorPerformance,
  receptionistPerformance,
}: {
  range: ReportDateRange;
  canSeePerformanceReports: boolean;
  clinic: ClinicPrintMeta;
  cancellation: CancellationReportResponse;
  noShow: NoShowReportResponse;
  revenueSummary: RevenueSummaryReportResponse;
  followups: FollowupsReportResponse;
  doctorPerformance: DoctorPerformanceReportResponse | null;
  receptionistPerformance: ReceptionistPerformanceReportResponse | null;
}) {
  const rangeLabel = formatDateRangeLabel(range.from, range.to);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Clinic performance summaries for {rangeLabel}.
          </p>
        </div>
        <PrintAllButton />
      </div>

      <ReportsDateFilter range={range} />

      <div className="space-y-6">
        <CancellationReport data={cancellation} range={range} clinic={clinic} />
        <NoShowReport data={noShow} range={range} clinic={clinic} />
        <RevenueSummaryReport data={revenueSummary} range={range} clinic={clinic} />
        <FollowupsReport data={followups} range={range} clinic={clinic} />
        {canSeePerformanceReports && doctorPerformance && receptionistPerformance && (
          <>
            <DoctorPerformanceReport data={doctorPerformance} range={range} clinic={clinic} />
            <ReceptionistPerformanceReport
              data={receptionistPerformance}
              range={range}
              clinic={clinic}
            />
          </>
        )}
      </div>
    </div>
  );
}
