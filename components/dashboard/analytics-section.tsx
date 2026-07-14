"use client";

import dynamic from "next/dynamic";
import {
  CalendarDays,
  TrendingUp,
  Users,
  XCircle,
  UserX,
  BarChart3,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { KpiCard } from "@/components/dashboard/kpi-card";
import type { AnalyticsSectionChartsProps } from "./analytics-section-charts";
import { useTranslations } from "next-intl";

export type { DailyPoint, InsurancePoint } from "./analytics-section-charts";

export interface AnalyticsSectionProps extends AnalyticsSectionChartsProps {
  todayCount: number;
  weekCount: number;
  monthCount: number;
  noShowRate: number;
  cancelRate: number;
  totalPatients: number;
}

const AnalyticsSectionCharts = dynamic(
  () => import("./analytics-section-charts"),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-6">
        <Skeleton className="h-72 w-full rounded-xl" />
        <div className="grid gap-6 xl:grid-cols-2">
          <Skeleton className="h-60 rounded-xl" />
          <Skeleton className="h-60 rounded-xl" />
        </div>
        <Skeleton className="h-60 w-full rounded-xl" />
        <Skeleton className="h-60 w-full rounded-xl" />
        <Skeleton className="h-60 w-full rounded-xl" />
      </div>
    ),
  },
);

export function AnalyticsSection({
  clinicId,
  todayCount,
  weekCount,
  monthCount,
  noShowRate,
  cancelRate,
  totalPatients,
  initialDailySeries,
  initialInsuranceSeries,
  initialDoctors,
  initialDepartments,
  initialReceptionists,
  initialFollowUpOutcomes,
  departmentsList,
  doctorsList,
}: AnalyticsSectionProps) {
  const t = useTranslations("dashboard");
  return (
    <div className="space-y-6">
      {/* KPI cards — render immediately, no Recharts dependency */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard title={t("today")} value={todayCount} icon={CalendarDays} variant="primary" />
        <KpiCard title={t("thisWeek")} value={weekCount} icon={TrendingUp} />
        <KpiCard title={t("thisMonth")} value={monthCount} icon={BarChart3} variant="success" />
        <KpiCard title={t("totalPatients")} value={totalPatients} icon={Users} />
        <KpiCard title={t("noShowRate")} value={`${noShowRate}%`} icon={UserX} variant={noShowRate > 10 ? "warning" : "default"} />
        <KpiCard title={t("cancellationRate")} value={`${cancelRate}%`} icon={XCircle} variant={cancelRate > 15 ? "warning" : "default"} />
      </div>

      {/* Charts — lazy-loaded so Recharts bundle doesn't block initial paint */}
      <AnalyticsSectionCharts
        clinicId={clinicId}
        initialDailySeries={initialDailySeries}
        initialInsuranceSeries={initialInsuranceSeries}
        initialDoctors={initialDoctors}
        initialDepartments={initialDepartments}
        initialReceptionists={initialReceptionists}
        initialFollowUpOutcomes={initialFollowUpOutcomes}
        departmentsList={departmentsList}
        doctorsList={doctorsList}
      />
    </div>
  );
}
