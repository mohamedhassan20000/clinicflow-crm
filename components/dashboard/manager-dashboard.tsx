"use client";

import { useState, useTransition, useCallback } from "react";
import {
  CalendarDays,
  TrendingUp,
  Users,
  XCircle,
  UserX,
  BarChart3,
  Download,
  Loader2,
} from "lucide-react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  PieChart,
  Pie,
  Cell,
  Legend,
  BarChart,
  Bar,
} from "recharts";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { KpiCard } from "@/components/dashboard/kpi-card";
import {
  fetchInsuranceBreakdown,
  fetchDoctorStats,
  fetchAppointmentsSeries,
  type DoctorStat,
} from "@/actions/manager-dashboard";

// ── Types ────────────────────────────────────────────────────────────────────

interface DailyPoint {
  date: string;
  appointments: number;
}

interface InsurancePoint {
  name: string;
  value: number;
}

export interface ManagerDashboardProps {
  clinicId: string;
  fullName: string;
  todayCount: number;
  weekCount: number;
  monthCount: number;
  noShowRate: number;
  cancelRate: number;
  totalPatients: number;
  initialDailySeries: DailyPoint[];
  initialInsuranceSeries: InsurancePoint[];
  initialDoctors: DoctorStat[];
}

// ── Chart colours (readable in both light and dark mode) ─────────────────────

const C = {
  blue: "#3B82F6",
  emerald: "#10B981",
  rose: "#F43F5E",
  amber: "#F59E0B",
  violet: "#8B5CF6",
  cyan: "#06B6D4",
  orange: "#F97316",
  indigo: "#6366F1",
};

const PIE_COLORS = [
  C.blue,
  C.violet,
  C.amber,
  C.emerald,
  C.rose,
  C.cyan,
  C.orange,
  C.indigo,
];

// ── Date helpers ─────────────────────────────────────────────────────────────

function currentYearMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoStr(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function monthToRange(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  const start = new Date(y, m - 1, 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(y, m, 0, 23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

function dateRangeToISO(from: string, to: string) {
  const s = new Date(from);
  s.setHours(0, 0, 0, 0);
  const e = new Date(to);
  e.setHours(23, 59, 59, 999);
  return { start: s.toISOString(), end: e.toISOString() };
}

// ── Shared UI pieces ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card/95 px-3 py-2 text-sm shadow-lg backdrop-blur-sm">
      <p className="mb-1 font-medium text-foreground">{label}</p>
      {payload.map(
        (p: { color: string; name: string; value: number }, i: number) => (
          <p key={i} className="text-xs" style={{ color: p.color }}>
            {p.name}:{" "}
            <span className="font-semibold">
              {typeof p.value === "number" && p.name.includes("₺")
                ? `₺${p.value.toLocaleString()}`
                : p.value}
            </span>
          </p>
        ),
      )}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function RevenueTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="rounded-lg border border-border bg-card/95 px-3 py-2 text-sm shadow-lg backdrop-blur-sm">
      <p className="mb-1 font-medium text-foreground">{label}</p>
      <p className="text-xs" style={{ color: p.color }}>
        Revenue:{" "}
        <span className="font-semibold">
          ₺{(p.value as number).toLocaleString()}
        </span>
      </p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
      No data for this period
    </div>
  );
}

type FilterMode = "month" | "range";

const INPUT_CLS =
  "h-8 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 disabled:opacity-50";

interface DateFilterProps {
  filterMode: FilterMode;
  month: string;
  rangeFrom: string;
  rangeTo: string;
  isPending?: boolean;
  onFilterModeChange: (m: FilterMode) => void;
  onMonthChange: (m: string) => void;
  onRangeFromChange: (d: string) => void;
  onRangeToChange: (d: string) => void;
}

function DateFilter({
  filterMode,
  month,
  rangeFrom,
  rangeTo,
  isPending,
  onFilterModeChange,
  onMonthChange,
  onRangeFromChange,
  onRangeToChange,
}: DateFilterProps) {
  const btnCls = (active: boolean) =>
    cn(
      "rounded px-2.5 py-0.5 text-xs font-medium transition-colors",
      active
        ? "bg-background text-foreground shadow-sm dark:bg-input/30 dark:text-foreground"
        : "text-muted-foreground hover:text-foreground",
    );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {isPending && (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
      )}
      <div className="flex items-center rounded-lg border border-input bg-muted p-[3px]">
        <button
          type="button"
          onClick={() => onFilterModeChange("month")}
          className={btnCls(filterMode === "month")}
        >
          Month
        </button>
        <button
          type="button"
          onClick={() => onFilterModeChange("range")}
          className={btnCls(filterMode === "range")}
        >
          Custom range
        </button>
      </div>

      {filterMode === "month" ? (
        <input
          type="month"
          value={month}
          max={currentYearMonth()}
          onChange={(e) => onMonthChange(e.target.value)}
          className={INPUT_CLS}
        />
      ) : (
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={rangeFrom}
            max={rangeTo || todayStr()}
            onChange={(e) => onRangeFromChange(e.target.value)}
            className={INPUT_CLS}
          />
          <span className="text-xs text-muted-foreground">to</span>
          <input
            type="date"
            value={rangeTo}
            min={rangeFrom}
            max={todayStr()}
            onChange={(e) => onRangeToChange(e.target.value)}
            className={INPUT_CLS}
          />
        </div>
      )}
    </div>
  );
}

// ── Appointments section ─────────────────────────────────────────────────────

function AppointmentsSection({
  clinicId,
  initialSeries,
}: {
  clinicId: string;
  initialSeries: DailyPoint[];
}) {
  const [rangeFrom, setRangeFrom] = useState(daysAgoStr(29));
  const [rangeTo, setRangeTo] = useState(todayStr());
  const [series, setSeries] = useState<DailyPoint[]>(initialSeries);
  const [isPending, startTransition] = useTransition();

  const refetch = useCallback(
    (from: string, to: string) => {
      if (!from || !to || from > to) return;
      const { start, end } = dateRangeToISO(from, to);
      startTransition(async () => {
        const data = await fetchAppointmentsSeries(clinicId, start, end);
        setSeries(data);
      });
    },
    [clinicId],
  );

  return (
    <div className="rounded-xl border border-border/60 bg-card p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">Appointments</h2>
        <div className="flex flex-wrap items-center gap-2">
          {isPending && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={rangeFrom}
              max={rangeTo || todayStr()}
              onChange={(e) => {
                setRangeFrom(e.target.value);
                refetch(e.target.value, rangeTo);
              }}
              className={INPUT_CLS}
            />
            <span className="text-xs text-muted-foreground">to</span>
            <input
              type="date"
              value={rangeTo}
              min={rangeFrom}
              max={todayStr()}
              onChange={(e) => {
                setRangeTo(e.target.value);
                refetch(rangeFrom, e.target.value);
              }}
              className={INPUT_CLS}
            />
          </div>
        </div>
      </div>

      <div className={cn("transition-opacity", isPending && "opacity-60")}>
        {series.length === 0 ? (
          <EmptyState />
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart
              data={series}
              margin={{ top: 4, right: 8, bottom: 0, left: -20 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="hsl(var(--border))"
                strokeOpacity={0.4}
              />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip content={<ChartTooltip />} />
              <Line
                type="monotone"
                dataKey="appointments"
                name="Appointments"
                stroke={C.blue}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0, fill: C.blue }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// ── Insurance section ────────────────────────────────────────────────────────

function InsuranceSection({
  clinicId,
  initialSeries,
}: {
  clinicId: string;
  initialSeries: InsurancePoint[];
}) {
  const [filterMode, setFilterMode] = useState<FilterMode>("month");
  const [month, setMonth] = useState(currentYearMonth());
  const [rangeFrom, setRangeFrom] = useState(daysAgoStr(29));
  const [rangeTo, setRangeTo] = useState(todayStr());
  const [series, setSeries] = useState<InsurancePoint[]>(initialSeries);
  const [isPending, startTransition] = useTransition();

  const refetch = useCallback(
    (start: string, end: string) => {
      startTransition(async () => {
        const data = await fetchInsuranceBreakdown(clinicId, start, end);
        setSeries(data);
      });
    },
    [clinicId],
  );

  function handleFilterModeChange(m: FilterMode) {
    setFilterMode(m);
    if (m === "month") {
      const { start, end } = monthToRange(month);
      refetch(start, end);
    } else if (rangeFrom && rangeTo && rangeFrom <= rangeTo) {
      const { start, end } = dateRangeToISO(rangeFrom, rangeTo);
      refetch(start, end);
    }
  }

  function handleMonthChange(m: string) {
    setMonth(m);
    const { start, end } = monthToRange(m);
    refetch(start, end);
  }

  function handleRangeFromChange(d: string) {
    setRangeFrom(d);
    if (d && rangeTo && d <= rangeTo) {
      const { start, end } = dateRangeToISO(d, rangeTo);
      refetch(start, end);
    }
  }

  function handleRangeToChange(d: string) {
    setRangeTo(d);
    if (rangeFrom && d && rangeFrom <= d) {
      const { start, end } = dateRangeToISO(rangeFrom, d);
      refetch(start, end);
    }
  }

  return (
    <div className="rounded-xl border border-border/60 bg-card p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">
          Insurance breakdown
        </h2>
        <DateFilter
          filterMode={filterMode}
          month={month}
          rangeFrom={rangeFrom}
          rangeTo={rangeTo}
          isPending={isPending}
          onFilterModeChange={handleFilterModeChange}
          onMonthChange={handleMonthChange}
          onRangeFromChange={handleRangeFromChange}
          onRangeToChange={handleRangeToChange}
        />
      </div>

      <div className={cn("transition-opacity", isPending && "opacity-60")}>
        {series.length === 0 ? (
          <EmptyState />
        ) : (
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie
                data={series}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={92}
                paddingAngle={2}
                dataKey="value"
              >
                {series.map((_, i) => (
                  <Cell
                    key={i}
                    fill={PIE_COLORS[i % PIE_COLORS.length]}
                    stroke="transparent"
                  />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltip />} />
              <Legend
                iconType="circle"
                iconSize={8}
                wrapperStyle={{
                  fontSize: 11,
                  color: "hsl(var(--foreground))",
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// ── Doctors section ──────────────────────────────────────────────────────────

type DoctorMode = "appointments" | "revenue";

function DoctorsSection({
  clinicId,
  initialDoctors,
}: {
  clinicId: string;
  initialDoctors: DoctorStat[];
}) {
  const [filterMode, setFilterMode] = useState<FilterMode>("month");
  const [month, setMonth] = useState(currentYearMonth());
  const [rangeFrom, setRangeFrom] = useState(daysAgoStr(29));
  const [rangeTo, setRangeTo] = useState(todayStr());
  const [doctorMode, setDoctorMode] = useState<DoctorMode>("appointments");
  const [doctors, setDoctors] = useState<DoctorStat[]>(initialDoctors);
  const [isPending, startTransition] = useTransition();

  const refetch = useCallback(
    (start: string, end: string) => {
      startTransition(async () => {
        const data = await fetchDoctorStats(clinicId, start, end);
        setDoctors(data);
      });
    },
    [clinicId],
  );

  function handleFilterModeChange(m: FilterMode) {
    setFilterMode(m);
    if (m === "month") {
      const { start, end } = monthToRange(month);
      refetch(start, end);
    } else if (rangeFrom && rangeTo && rangeFrom <= rangeTo) {
      const { start, end } = dateRangeToISO(rangeFrom, rangeTo);
      refetch(start, end);
    }
  }

  function handleMonthChange(m: string) {
    setMonth(m);
    const { start, end } = monthToRange(m);
    refetch(start, end);
  }

  function handleRangeFromChange(d: string) {
    setRangeFrom(d);
    if (d && rangeTo && d <= rangeTo) {
      const { start, end } = dateRangeToISO(d, rangeTo);
      refetch(start, end);
    }
  }

  function handleRangeToChange(d: string) {
    setRangeTo(d);
    if (rangeFrom && d && rangeFrom <= d) {
      const { start, end } = dateRangeToISO(rangeFrom, d);
      refetch(start, end);
    }
  }

  const chartData = doctors.map((d) => ({
    ...d,
    other: Math.max(0, d.total - d.confirmed - d.cancelled),
  }));

  const barHeight = Math.max(220, doctors.length * 48);

  const doctorBtnCls = (active: boolean) =>
    cn(
      "rounded px-2.5 py-0.5 text-xs font-medium transition-colors",
      active
        ? "bg-background text-foreground shadow-sm dark:bg-input/30 dark:text-foreground"
        : "text-muted-foreground hover:text-foreground",
    );

  return (
    <div className="rounded-xl border border-border/60 bg-card p-5 shadow-sm">
      {/* Header row */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">All doctors</h2>
          <div className="flex items-center rounded-lg border border-input bg-muted p-[3px]">
            <button
              type="button"
              onClick={() => setDoctorMode("appointments")}
              className={doctorBtnCls(doctorMode === "appointments")}
            >
              By appointments
            </button>
            <button
              type="button"
              onClick={() => setDoctorMode("revenue")}
              className={doctorBtnCls(doctorMode === "revenue")}
            >
              By revenue
            </button>
          </div>
        </div>
        <DateFilter
          filterMode={filterMode}
          month={month}
          rangeFrom={rangeFrom}
          rangeTo={rangeTo}
          isPending={isPending}
          onFilterModeChange={handleFilterModeChange}
          onMonthChange={handleMonthChange}
          onRangeFromChange={handleRangeFromChange}
          onRangeToChange={handleRangeToChange}
        />
      </div>

      <div className={cn("transition-opacity", isPending && "opacity-60")}>
        {doctors.length === 0 ? (
          <EmptyState />
        ) : doctorMode === "appointments" ? (
          <ResponsiveContainer width="100%" height={barHeight}>
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 0, right: 16, bottom: 0, left: 0 }}
            >
              <CartesianGrid
                horizontal={false}
                strokeDasharray="3 3"
                stroke="hsl(var(--border))"
                strokeOpacity={0.4}
              />
              <XAxis
                type="number"
                allowDecimals={false}
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                type="category"
                dataKey="name"
                width={100}
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip content={<ChartTooltip />} />
              <Legend
                iconType="rect"
                iconSize={8}
                wrapperStyle={{
                  fontSize: 11,
                  color: "hsl(var(--foreground))",
                }}
              />
              <Bar
                dataKey="confirmed"
                name="Confirmed"
                fill={C.emerald}
                stackId="a"
                maxBarSize={22}
              />
              <Bar
                dataKey="cancelled"
                name="Cancelled"
                fill={C.rose}
                stackId="a"
                maxBarSize={22}
              />
              <Bar
                dataKey="other"
                name="Other"
                fill={C.blue}
                stackId="a"
                maxBarSize={22}
                radius={[0, 4, 4, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height={barHeight}>
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 0, right: 16, bottom: 0, left: 0 }}
            >
              <CartesianGrid
                horizontal={false}
                strokeDasharray="3 3"
                stroke="hsl(var(--border))"
                strokeOpacity={0.4}
              />
              <XAxis
                type="number"
                allowDecimals={false}
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `₺${v.toLocaleString()}`}
              />
              <YAxis
                type="category"
                dataKey="name"
                width={100}
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip content={<RevenueTooltip />} />
              <Bar
                dataKey="revenue"
                name="Revenue (₺)"
                fill={C.amber}
                radius={[0, 4, 4, 0]}
                maxBarSize={22}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// ── Main export ──────────────────────────────────────────────────────────────

export function ManagerDashboard({
  clinicId,
  fullName,
  todayCount,
  weekCount,
  monthCount,
  noShowRate,
  cancelRate,
  totalPatients,
  initialDailySeries,
  initialInsuranceSeries,
  initialDoctors,
}: ManagerDashboardProps) {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground">
            Welcome back, {fullName}.
          </p>
        </div>
        <a href="/appointments/export" download>
          <Button variant="outline" size="sm" className="gap-2">
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
        </a>
      </div>

      {/* KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          title="Today"
          value={todayCount}
          icon={CalendarDays}
          variant="primary"
        />
        <KpiCard title="This week" value={weekCount} icon={TrendingUp} />
        <KpiCard
          title="This month"
          value={monthCount}
          icon={BarChart3}
          variant="success"
        />
        <KpiCard title="Total patients" value={totalPatients} icon={Users} />
        <KpiCard
          title="No-show rate"
          value={`${noShowRate}%`}
          icon={UserX}
          variant={noShowRate > 10 ? "warning" : "default"}
        />
        <KpiCard
          title="Cancellation rate"
          value={`${cancelRate}%`}
          icon={XCircle}
          variant={cancelRate > 15 ? "warning" : "default"}
        />
      </div>

      {/* Appointments with date range picker */}
      <AppointmentsSection clinicId={clinicId} initialSeries={initialDailySeries} />

      {/* Insurance + Doctors side by side on large screens */}
      <div className="grid gap-6 xl:grid-cols-2">
        <InsuranceSection clinicId={clinicId} initialSeries={initialInsuranceSeries} />
        <DoctorsSection clinicId={clinicId} initialDoctors={initialDoctors} />
      </div>
    </div>
  );
}
