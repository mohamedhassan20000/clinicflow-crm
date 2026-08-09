"use client";

import { useState, useTransition, useCallback } from "react";
import { Loader2 } from "lucide-react";
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
import {
  fetchInsuranceBreakdown,
  fetchDoctorStats,
  fetchAppointmentsSeries,
  fetchDepartmentStats,
  fetchReceptionistStats,
  fetchFollowUpOutcomes,
  type DoctorStat,
  type DepartmentStat,
  type ReceptionistStat,
  type FollowUpOutcomes,
} from "@/actions/manager-dashboard";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { useTranslations } from "next-intl";
import { DateRangePicker, MonthPicker } from "@/components/ui/clinic-date-picker";

// ── Exported types (re-exported through analytics-section.tsx) ────────────────

export interface DailyPoint {
  date: string;
  appointments: number;
}

export interface InsurancePoint {
  name: string;
  value: number;
}

export interface AnalyticsSectionChartsProps {
  clinicId: string;
  initialDailySeries: DailyPoint[];
  initialInsuranceSeries: InsurancePoint[];
  initialDoctors: DoctorStat[];
  initialDepartments: DepartmentStat[];
  initialReceptionists: ReceptionistStat[];
  initialFollowUpOutcomes: FollowUpOutcomes;
  departmentsList: { id: string; name: string }[];
  doctorsList: { id: string; name: string }[];
}

// ── Chart colours ─────────────────────────────────────────────────────────────

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

const PIE_COLORS = [C.blue, C.violet, C.amber, C.emerald, C.rose, C.cyan, C.orange, C.indigo];

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

// ── Shared chart primitives ───────────────────────────────────────────────────

const INPUT_CLS =
  "h-8 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground [color-scheme:light] dark:[color-scheme:dark] focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 disabled:opacity-50";

const TICK = { fontSize: 11, fill: "var(--muted-foreground)" };
const GRID_PROPS = { stroke: "var(--border)", strokeOpacity: 0.4, strokeDasharray: "3 3" };
const LEGEND_STYLE = { fontSize: 11, color: "var(--foreground)" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-lg">
      <p className="mb-1 font-medium text-foreground">{label}</p>
      {payload.map((p: { color: string; name: string; value: number }, i: number) => (
        <p key={i} className="text-xs" style={{ color: p.color }}>
          {p.name}: <span className="font-semibold text-foreground">{p.value}</span>
        </p>
      ))}
    </div>
  );
}

type RevenueTooltipPayload = {
  color: string;
  value: number;
};

