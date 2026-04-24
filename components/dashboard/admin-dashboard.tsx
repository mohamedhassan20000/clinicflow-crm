import Link from "next/link";
import {
  CalendarDays,
  UserPlus,
  CalendarPlus,
  Clock,
  CheckCircle2,
  Users,
  TrendingUp,
  AlertCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { StatusBadge } from "@/components/appointments/status-badge";
import { RevenueWidget, type RevenueWidgetProps } from "@/components/dashboard/revenue-widget";
import type { Tables } from "@/types/database";

type Appointment = Tables<"appointments"> & {
  patients: { full_name: string } | null;
  profiles: { full_name: string } | null;
};

interface AdminDashboardProps {
  fullName: string;
  todayCount: number;
  weekCount: number;
  thisMonthCount: number;
  lastMonthCount: number;
  totalPatients: number;
  pendingCount: number;
  todayAppointments: Appointment[];
  upcomingAppointments: Appointment[];
  revenue: RevenueWidgetProps;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: "Europe/Istanbul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "Europe/Istanbul",
    month: "short",
    day: "numeric",
  });
}

export function AdminDashboard({
  fullName,
  todayCount,
  weekCount,
  thisMonthCount,
  lastMonthCount,
  totalPatients,
  pendingCount,
  todayAppointments,
  upcomingAppointments,
  revenue,
}: AdminDashboardProps) {
  const monthTrend =
    lastMonthCount === 0
      ? 0
      : Math.round(((thisMonthCount - lastMonthCount) / lastMonthCount) * 100);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Welcome back, {fullName}.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm" className="gap-2">
            <Link href="/patients/new">
              <UserPlus className="h-4 w-4" />
              New patient
            </Link>
          </Button>
          <Button asChild size="sm" className="gap-2">
            <Link href="/appointments/new">
              <CalendarPlus className="h-4 w-4" />
              Book appointment
            </Link>
          </Button>
        </div>
      </div>

      {/* KPI grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          title="Today's appointments"
          value={todayCount}
          icon={CalendarDays}
          variant="primary"
        />
        <KpiCard
          title="This week"
          value={weekCount}
          icon={Clock}
          sub="appointments"
        />
        <KpiCard
          title="This month"
          value={thisMonthCount}
          icon={TrendingUp}
          trend={{ value: monthTrend, label: "vs last month" }}
          variant="success"
        />
        <KpiCard
          title="Total patients"
          value={totalPatients}
          icon={Users}
          variant="default"
        />
      </div>

      {/* Pending alert */}
      {pendingCount > 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm">
          <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
          <span className="text-amber-700">
            <span className="font-semibold">{pendingCount}</span> appointment
            {pendingCount !== 1 ? "s" : ""} pending confirmation.
          </span>
          <Link
            href="/appointments"
            className="ml-auto text-xs font-medium text-amber-700 underline-offset-4 hover:underline"
          >
            View →
          </Link>
        </div>
      )}

      {/* Revenue widget — click to open full transactions report */}
      <Link
        href="/revenue"
        className="block rounded-xl transition hover:ring-2 hover:ring-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        aria-label="Open revenue transactions report"
      >
        <RevenueWidget {...revenue} />
      </Link>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Today's schedule */}
        <div className="rounded-xl border border-border/50 bg-card">
          <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
            <div className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-primary" />
              <h2 className="font-semibold text-sm">Today&apos;s schedule</h2>
            </div>
            <Link
              href="/appointments"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              View calendar →
            </Link>
          </div>
          <div className="divide-y divide-border/50">
            {todayAppointments.length === 0 ? (
              <div className="flex flex-col items-center gap-1 py-10 text-center">
                <CheckCircle2 className="h-6 w-6 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No appointments today</p>
              </div>
            ) : (
              todayAppointments.slice(0, 6).map((appt) => (
                <div
                  key={appt.id}
                  className="flex items-center gap-3 px-5 py-3 hover:bg-muted/30 transition-colors"
                >
                  <div className="w-14 shrink-0 text-right">
                    <span className="text-xs font-mono font-medium tabular-nums">
                      {formatTime(appt.scheduled_at)}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {appt.patients?.full_name ?? "Unknown"}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      Dr. {appt.profiles?.full_name ?? "—"}
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
                  +{todayAppointments.length - 6} more
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
              <h2 className="font-semibold text-sm">Needs confirmation (next 7 days)</h2>
            </div>
          </div>
          <div className="divide-y divide-border/50">
            {upcomingAppointments.length === 0 ? (
              <div className="flex flex-col items-center gap-1 py-10 text-center">
                <CheckCircle2 className="h-6 w-6 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No pending confirmations</p>
              </div>
            ) : (
              upcomingAppointments.slice(0, 6).map((appt) => (
                <div
                  key={appt.id}
                  className="flex items-center gap-3 px-5 py-3 hover:bg-muted/30 transition-colors"
                >
                  <div className="w-16 shrink-0 text-right">
                    <span className="text-xs font-medium text-muted-foreground">
                      {formatDate(appt.scheduled_at)}
                    </span>
                    <p className="text-xs font-mono tabular-nums">
                      {formatTime(appt.scheduled_at)}
                    </p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {appt.patients?.full_name ?? "Unknown"}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      Dr. {appt.profiles?.full_name ?? "—"}
                    </p>
                  </div>
                  <StatusBadge status={appt.status} />
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
