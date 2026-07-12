import { notFound } from "next/navigation";
import { ReportShell } from "@/components/operator/report-shell";
import { operatorReportRegistry } from "@/lib/operator-reports/registry";

export default async function OperatorReportPage({ params }: { params: Promise<{ reportId: string }> }) {
  const { reportId } = await params;
  const report = operatorReportRegistry.get(reportId);
  if (!report) notFound();
  const rows = await report.query();
  return <><header><h1 className="text-3xl font-bold tracking-tight">{report.title} report</h1></header><ReportShell definition={report} rows={rows} /></>;
}
