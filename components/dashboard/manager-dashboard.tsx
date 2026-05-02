"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AnalyticsSection, type AnalyticsSectionProps } from "@/components/dashboard/analytics-section";

export interface ManagerDashboardProps extends AnalyticsSectionProps {
  fullName: string;
}

export function ManagerDashboard({ fullName, ...analyticsProps }: ManagerDashboardProps) {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground">Welcome back, {fullName}.</p>
        </div>
        <a href="/appointments/export" download>
          <Button variant="outline" size="sm" className="gap-2">
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
        </a>
      </div>

      <AnalyticsSection {...analyticsProps} />
    </div>
  );
}
