import Link from "next/link";
import { withReturnTo } from "@/lib/navigation/return-url";
import { operatorReports } from "@/lib/operator-reports/registry";
import { useTranslations } from "next-intl";

export default function OperatorReportsPage() {
  const t = useTranslations("operator");
  return <><header><p className="text-sm font-medium text-primary">{t("platformIntelligence")}</p><h1 className="text-3xl font-bold tracking-tight">{t("reports")}</h1><p className="mt-1 text-muted-foreground">{t("aSharedExtensibleReportingSurfaceOver")}</p></header><section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{operatorReports.map((report) => <Link key={report.id} href={withReturnTo(`/operator/reports/${report.id}`, "/operator/reports")} className="group rounded-2xl border bg-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><h2 className="font-semibold group-hover:text-primary">{report.title}</h2><p className="mt-2 text-sm text-muted-foreground">{report.description}</p></Link>)}</section></>;
}
