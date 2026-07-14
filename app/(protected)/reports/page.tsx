import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { canSeePerformanceReports } from "@/types/reports";
import { ReportsIndex } from "@/components/reports/reports-index";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataReports") };
}

export default async function ReportsPage() {
  const user = await requireRole(["admin", "manager", "receptionist"]);

  return <ReportsIndex canSeePerformanceReports={canSeePerformanceReports(user.role)} />;
}