function RevenueTooltip({
  active,
  payload,
  label,
  formatAmount,
}: {
  active?: boolean;
  payload?: RevenueTooltipPayload[];
  label?: string;
  formatAmount: (value: number) => string;
}) {
  const t = useTranslations("dashboard");
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-lg">
      <p className="mb-1 font-medium text-foreground">{label}</p>
      <p className="text-xs" style={{ color: p.color }}>
        {t("revenueAmount", { amount: formatAmount(p.value as number) })}
      </p>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function InsuranceTooltip({ active, payload, total }: any & { total: number }) {
  const t = useTranslations("dashboard");
  if (!active || !payload?.length) return null;
  const p = payload[0];
  const pct = total > 0 ? Math.round((p.value / total) * 100) : 0;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-lg">
      <p className="mb-1 font-medium text-foreground">{p.name}</p>
      <p className="text-xs" style={{ color: p.payload.fill }}>
        {t("appointmentCount", { count: Number(p.value) })}{" "}
        <span className="font-semibold text-foreground">({pct}%)</span>
      </p>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function DoctorTooltip({ active, payload, label, totalAppts }: any & { totalAppts: number }) {
  const t = useTranslations("dashboard");
  if (!active || !payload?.length) return null;
  const entry = payload[0]?.payload as DoctorStat | undefined;
  if (!entry) return null;
  const pct = totalAppts > 0 ? Math.round((entry.total / totalAppts) * 100) : 0;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-lg">
      <p className="mb-1 font-medium text-foreground">{label}</p>
      <p className="mb-1 text-xs text-muted-foreground">
        {t("clinicAppointmentShare", { count: entry.total, percent: `${pct}%` })}
      </p>
      {payload.map((p: { color: string; name: string; value: number }, i: number) => (
        <p key={i} className="text-xs" style={{ color: p.color }}>
          {p.name}: <span className="font-semibold text-foreground">{p.value}</span>
        </p>
      ))}
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ReceptionistTooltip({ active, payload, label, totalAppts }: any & { totalAppts: number }) {
  const t = useTranslations("dashboard");
  if (!active || !payload?.length) return null;
  const entry = payload[0]?.payload as ReceptionistStat | undefined;
  if (!entry) return null;
  const pct = totalAppts > 0 ? Math.round((entry.total / totalAppts) * 100) : 0;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-lg">
      <p className="mb-1 font-medium text-foreground">{label}</p>
      <p className="mb-1 text-xs text-muted-foreground">
        {t("totalBookingShare", { count: entry.total, percent: `${pct}%` })}
      </p>
      {payload.map((p: { color: string; name: string; value: number }, i: number) => (
        <p key={i} className="text-xs" style={{ color: p.color }}>
          {p.name}: <span className="font-semibold text-foreground">{p.value}</span>
        </p>
      ))}
    </div>
  );
}

function DeptTooltip({
  active,
  payload,
  label,
  deptMode,
  totalAppts,
  totalPatients,
}: {
  active?: boolean;
  payload?: {
    color: string;
    name: string;
    value: number;
    payload?: DepartmentStat;
  }[];
  label?: string;
  deptMode: DeptMode;
  totalAppts: number;
  totalPatients: number;
}) {
  if (!active || !payload?.length) return null;
  const entry = payload[0]?.payload as DepartmentStat | undefined;
  if (!entry) return null;
  const p = payload[0];
  let pct = 0;
  if (deptMode === "appointments" && totalAppts > 0) pct = Math.round((entry.appointments / totalAppts) * 100);
  else if (deptMode === "patients" && totalPatients > 0) pct = Math.round((entry.patients / totalPatients) * 100);
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-lg">
      <p className="mb-1 font-medium text-foreground">{label}</p>
      <p className="text-xs" style={{ color: p.color }}>
        {p.name}: <span className="font-semibold text-foreground">{p.value}</span>
        {deptMode !== "revenue" && <span className="text-muted-foreground"> ({pct}%)</span>}
      </p>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function OutcomeTooltip({ active, payload, countedTotal }: any & { countedTotal: number }) {
  const t = useTranslations("dashboard");
  if (!active || !payload?.length) return null;
  const p = payload[0];
  const pct = countedTotal > 0 ? Math.round((p.value / countedTotal) * 100) : 0;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-lg">
      <p className="mb-1 font-medium text-foreground">{p.name}</p>
      <p className="text-xs" style={{ color: p.payload.fill }}>
        {t("followupCount", { count: Number(p.value) })}{" "}
        <span className="font-semibold text-foreground">({pct}%)</span>
      </p>
    </div>
  );
}

function EmptyState() {
  const t = useTranslations("dashboard");
  return (
    <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
      {t("noDataForThisPeriod")}</div>
  );
}

type FilterMode = "month" | "range";

function modeBtnCls(active: boolean) {
  return cn(
    "rounded px-2.5 py-0.5 text-xs font-medium transition-colors",
    active
      ? "bg-background text-foreground shadow-sm dark:bg-input/30"
      : "text-muted-foreground hover:text-foreground",
  );
}

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
  const t = useTranslations("dashboard");
  return (
    <div className="flex flex-wrap items-center gap-2">
      {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      <div className="flex items-center rounded-lg border border-input bg-muted p-[3px]">
        <button type="button" onClick={() => onFilterModeChange("month")} className={modeBtnCls(filterMode === "month")}>
          {t("month")}</button>
        <button type="button" onClick={() => onFilterModeChange("range")} className={modeBtnCls(filterMode === "range")}>
          {t("customRange")}</button>
      </div>
      {filterMode === "month" ? (
        <MonthPicker
          value={month}
          max={currentYearMonth()}
          onChange={onMonthChange}
          label={t("month")}
          compact
          className={INPUT_CLS}
        />
      ) : (
        <DateRangePicker
          from={rangeFrom}
          to={rangeTo}
          max={todayStr()}
          onFromChange={onRangeFromChange}
          onToChange={onRangeToChange}
          labels={{ from: t("from"), to: t("to") }}
          className="w-full sm:w-[19rem]"
          compact
          enforceOrder
        />
      )}
    </div>
  );
}

function useDateFilter(refetchFn: (start: string, end: string) => void) {
  const [filterMode, setFilterMode] = useState<FilterMode>("month");
  const [month, setMonth] = useState(currentYearMonth());
  const [rangeFrom, setRangeFrom] = useState(daysAgoStr(29));
  const [rangeTo, setRangeTo] = useState(todayStr());

  function handleFilterModeChange(m: FilterMode) {
    setFilterMode(m);
    if (m === "month") {
      const { start, end } = monthToRange(month);
      refetchFn(start, end);
    } else if (rangeFrom && rangeTo && rangeFrom <= rangeTo) {
      const { start, end } = dateRangeToISO(rangeFrom, rangeTo);
      refetchFn(start, end);
    }
  }

  function handleMonthChange(m: string) {
    setMonth(m);
    const { start, end } = monthToRange(m);
    refetchFn(start, end);
  }

  function handleRangeFromChange(d: string) {
    setRangeFrom(d);
    if (d && rangeTo && d <= rangeTo) {
      const { start, end } = dateRangeToISO(d, rangeTo);
      refetchFn(start, end);
    }
  }

  function handleRangeToChange(d: string) {
    setRangeTo(d);
    if (rangeFrom && d && rangeFrom <= d) {
      const { start, end } = dateRangeToISO(rangeFrom, d);
      refetchFn(start, end);
    }
  }

  return { filterMode, month, rangeFrom, rangeTo, handleFilterModeChange, handleMonthChange, handleRangeFromChange, handleRangeToChange };
}

// ── Horizontal bar chart helpers ──────────────────────────────────────────────

function HBarChart({ data, yWidth = 110, children }: { data: object[]; yWidth?: number; children: React.ReactNode }) {
  const h = Math.max(220, data.length * 48);
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 /* rtl-allow: Recharts margin is the chart's own LTR coordinate space, not page layout (AI_AGENT_PLAN §4.2 step 4) */ }}>
        <CartesianGrid horizontal={false} {...GRID_PROPS} />
        <XAxis type="number" allowDecimals={false} tick={TICK} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="name" width={yWidth} tick={TICK} tickLine={false} axisLine={false} />
        {children}
      </BarChart>
    </ResponsiveContainer>
  );
}

