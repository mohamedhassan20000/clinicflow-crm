import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { canSeePerformanceReports } from "@/types/reports";
import { ReportsIndex } from "@/components/reports/reports-index";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage() {
  const user = await requireRole(["admin", "manager", "receptionist"]);

  return <ReportsIndex canSeePerformanceReports={canSeePerformanceReports(user.role)} />;
}
