"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AnalyticsSection, type AnalyticsSectionProps } from "@/components/dashboard/analytics-section";
import { useTranslations } from "next-intl";

export interface ManagerDashboardProps extends AnalyticsSectionProps {
  assistantLauncher?: React.ReactNode;
  fullName: string;
  showAnalytics?: boolean;
  showExportCsv?: boolean;
  /**
   * The AI review queues, rendered as a slot rather than imported here: they are
   * an async server component and this dashboard is a client component. Placed
   * above the analytics so the queues that need staff action come before the
   * numbers, matching the admin and reception dashboards.
   */
  aiReviewQueues?: React.ReactNode;
}

export function ManagerDashboard({ assistantLauncher, fullName, showAnalytics = true, showExportCsv = true, aiReviewQueues, ...analyticsProps }: ManagerDashboardProps) {
  const t = useTranslations("dashboard");
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("analytics")}</h1>
          <p className="text-sm text-muted-foreground">{t("welcomeBack")}{fullName}.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {assistantLauncher}
          {showExportCsv && (
            <a href="/appointments/export" download>
              <Button variant="outline" size="sm" className="gap-2">
                <Download className="h-4 w-4" />
                {t("exportCsv")}</Button>
            </a>
          )}
        </div>
      </div>

      {aiReviewQueues}

      {showAnalytics && <AnalyticsSection {...analyticsProps} />}
    </div>
  );
}
