"use client";

import { useState, useTransition } from "react";
import {
  CalendarDays,
  Clock,
  TrendingUp,
  Users,
  Activity,
  Wallet,
  XCircle,
  CheckCircle2,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
} from "recharts";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { fetchDoctorDashboardStats, type DoctorDashboardStats } from "@/actions/doctor-dashboard";

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
  const deptNoShowRate = pct(stats.deptNoShow, stats.deptTotal);
  const deptCancelRate = pct(stats.deptCancelled, stats.deptTotal);
  const myPatientShareOfDept = pct(stats.myPatients, stats.deptPatients || 1);
  const deptPatientShareOfClinic = pct(stats.deptPatients, stats.clinicPatients || 1);

  const patientShareData = [
    { name: "My patients", value: stats.myPatients, color: "#3B82F6" },
    { name: "Dept (others)", value: Math.max(0, stats.deptPatients - stats.myPatients), color: "#10B981" },
    { name: "Clinic (other depts)", value: Math.max(0, stats.clinicPatients - stats.deptPatients), color: "#94A3B8" },
  ].filter((d) => d.value > 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Welcome back, Dr. {fullName} · {departmentName}
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

      {/* Department section */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Dept rates */}
        <div className="rounded-xl border border-border/50 bg-card p-5 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {departmentName} — Department rates
          </h2>
          <div className="space-y-3">
            <RateRow label="Completion rate" value={pct(stats.deptCompleted, stats.deptTotal)} color="bg-emerald-500" />
            <RateRow label="No-show rate" value={deptNoShowRate} color="bg-amber-500" />
            <RateRow label="Cancellation rate" value={deptCancelRate} color="bg-rose-500" />
          </div>
          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border/30">
            <MiniStat label="Dept total appts" value={stats.deptTotal} />
            <MiniStat label="Dept patients" value={stats.deptPatients} />
            <MiniStat label="Dept revenue" value={fmtTRY(stats.deptRevenue)} />
            <MiniStat label="No-shows" value={stats.deptNoShow} />
          </div>
        </div>

        {/* Patient share */}
        <div className="rounded-xl border border-border/50 bg-card p-5 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Patient share
          </h2>
          <div className="flex items-center gap-4">
            <div className="flex-1 space-y-2">
              <ShareRow
                label="My patients / dept"
                myVal={stats.myPatients}
                totalVal={stats.deptPatients}
                pctVal={myPatientShareOfDept}
                color="#3B82F6"
              />
              <ShareRow
                label="Dept patients / clinic"
                myVal={stats.deptPatients}
                totalVal={stats.clinicPatients}
                pctVal={deptPatientShareOfClinic}
                color="#10B981"
              />
            </div>
            {patientShareData.length > 0 && (
              <div className="h-28 w-28 shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={patientShareData}
                      cx="50%"
                      cy="50%"
                      innerRadius={28}
                      outerRadius={48}
                      dataKey="value"
                      strokeWidth={0}
                    >
                      {patientShareData.map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        background: "var(--card)",
                        border: "1px solid var(--border)",
                        borderRadius: "8px",
                        fontSize: "11px",
                      }}
                      formatter={(val, name) => [`${val} patients`, name]}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-3 pt-1">
            {patientShareData.map((d) => (
              <span key={d.name} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: d.color }} />
                {d.name}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Follow-up outcomes */}
      {stats.followUpOutcomes.total > 0 && (() => {
        const fuData = [
          { name: "All fine", value: stats.followUpOutcomes.allFine, color: "#10B981" },
          { name: "Has problem", value: stats.followUpOutcomes.hasProblem, color: "#F59E0B" },
        ].filter((d) => d.value > 0);
        const total = stats.followUpOutcomes.total;
        return (
          <div className="rounded-xl border border-border/50 bg-card p-5 space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              My patients — Follow-up outcomes
            </h2>
            <div className="flex flex-wrap items-center gap-6">
              <div className="h-32 w-32 shrink-0">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={fuData}
                      cx="50%"
                      cy="50%"
                      innerRadius={30}
                      outerRadius={52}
                      dataKey="value"
                      strokeWidth={0}
                    >
                      {fuData.map((entry, i) => (
                        <Cell key={i} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        background: "var(--card)",
                        border: "1px solid var(--border)",
                        borderRadius: "8px",
                        fontSize: "11px",
                      }}
                      formatter={(val, name) => [`${val} (${pct(Number(val), total)}%)`, name]}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="space-y-3 flex-1">
                {fuData.map((d) => (
                  <div key={d.name} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: d.color }} />
                        {d.name}
                      </span>
                      <span className="font-semibold tabular-nums">
                        {d.value} ({pct(d.value, total)}%)
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted/50 overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${pct(d.value, total)}%`, backgroundColor: d.color }}
                      />
                    </div>
                  </div>
                ))}
                <p className="text-[10px] text-muted-foreground pt-1">
                  {total} follow-up{total !== 1 ? "s" : ""} recorded in this period
                </p>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Appointments chart */}
      <div className="rounded-xl border border-border/50 bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Appointments over time
        </h2>
        {stats.dailySeries.length > 1 ? (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={stats.dailySeries} margin={{ top: 4, right: 16, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--card)",
                  border: "1px solid var(--border)",
                  borderRadius: "8px",
                  fontSize: "12px",
                }}
              />
              <Legend wrapperStyle={{ fontSize: "12px" }} />
              <Line
                type="monotone"
                dataKey="mine"
                name="My appointments"
                stroke="#3B82F6"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="dept"
                name="Department total"
                stroke="#10B981"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                strokeDasharray="4 2"
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
            Not enough data to chart.
          </div>
        )}
      </div>
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

function RateRow({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold tabular-nums">{value}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted/50 overflow-hidden">
        <div
          className={`h-full rounded-full ${color}`}
          style={{ width: `${Math.min(100, value)}%` }}
        />
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function ShareRow({
  label,
  myVal,
  totalVal,
  pctVal,
  color,
}: {
  label: string;
  myVal: number;
  totalVal: number;
  pctVal: number;
  color: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold tabular-nums">
          {myVal}/{totalVal} ({pctVal}%)
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-muted/50 overflow-hidden">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.min(100, pctVal)}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}
