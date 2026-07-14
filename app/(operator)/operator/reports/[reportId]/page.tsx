import { notFound } from "next/navigation";
import { ReportShell } from "@/components/operator/report-shell";
import { PageHeader } from "@/components/shared/page-header";
import { resolveReturnTo } from "@/lib/navigation/return-url";
import {
  loadOperatorReportFilterOptions,
  operatorReportRegistry,
} from "@/lib/operator-reports/registry";
import { parseReportParams, type RawReportSearchParams } from "@/lib/operator-reports/types";
import { getTranslations } from "next-intl/server";

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
  const t = await getTranslations("operator");
  const parsed = parseReportParams(report, rawSearch);
  const [result, filterOptions] = await Promise.all([
    report.query(parsed),
    loadOperatorReportFilterOptions(report),
  ]);
  const effectiveParams = { ...parsed, page: result.page };
  return <><PageHeader back={{ href: reportsUrl, label: t("reports") }} breadcrumbs={[{ label: t("operator"), href: "/operator" }, { label: t("reports"), href: reportsUrl }, { label: report.title }]} title={t("namedReport", { name: report.title })} description={report.description} /><ReportShell definition={report} result={result} params={effectiveParams} filterOptions={filterOptions} /></>;
}