function HBarChartRevenue({ data, yWidth = 110 }: { data: object[]; yWidth?: number }) {
  const t = useTranslations("dashboard");
  const { formatCurrency } = useClinicSettings();
  const fmtMoney = (value: number) =>
    formatCurrency(value, { maximumFractionDigits: 0 });
  const h = Math.max(220, data.length * 48);
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 /* rtl-allow: Recharts margin is the chart's own LTR coordinate space, not page layout (AI_AGENT_PLAN §4.2 step 4) */ }}>
        <CartesianGrid horizontal={false} {...GRID_PROPS} />
        <XAxis type="number" allowDecimals={false} tick={TICK} tickLine={false} axisLine={false} tickFormatter={(v) => fmtMoney(Number(v))} />
        <YAxis type="category" dataKey="name" width={yWidth} tick={TICK} tickLine={false} axisLine={false} />
        <Tooltip content={<RevenueTooltip formatAmount={fmtMoney} />} />
        <Bar dataKey="revenue" name={t("revenue")} fill={C.amber} radius={[0, 4, 4, 0]} maxBarSize={22} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── Appointments section ──────────────────────────────────────────────────────

function AppointmentsSection({ clinicId, initialSeries }: { clinicId: string; initialSeries: DailyPoint[] }) {
  const t = useTranslations("dashboard");
  const [series, setSeries] = useState<DailyPoint[]>(initialSeries);
  const [isPending, startTransition] = useTransition();

  const refetch = useCallback((start: string, end: string) => {
    startTransition(async () => {
      const data = await fetchAppointmentsSeries(clinicId, start, end);
      setSeries(data);
    });
  }, [clinicId]);

  const df = useDateFilter(refetch);

  return (
    <div className="rounded-xl border border-border/60 bg-card p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">{t("appointments")}</h3>
        <DateFilter filterMode={df.filterMode} month={df.month} rangeFrom={df.rangeFrom} rangeTo={df.rangeTo} isPending={isPending} onFilterModeChange={df.handleFilterModeChange} onMonthChange={df.handleMonthChange} onRangeFromChange={df.handleRangeFromChange} onRangeToChange={df.handleRangeToChange} />
      </div>
      <div className={cn("transition-opacity", isPending && "opacity-60")}>
        {series.length === 0 ? <EmptyState /> : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: -20 /* rtl-allow: Recharts margin is the chart's own LTR coordinate space, not page layout (AI_AGENT_PLAN §4.2 step 4) */ }}>
              <CartesianGrid {...GRID_PROPS} />
              <XAxis dataKey="date" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <YAxis allowDecimals={false} tick={TICK} tickLine={false} axisLine={false} />
              <Tooltip content={<ChartTooltip />} />
              <Line type="monotone" dataKey="appointments" name={t("appointments")} stroke={C.blue} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 0, fill: C.blue }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// ── Insurance section ─────────────────────────────────────────────────────────

