import { notFound } from "next/navigation";
import { ReportShell } from "@/components/operator/report-shell";
import { PageHeader } from "@/components/shared/page-header";
import { resolveReturnTo } from "@/lib/navigation/return-url";
import {
  loadOperatorReportFilterOptions,
  operatorReportRegistry,
} from "@/lib/operator-reports/registry";
import { parseReportParams, type RawReportSearchParams } from "@/lib/operator-reports/types";

export default async function OperatorReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ reportId: string }>;
  searchParams: Promise<RawReportSearchParams>;
}) {
  const { reportId } = await params;
  const rawSearch = await searchParams;
  const returnTo = Array.isArray(rawSearch.returnTo) ? rawSearch.returnTo[0] : rawSearch.returnTo;
  const reportsUrl = resolveReturnTo(returnTo, "/operator/reports", ["/operator/reports"]);
  const report = operatorReportRegistry.get(reportId);
  if (!report) notFound();
  const parsed = parseReportParams(report, rawSearch);
  const [result, filterOptions] = await Promise.all([
    report.query(parsed),
    loadOperatorReportFilterOptions(report),
  ]);
  const effectiveParams = { ...parsed, page: result.page };
  return <><PageHeader back={{ href: reportsUrl, label: "reports" }} breadcrumbs={[{ label: "Operator", href: "/operator" }, { label: "Reports", href: reportsUrl }, { label: report.title }]} title={`${report.title} report`} description={report.description} /><ReportShell definition={report} result={result} params={effectiveParams} filterOptions={filterOptions} /></>;
}
