"use client";

import { useState, useTransition } from "react";
import dynamic from "next/dynamic";
import {
  CalendarDays,
  Clock,
  TrendingUp,
  Users,
  Wallet,
  CheckCircle2,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { fetchDoctorDashboardStats, type DoctorDashboardStats } from "@/actions/doctor-dashboard";
import { formatDoctorName } from "@/lib/format-doctor";

const INPUT_CLS =
  "h-8 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground [color-scheme:light] dark:[color-scheme:dark] focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 disabled:opacity-50";

type FilterMode = "today" | "week" | "month" | "custom";

function fmtTRY(n: number) {
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(n) ? n : 0);
}

function pct(num: number, den: number) {
  if (den === 0) return 0;
  return Math.round((num / den) * 100);
}

function getDefaultRange(mode: FilterMode): { start: string; end: string } {
  const now = new Date();
  const tz = "Europe/Istanbul";
  const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const y = local.getFullYear();
  const mo = local.getMonth();
  const d = local.getDate();

  if (mode === "today") {
    const s = new Date(y, mo, d);
    const e = new Date(y, mo, d, 23, 59, 59, 999);
    return { start: s.toISOString(), end: e.toISOString() };
  }
  if (mode === "week") {
    const s = new Date(y, mo, d - 6);
    const e = new Date(y, mo, d, 23, 59, 59, 999);
    return { start: s.toISOString(), end: e.toISOString() };
  }
  if (mode === "month") {
    const s = new Date(y, mo, 1);
    const e = new Date(y, mo + 1, 0, 23, 59, 59, 999);
    return { start: s.toISOString(), end: e.toISOString() };
  }
  // custom default: current month
  const s = new Date(y, mo, 1);
  const e = new Date(y, mo + 1, 0, 23, 59, 59, 999);
  return { start: s.toISOString(), end: e.toISOString() };
}

function toDateInput(iso: string) {
  return iso.slice(0, 10);
}

const DoctorDashboardCharts = dynamic(
  () => import("./doctor-dashboard-charts"),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <Skeleton className="h-52 rounded-xl" />
          <Skeleton className="h-52 rounded-xl" />
        </div>
        <Skeleton className="h-60 w-full rounded-xl" />
      </div>
    ),
  },
);

export interface DoctorDashboardProps {
  fullName: string;
  clinicId: string;
  doctorId: string;
  departmentId: string;
  departmentName: string;
  initial: DoctorDashboardStats;
}

export function DoctorDashboard({
  fullName,
  clinicId,
  doctorId,
  departmentId,
  departmentName,
  initial,
}: DoctorDashboardProps) {
  const [stats, setStats] = useState<DoctorDashboardStats>(initial);
  const [filterMode, setFilterMode] = useState<FilterMode>("month");
  const [rangeFrom, setRangeFrom] = useState(() => toDateInput(getDefaultRange("month").start));
  const [rangeTo, setRangeTo] = useState(() => toDateInput(getDefaultRange("month").end));
  const [isPending, startTransition] = useTransition();

  function applyFilter(mode: FilterMode, from?: string, to?: string) {
    const range =
      mode === "custom"
        ? {
            start: new Date(from ?? rangeFrom).toISOString(),
            end: new Date((to ?? rangeTo) + "T23:59:59").toISOString(),
          }
        : getDefaultRange(mode);

    startTransition(async () => {
      const data = await fetchDoctorDashboardStats(
        clinicId,
        doctorId,
        departmentId,
        range.start,
        range.end,
      );
      setStats(data);
    });
  }

  function handleModeChange(mode: FilterMode) {
    setFilterMode(mode);
    if (mode !== "custom") applyFilter(mode);
  }

  function handleFromChange(val: string) {
    setRangeFrom(val);
    if (filterMode === "custom" && val && rangeTo) applyFilter("custom", val, rangeTo);
  }

  function handleToChange(val: string) {
    setRangeTo(val);
    if (filterMode === "custom" && rangeFrom && val) applyFilter("custom", rangeFrom, val);
  }

  const myCompletionRate = pct(stats.myCompleted, stats.myTotal - stats.myCancelled || stats.myTotal);
  const myPatientShareOfDept = pct(stats.myPatients, stats.deptPatients || 1);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Welcome back, {formatDoctorName(fullName)} · {departmentName}
          </p>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard title="Today" value={stats.todayAppts} icon={CalendarDays} variant="primary" sub="appointments" />
        <KpiCard title="This week" value={stats.weekAppts} icon={Clock} sub="appointments" />
        <KpiCard title="This month" value={stats.monthAppts} icon={TrendingUp} variant="success" sub="appointments" />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Period:</span>
        {(["today", "week", "month", "custom"] as FilterMode[]).map((m) => (
          <button
            key={m}
            onClick={() => handleModeChange(m)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              filterMode === m
                ? "bg-primary text-primary-foreground"
                : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {m === "today" ? "Today" : m === "week" ? "This week" : m === "month" ? "This month" : "Custom"}
          </button>
        ))}
        {filterMode === "custom" && (
          <>
            <input
              type="date"
              value={rangeFrom}
              onChange={(e) => handleFromChange(e.target.value)}
              className={INPUT_CLS}
            />
            <span className="text-xs text-muted-foreground">to</span>
            <input
              type="date"
              value={rangeTo}
              onChange={(e) => handleToChange(e.target.value)}
              className={INPUT_CLS}
            />
          </>
        )}
        {isPending && <span className="text-xs text-muted-foreground animate-pulse">Loading…</span>}
      </div>

      {/* Stats grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="My appointments"
          value={stats.myTotal}
          sub={`${stats.myCompleted} completed`}
          icon={CalendarDays}
          color="text-blue-600 dark:text-blue-400"
        />
        <StatCard
          label="My completion rate"
          value={`${myCompletionRate}%`}
          sub={`${stats.myNoShow} no-shows`}
          icon={CheckCircle2}
          color="text-emerald-600 dark:text-emerald-400"
        />
        <StatCard
          label="My patients (period)"
          value={stats.myPatients}
          sub={`${myPatientShareOfDept}% of dept`}
          icon={Users}
          color="text-violet-600 dark:text-violet-400"
        />
        <StatCard
          label="My revenue"
          value={fmtTRY(stats.myRevenue)}
          sub="from completed sessions"
          icon={Wallet}
          color="text-amber-600 dark:text-amber-400"
        />
      </div>

      {/* Charts — lazy-loaded so Recharts bundle doesn't block initial paint */}
      <DoctorDashboardCharts stats={stats} departmentName={departmentName} />
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: typeof CalendarDays;
  color: string;
}) {
  return (
    <div className="rounded-xl border border-border/50 bg-card p-4 space-y-2">
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${color}`} />
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
      </div>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}