function InsuranceSection({ clinicId, initialSeries }: { clinicId: string; initialSeries: InsurancePoint[] }) {
  const t = useTranslations("dashboard");
  const [series, setSeries] = useState<InsurancePoint[]>(initialSeries);
  const [isPending, startTransition] = useTransition();

  const refetch = useCallback((start: string, end: string) => {
    startTransition(async () => {
      const data = await fetchInsuranceBreakdown(clinicId, start, end);
      setSeries(data);
    });
  }, [clinicId]);

  const df = useDateFilter(refetch);
  const total = series.reduce((sum, s) => sum + s.value, 0);

  return (
    <div className="rounded-xl border border-border/60 bg-card p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">{t("insuranceBreakdown")}</h3>
        <DateFilter filterMode={df.filterMode} month={df.month} rangeFrom={df.rangeFrom} rangeTo={df.rangeTo} isPending={isPending} onFilterModeChange={df.handleFilterModeChange} onMonthChange={df.handleMonthChange} onRangeFromChange={df.handleRangeFromChange} onRangeToChange={df.handleRangeToChange} />
      </div>
      <div className={cn("transition-opacity", isPending && "opacity-60")}>
        {series.length === 0 ? <EmptyState /> : (
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={series} cx="50%" cy="50%" innerRadius={60} outerRadius={92} paddingAngle={2} dataKey="value">
                {series.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} stroke="transparent" />)}
              </Pie>
              <Tooltip content={<InsuranceTooltip total={total} />} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={LEGEND_STYLE} />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// ── Doctors section ───────────────────────────────────────────────────────────

type DoctorMode = "appointments" | "revenue";

function DoctorsSection({ clinicId, initialDoctors }: { clinicId: string; initialDoctors: DoctorStat[] }) {
  const t = useTranslations("dashboard");
  const [doctorMode, setDoctorMode] = useState<DoctorMode>("appointments");
  const [doctors, setDoctors] = useState<DoctorStat[]>(initialDoctors);
  const [isPending, startTransition] = useTransition();

  const refetch = useCallback((start: string, end: string) => {
    startTransition(async () => {
      const data = await fetchDoctorStats(clinicId, start, end);
      setDoctors(data);
    });
  }, [clinicId]);

  const df = useDateFilter(refetch);
  const chartData = doctors.map((d) => ({ ...d, other: Math.max(0, d.total - d.confirmed - d.cancelled) }));
  const totalAppts = doctors.reduce((sum, d) => sum + d.total, 0);

  return (
    <div className="rounded-xl border border-border/60 bg-card p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{t("allDoctors")}</h3>
          <div className="flex items-center rounded-lg border border-input bg-muted p-[3px]">
            <button type="button" onClick={() => setDoctorMode("appointments")} className={modeBtnCls(doctorMode === "appointments")}>{t("byAppointments")}</button>
            <button type="button" onClick={() => setDoctorMode("revenue")} className={modeBtnCls(doctorMode === "revenue")}>{t("byRevenue")}</button>
          </div>
        </div>
        <DateFilter filterMode={df.filterMode} month={df.month} rangeFrom={df.rangeFrom} rangeTo={df.rangeTo} isPending={isPending} onFilterModeChange={df.handleFilterModeChange} onMonthChange={df.handleMonthChange} onRangeFromChange={df.handleRangeFromChange} onRangeToChange={df.handleRangeToChange} />
      </div>
      <div className={cn("transition-opacity", isPending && "opacity-60")}>
        {doctors.length === 0 ? <EmptyState /> : doctorMode === "appointments" ? (
          <HBarChart data={chartData}>
            <Tooltip content={<DoctorTooltip totalAppts={totalAppts} />} />
            <Legend iconType="rect" iconSize={8} wrapperStyle={LEGEND_STYLE} />
            <Bar dataKey="confirmed" name={t("confirmed")} fill={C.emerald} stackId="a" maxBarSize={22} />
            <Bar dataKey="cancelled" name={t("cancelled")} fill={C.rose} stackId="a" maxBarSize={22} />
            <Bar dataKey="other" name={t("other")} fill={C.blue} stackId="a" maxBarSize={22} radius={[0, 4, 4, 0]} />
          </HBarChart>
        ) : (
          <HBarChartRevenue data={chartData} />
        )}
      </div>
    </div>
  );
}

// ── Receptionists section ─────────────────────────────────────────────────────

function ReceptionistSection({ clinicId, initialReceptionists }: { clinicId: string; initialReceptionists: ReceptionistStat[] }) {
  const t = useTranslations("dashboard");
  const [receptionists, setReceptionists] = useState<ReceptionistStat[]>(initialReceptionists);
  const [isPending, startTransition] = useTransition();

  const refetch = useCallback((start: string, end: string) => {
    startTransition(async () => {
      const data = await fetchReceptionistStats(clinicId, start, end);
      setReceptionists(data);
    });
  }, [clinicId]);

  const df = useDateFilter(refetch);
  const chartData = receptionists.map((r) => ({ ...r, other: Math.max(0, r.total - r.confirmed - r.cancelled) }));
  const totalAppts = receptionists.reduce((sum, r) => sum + r.total, 0);

  return (
    <div className="rounded-xl border border-border/60 bg-card p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">{t("allReceptionists")}</h3>
        <DateFilter filterMode={df.filterMode} month={df.month} rangeFrom={df.rangeFrom} rangeTo={df.rangeTo} isPending={isPending} onFilterModeChange={df.handleFilterModeChange} onMonthChange={df.handleMonthChange} onRangeFromChange={df.handleRangeFromChange} onRangeToChange={df.handleRangeToChange} />
      </div>
      <div className={cn("transition-opacity", isPending && "opacity-60")}>
        {receptionists.length === 0 ? <EmptyState /> : (
          <HBarChart data={chartData}>
            <Tooltip content={<ReceptionistTooltip totalAppts={totalAppts} />} />
            <Legend iconType="rect" iconSize={8} wrapperStyle={LEGEND_STYLE} />
            <Bar dataKey="confirmed" name={t("confirmed")} fill={C.emerald} stackId="a" maxBarSize={22} />
            <Bar dataKey="cancelled" name={t("cancelled")} fill={C.rose} stackId="a" maxBarSize={22} />
            <Bar dataKey="other" name={t("other")} fill={C.blue} stackId="a" maxBarSize={22} radius={[0, 4, 4, 0]} />
          </HBarChart>
        )}
      </div>
    </div>
  );
}

// ── Department section ────────────────────────────────────────────────────────

type DeptMode = "appointments" | "patients" | "revenue";

function DepartmentSection({ clinicId, initialDepartments }: { clinicId: string; initialDepartments: DepartmentStat[] }) {
  const t = useTranslations("dashboard");
  const [deptMode, setDeptMode] = useState<DeptMode>("appointments");
  const [departments, setDepartments] = useState<DepartmentStat[]>(initialDepartments);
  const [isPending, startTransition] = useTransition();

  const refetch = useCallback((start: string, end: string) => {
    startTransition(async () => {
      const data = await fetchDepartmentStats(clinicId, start, end);
      setDepartments(data);
    });
  }, [clinicId]);

  const df = useDateFilter(refetch);

  const sorted = [...departments].sort((a, b) => {
    if (deptMode === "revenue") return b.revenue - a.revenue;
    if (deptMode === "patients") return b.patients - a.patients;
    return b.appointments - a.appointments;
  });

  const totalAppts = departments.reduce((sum, d) => sum + d.appointments, 0);
  const totalPatients = departments.reduce((sum, d) => sum + d.patients, 0);

  return (
    <div className="rounded-xl border border-border/60 bg-card p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{t("departmentEngagement")}</h3>
          <div className="flex items-center rounded-lg border border-input bg-muted p-[3px]">
            <button type="button" onClick={() => setDeptMode("appointments")} className={modeBtnCls(deptMode === "appointments")}>{t("appointments")}</button>
            <button type="button" onClick={() => setDeptMode("patients")} className={modeBtnCls(deptMode === "patients")}>{t("patients")}</button>
            <button type="button" onClick={() => setDeptMode("revenue")} className={modeBtnCls(deptMode === "revenue")}>{t("revenue")}</button>
          </div>
        </div>
        <DateFilter filterMode={df.filterMode} month={df.month} rangeFrom={df.rangeFrom} rangeTo={df.rangeTo} isPending={isPending} onFilterModeChange={df.handleFilterModeChange} onMonthChange={df.handleMonthChange} onRangeFromChange={df.handleRangeFromChange} onRangeToChange={df.handleRangeToChange} />
      </div>
      <div className={cn("transition-opacity", isPending && "opacity-60")}>
        {departments.length === 0 ? <EmptyState /> : deptMode === "revenue" ? (
          <HBarChartRevenue data={sorted} yWidth={120} />
        ) : deptMode === "patients" ? (
          <HBarChart data={sorted} yWidth={120}>
            <Tooltip content={<DeptTooltip deptMode={deptMode} totalAppts={totalAppts} totalPatients={totalPatients} />} />
            <Bar dataKey="patients" name={t("patients")} fill={C.violet} radius={[0, 4, 4, 0]} maxBarSize={22} />
          </HBarChart>
        ) : (
          <HBarChart data={sorted} yWidth={120}>
            <Tooltip content={<DeptTooltip deptMode={deptMode} totalAppts={totalAppts} totalPatients={totalPatients} />} />
            <Bar dataKey="appointments" name={t("appointments")} fill={C.cyan} radius={[0, 4, 4, 0]} maxBarSize={22} />
          </HBarChart>
        )}
      </div>
    </div>
  );
}

// ── Follow-up outcome section ─────────────────────────────────────────────────

type OutcomeScope = "clinic" | "department" | "doctor";

function FollowUpOutcomeSection({
  clinicId,
  initialOutcomes,
  departmentsList,
  doctorsList,
}: {
  clinicId: string;
  initialOutcomes: FollowUpOutcomes;
  departmentsList: { id: string; name: string }[];
  doctorsList: { id: string; name: string }[];
}) {
  const t = useTranslations("dashboard");
  const [outcomes, setOutcomes] = useState<FollowUpOutcomes>(initialOutcomes);
  const [scope, setScope] = useState<OutcomeScope>("clinic");
  const [deptId, setDeptId] = useState("");
  const [docId, setDocId] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>("month");
  const [month, setMonth] = useState(currentYearMonth());
  const [rangeFrom, setRangeFrom] = useState(daysAgoStr(29));
  const [rangeTo, setRangeTo] = useState(todayStr());
  const [isPending, startTransition] = useTransition();

  function getRange() {
    if (filterMode === "month") return monthToRange(month);
    if (rangeFrom && rangeTo && rangeFrom <= rangeTo) return dateRangeToISO(rangeFrom, rangeTo);
    return monthToRange(month);
  }

  const doRefetch = useCallback((start: string, end: string, dept?: string, doc?: string) => {
    startTransition(async () => {
      const data = await fetchFollowUpOutcomes(clinicId, start, end, dept || null, doc || null);
      setOutcomes(data);
    });
  }, [clinicId]);

  function handleScopeChange(s: OutcomeScope) {
    setScope(s);
    const { start, end } = getRange();
    doRefetch(start, end, s === "department" ? deptId : undefined, s === "doctor" ? docId : undefined);
  }

  function handleDeptChange(id: string) {
    setDeptId(id);
    const { start, end } = getRange();
    doRefetch(start, end, id || undefined, undefined);
  }

  function handleDocChange(id: string) {
    setDocId(id);
    const { start, end } = getRange();
    doRefetch(start, end, undefined, id || undefined);
  }

  function handleFilterModeChange(m: FilterMode) {
    setFilterMode(m);
    const range = m === "month" ? monthToRange(month) : (rangeFrom && rangeTo ? dateRangeToISO(rangeFrom, rangeTo) : monthToRange(month));
    doRefetch(range.start, range.end, scope === "department" ? deptId : undefined, scope === "doctor" ? docId : undefined);
  }

  function handleMonthChange(m: string) {
    setMonth(m);
    const { start, end } = monthToRange(m);
    doRefetch(start, end, scope === "department" ? deptId : undefined, scope === "doctor" ? docId : undefined);
  }

  function handleRangeFromChange(d: string) {
    setRangeFrom(d);
    if (d && rangeTo && d <= rangeTo) {
      const { start, end } = dateRangeToISO(d, rangeTo);
      doRefetch(start, end, scope === "department" ? deptId : undefined, scope === "doctor" ? docId : undefined);
    }
  }

  function handleRangeToChange(d: string) {
    setRangeTo(d);
    if (rangeFrom && d && rangeFrom <= d) {
      const { start, end } = dateRangeToISO(rangeFrom, d);
      doRefetch(start, end, scope === "department" ? deptId : undefined, scope === "doctor" ? docId : undefined);
    }
  }

  const countedTotal = outcomes.allFine + outcomes.hasProblem;
  const allFinePct = countedTotal > 0 ? Math.round((outcomes.allFine / countedTotal) * 100) : 0;
  const hasProblemPct = countedTotal > 0 ? Math.round((outcomes.hasProblem / countedTotal) * 100) : 0;

  const pieData = [
    { name: t("allFine"), value: outcomes.allFine, pct: allFinePct, fill: C.emerald },
    { name: t("hasProblem"), value: outcomes.hasProblem, pct: hasProblemPct, fill: C.rose },
  ].filter((d) => d.value > 0);

  return (
    <div className="rounded-xl border border-border/60 bg-card p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-foreground">{t("followUpOutcomes")}</h3>
          <div className="flex items-center rounded-lg border border-input bg-muted p-[3px]">
            <button type="button" onClick={() => handleScopeChange("clinic")} className={modeBtnCls(scope === "clinic")}>{t("entireClinic")}</button>
            <button type="button" onClick={() => handleScopeChange("department")} className={modeBtnCls(scope === "department")}>{t("department")}</button>
            <button type="button" onClick={() => handleScopeChange("doctor")} className={modeBtnCls(scope === "doctor")}>{t("doctor")}</button>
          </div>
          {scope === "department" && (
            <select value={deptId} onChange={(e) => handleDeptChange(e.target.value)} className={INPUT_CLS}>
              <option value="">{t("allDepartments")}</option>
              {departmentsList.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
          {scope === "doctor" && (
            <select value={docId} onChange={(e) => handleDocChange(e.target.value)} className={INPUT_CLS}>
              <option value="">{t("allDoctors")}</option>
              {doctorsList.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          <div className="flex items-center rounded-lg border border-input bg-muted p-[3px]">
            <button type="button" onClick={() => handleFilterModeChange("month")} className={modeBtnCls(filterMode === "month")}>{t("month")}</button>
            <button type="button" onClick={() => handleFilterModeChange("range")} className={modeBtnCls(filterMode === "range")}>{t("customRange")}</button>
          </div>
          {filterMode === "month" ? (
            <MonthPicker value={month} max={currentYearMonth()} onChange={handleMonthChange} label={t("month")} compact className={INPUT_CLS} />
          ) : (
            <DateRangePicker
              from={rangeFrom}
              to={rangeTo}
              max={todayStr()}
              onFromChange={handleRangeFromChange}
              onToChange={handleRangeToChange}
              labels={{ from: t("from"), to: t("to") }}
              className="w-full sm:w-[19rem]"
              compact
              enforceOrder
            />
          )}
        </div>
      </div>
      <div className={cn("transition-opacity", isPending && "opacity-60")}>
        {countedTotal === 0 ? <EmptyState /> : (
          <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={pieData} cx="50%" cy="50%" innerRadius={60} outerRadius={92} paddingAngle={3} dataKey="value">
                  {pieData.map((d, i) => <Cell key={i} fill={d.fill} stroke="transparent" />)}
                </Pie>
                <Tooltip content={<OutcomeTooltip countedTotal={countedTotal} />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={LEGEND_STYLE} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex shrink-0 flex-col gap-3 sm:pt-4">
              <div className="flex items-center gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
                <div className="h-3 w-3 rounded-full bg-emerald-500" />
                <div>
                  <p className="text-xs text-muted-foreground">{t("allFine")}</p>
                  <p className="text-lg font-bold text-foreground">{outcomes.allFine} <span className="text-sm font-normal text-muted-foreground">({allFinePct}%)</span></p>
                </div>
              </div>
              <div className="flex items-center gap-3 rounded-lg border border-rose-500/20 bg-rose-500/5 px-4 py-3">
                <div className="h-3 w-3 rounded-full bg-rose-500" />
                <div>
                  <p className="text-xs text-muted-foreground">{t("hasProblem")}</p>
                  <p className="text-lg font-bold text-foreground">{outcomes.hasProblem} <span className="text-sm font-normal text-muted-foreground">({hasProblemPct}%)</span></p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t("followupTotal", { count: outcomes.total })}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function AnalyticsSectionCharts({
  clinicId,
  initialDailySeries,
  initialInsuranceSeries,
  initialDoctors,
  initialDepartments,
  initialReceptionists,
  initialFollowUpOutcomes,
  departmentsList,
  doctorsList,
}: AnalyticsSectionChartsProps) {
  return (
    <div className="space-y-6">
      <AppointmentsSection clinicId={clinicId} initialSeries={initialDailySeries} />

      <div className="grid gap-6 xl:grid-cols-2">
        <InsuranceSection clinicId={clinicId} initialSeries={initialInsuranceSeries} />
        <DoctorsSection clinicId={clinicId} initialDoctors={initialDoctors} />
      </div>

      <DepartmentSection clinicId={clinicId} initialDepartments={initialDepartments} />

      <ReceptionistSection clinicId={clinicId} initialReceptionists={initialReceptionists} />

      <FollowUpOutcomeSection
        clinicId={clinicId}
        initialOutcomes={initialFollowUpOutcomes}
        departmentsList={departmentsList}
        doctorsList={doctorsList}
      />
    </div>
  );
}
