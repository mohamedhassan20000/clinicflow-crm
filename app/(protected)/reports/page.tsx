import type { Metadata } from "next";
import { requireReportsIndexAccess } from "@/lib/reports/access";
import { ReportsIndex } from "@/components/reports/reports-index";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataReports") };
}

export default async function ReportsPage() {
  const { visibleOpenableReportIds } = await requireReportsIndexAccess();

  return <ReportsIndex visibleReportIds={visibleOpenableReportIds} />;
}
