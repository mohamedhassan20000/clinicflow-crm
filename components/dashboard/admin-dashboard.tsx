"use client";

import Link from "next/link";
import {
  CalendarDays,
  UserPlus,
  CalendarPlus,
  CheckCircle2,
  AlertCircle,
  BarChart3,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/appointments/status-badge";
import { RevenueWidget, type RevenueWidgetProps } from "@/components/dashboard/revenue-widget";
import { AnalyticsSection, type AnalyticsSectionProps } from "@/components/dashboard/analytics-section";
import type { Tables } from "@/types/database";
import { formatDoctorName } from "@/lib/format-doctor";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";
import { useTranslations } from "next-intl";

type Appointment = Tables<"appointments"> & {
  patients: { full_name: string } | null;
  profiles: { full_name: string } | null;
};

interface AdminDashboardProps {
  assistantLauncher?: React.ReactNode;
  fullName: string;
  pendingCount: number;
  todayAppointments: Appointment[];
  upcomingAppointments: Appointment[];
  revenue: RevenueWidgetProps;
  analytics: AnalyticsSectionProps;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: DEFAULT_TIME_ZONE,
    month: "short",
    day: "numeric",
  });
}

export function AdminDashboard({
  assistantLauncher,
  fullName,
  pendingCount,
  todayAppointments,
  upcomingAppointments,
  revenue,
  analytics,
}: AdminDashboardProps) {
  const t = useTranslations("dashboard");
  const { formatTime } = useClinicSettings();
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("dashboard")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("welcomeBack")}{fullName}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {assistantLauncher}
          <Button asChild variant="outline" size="sm" className="gap-2">
            <Link href="/patients/new">
              <UserPlus className="h-4 w-4" />
              {t("newPatient")}</Link>
          </Button>
          <Button asChild size="sm" className="gap-2">
            <Link href="/appointments/new">
              <CalendarPlus className="h-4 w-4" />
              {t("bookAppointment")}</Link>
          </Button>
        </div>
      </div>

      {/* Pending alert */}
      {pendingCount > 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm">
          <AlertCircle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="text-amber-700 dark:text-amber-300">
            {t.rich("appointmentsAwaitingConfirmation", {
              count: pendingCount,
              strong: (chunks) => <span className="font-semibold">{chunks}</span>,
            })}</span>
          <Link
            href="/appointments"
            className="ms-auto text-xs font-medium text-amber-700 underline-offset-4 hover:underline dark:text-amber-300"
          >
            {t("view")}</Link>
        </div>
      )}

      {/* Revenue widget — click to open full transactions report */}
      <Link
        href="/revenue"
        className="block rounded-xl transition hover:ring-2 hover:ring-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        aria-label={t("openRevenueTransactionsReport")}
      >
        <RevenueWidget {...revenue} />
      </Link>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Today's schedule */}
        <div className="rounded-xl border border-border/50 bg-card">
          <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
            <div className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-primary" />
              <h2 className="font-semibold text-sm">{t("todaySSchedule")}</h2>
            </div>
            <Link
              href="/appointments"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t("viewCalendar")}</Link>
          </div>
          <div className="divide-y divide-border/50">
            {todayAppointments.length === 0 ? (
              <div className="flex flex-col items-center gap-1 py-10 text-center">
                <CheckCircle2 className="h-6 w-6 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">{t("noAppointmentsToday")}</p>
              </div>
            ) : (
              todayAppointments.slice(0, 6).map((appt) => (
                <div
                  key={appt.id}
                  className="flex items-center gap-3 px-5 py-3 hover:bg-muted/30 transition-colors"
                >
                  <div className="w-14 shrink-0 text-end">
                    <span className="text-xs font-mono font-medium tabular-nums">
                      {formatTime(appt.scheduled_at)}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {appt.patients?.full_name ?? t("unknown")}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {formatDoctorName(appt.profiles?.full_name)}
                    </p>
                  </div>
                  <StatusBadge status={appt.status} />
                </div>
              ))
            )}
            {todayAppointments.length > 6 && (
              <div className="px-5 py-3 text-center">
                <Link
                  href="/appointments"
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t("moreCount", { count: todayAppointments.length - 6 })}
                </Link>
              </div>
            )}
          </div>
        </div>

        {/* Upcoming next 7 days */}
        <div className="rounded-xl border border-border/50 bg-card">
          <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-amber-500" />
              <h2 className="font-semibold text-sm">{t("needsConfirmationNext7Days")}</h2>
            </div>
          </div>
          <div className="divide-y divide-border/50">
            {upcomingAppointments.length === 0 ? (
              <div className="flex flex-col items-center gap-1 py-10 text-center">
                <CheckCircle2 className="h-6 w-6 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">{t("noPendingConfirmations")}</p>
              </div>
            ) : (
              upcomingAppointments.slice(0, 6).map((appt) => (
                <div
                  key={appt.id}
                  className="flex items-center gap-3 px-5 py-3 hover:bg-muted/30 transition-colors"
                >
                  <div className="w-16 shrink-0 text-end">
                    <span className="text-xs font-medium text-muted-foreground">
                      {formatDate(appt.scheduled_at)}
                    </span>
                    <p className="text-xs font-mono tabular-nums">
                      {formatTime(appt.scheduled_at)}
                    </p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {appt.patients?.full_name ?? t("unknown")}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {formatDoctorName(appt.profiles?.full_name)}
                    </p>
                  </div>
                  <StatusBadge status={appt.status} />
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Analytics section */}
      <div>
        <div className="mb-4 flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold tracking-tight">{t("analytics")}</h2>
        </div>
        <AnalyticsSection {...analytics} />
      </div>
    </div>
  );
}
