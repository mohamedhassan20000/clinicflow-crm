"use client";

import { useState, useTransition, useCallback } from "react";
import { Loader2, Users } from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from "recharts";
import { cn } from "@/lib/utils";
import {
  fetchReceptionistStats,
  type ReceptionistStat,
} from "@/actions/manager-dashboard";

// ── Colour palette ────────────────────────────────────────────────────────────

const BAR_COLORS = [
  "#3B82F6",
  "#10B981",
  "#8B5CF6",
  "#F59E0B",
  "#F43F5E",
  "#06B6D4",
  "#F97316",
  "#6366F1",
];

// ── Date helpers ─────────────────────────────────────────────────────────────

function currentYearMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function todayBounds() {
  const now = new Date();
  const s = new Date(now);
  s.setHours(0, 0, 0, 0);
  const e = new Date(now);
  e.setHours(23, 59, 59, 999);
  return { start: s.toISOString(), end: e.toISOString() };
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

// ── Shared styles ─────────────────────────────────────────────────────────────

const INPUT_CLS =
  "h-8 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground [color-scheme:light] dark:[color-scheme:dark] focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 disabled:opacity-50";

const TICK = { fontSize: 11, fill: "var(--muted-foreground)" } as const;
const GRID_PROPS = {
  stroke: "var(--border)",
  strokeOpacity: 0.4,
  strokeDasharray: "3 3",
} as const;

function modeBtnCls(active: boolean) {
  return cn(
    "rounded px-2.5 py-0.5 text-xs font-medium transition-colors",
    active
      ? "bg-background text-foreground shadow-sm dark:bg-input/30"
      : "text-muted-foreground hover:text-foreground",
  );
}

function fmtTRY(n: number) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 0,
  }).format(n);
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChartTooltip({ active, payload, label, mode }: any) {
  if (!active || !payload?.length) return null;
  const val = payload[0]?.value as number;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-lg">
      <p className="mb-1 font-medium text-foreground">{label}</p>
      <p className="text-xs" style={{ color: payload[0]?.fill }}>
        {mode === "revenue" ? "Revenue" : "Invoices"}:{" "}
        <span className="font-semibold text-foreground">
          {mode === "revenue" ? fmtTRY(val) : val}
        </span>
      </p>
    </div>
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

type FilterPreset = "today" | "month" | "range";
type ViewMode = "invoices" | "revenue";
type ChartMode = "comparison" | "single";

export interface ReceptionistInvoiceChartProps {
  clinicId: string;
  initialStats: ReceptionistStat[];
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ReceptionistInvoiceChart({
  clinicId,
  initialStats,
}: ReceptionistInvoiceChartProps) {
  const [stats, setStats] = useState<ReceptionistStat[]>(initialStats);
  const [isPending, startTransition] = useTransition();

  // Filters
  const [preset, setPreset] = useState<FilterPreset>("month");
  const [month, setMonth] = useState(currentYearMonth());
  const [rangeFrom, setRangeFrom] = useState(todayStr());
  const [rangeTo, setRangeTo] = useState(todayStr());

  // View toggles
  const [viewMode, setViewMode] = useState<ViewMode>("invoices");
  const [chartMode, setChartMode] = useState<ChartMode>("comparison");
  const [selectedId, setSelectedId] = useState<string>(
    initialStats[0]?.id ?? "",
  );

  const refetch = useCallback(
    (start: string, end: string) => {
      startTransition(async () => {
        const data = await fetchReceptionistStats(clinicId, start, end);
        setStats(data);
        if (!data.find((d) => d.id === selectedId) && data[0]) {
          setSelectedId(data[0].id);
        }
      });
    },
    [clinicId, selectedId],
  );

  function applyPreset(p: FilterPreset) {
    setPreset(p);
    if (p === "today") {
      const { start, end } = todayBounds();
      refetch(start, end);
    } else if (p === "month") {
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

  // Totals row
  const totals: ReceptionistStat = {
    id: "__total__",
    name: "All receptionists",
    invoices: stats.reduce((s, r) => s + r.invoices, 0),
    revenue: stats.reduce((s, r) => s + r.revenue, 0),
  };

  // Chart data
  const comparisonData = stats.map((r) => ({
    name: r.name.split(" ")[0], // first name for brevity
    fullName: r.name,
    invoices: r.invoices,
    revenue: Math.round(r.revenue),
    id: r.id,
  }));

  const selectedStat =
    chartMode === "single"
      ? stats.find((r) => r.id === selectedId) ?? stats[0]
      : null;

  return (
    <div className="rounded-xl border border-border/60 bg-card p-5 shadow-sm">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Users className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">
            Receptionist invoice performance
          </h3>
          {isPending && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
        </div>

        {/* View mode: invoices vs revenue */}
        <div className="flex items-center rounded-lg border border-input bg-muted p-[3px]">
          <button
            type="button"
            onClick={() => setViewMode("invoices")}
            className={modeBtnCls(viewMode === "invoices")}
          >
            Invoices
          </button>
          <button
            type="button"
            onClick={() => setViewMode("revenue")}
            className={modeBtnCls(viewMode === "revenue")}
          >
            Revenue
          </button>
        </div>
      </div>

      {/* Filters row */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {/* Preset tabs */}
        <div className="flex items-center rounded-lg border border-input bg-muted p-[3px]">
          {(["today", "month", "range"] as FilterPreset[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => applyPreset(p)}
              className={modeBtnCls(preset === p)}
            >
              {p === "today" ? "Today" : p === "month" ? "Month" : "Custom"}
            </button>
          ))}
        </div>

        {preset === "month" && (
          <input
            type="month"
            value={month}
            max={currentYearMonth()}
            onChange={(e) => handleMonthChange(e.target.value)}
            className={INPUT_CLS}
          />
        )}
        {preset === "range" && (
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={rangeFrom}
              max={rangeTo || todayStr()}
              onChange={(e) => handleRangeFromChange(e.target.value)}
              className={INPUT_CLS}
            />
            <span className="text-xs text-muted-foreground">to</span>
            <input
              type="date"
              value={rangeTo}
              min={rangeFrom}
              max={todayStr()}
              onChange={(e) => handleRangeToChange(e.target.value)}
              className={INPUT_CLS}
            />
          </div>
        )}

        {/* Chart mode toggle */}
        <div className="ml-auto flex items-center rounded-lg border border-input bg-muted p-[3px]">
          <button
            type="button"
            onClick={() => setChartMode("comparison")}
            className={modeBtnCls(chartMode === "comparison")}
          >
            All together
          </button>
          <button
            type="button"
            onClick={() => setChartMode("single")}
            className={modeBtnCls(chartMode === "single")}
          >
            Single view
          </button>
        </div>
      </div>

      <div className={cn("transition-opacity", isPending && "opacity-60")}>
        {stats.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
            No data for this period
          </div>
        ) : chartMode === "comparison" ? (
          <>
            {/* Comparison bar chart */}
            <ResponsiveContainer width="100%" height={Math.max(200, stats.length * 52)}>
              <BarChart
                data={comparisonData}
                layout="vertical"
                margin={{ top: 0, right: 16, bottom: 0, left: 0 }}
              >
                <CartesianGrid horizontal={false} {...GRID_PROPS} />
                <XAxis
                  type="number"
                  allowDecimals={false}
                  tick={TICK}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={
                    viewMode === "revenue"
                      ? (v) => `₺${(v as number).toLocaleString()}`
                      : undefined
                  }
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={90}
                  tick={TICK}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip content={<ChartTooltip mode={viewMode} />} />
                <Bar
                  dataKey={viewMode}
                  radius={[0, 4, 4, 0]}
                  maxBarSize={24}
                >
                  {comparisonData.map((entry, i) => (
                    <Cell
                      key={entry.id}
                      fill={BAR_COLORS[i % BAR_COLORS.length]}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>

            {/* Totals summary */}
            <div className="mt-4 flex flex-wrap items-center gap-4 rounded-lg border border-border/50 bg-muted/30 px-4 py-3">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Total
              </span>
              <span className="text-sm font-semibold text-foreground">
                {totals.invoices} invoice{totals.invoices !== 1 ? "s" : ""}
              </span>
              <span className="text-sm font-semibold text-foreground">
                {fmtTRY(totals.revenue)} collected
              </span>
            </div>
          </>
        ) : (
          /* Single receptionist view */
          <>
            {/* Receptionist selector */}
            <div className="mb-4 flex flex-wrap gap-2">
              {stats.map((r, i) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-medium transition-colors border",
                    selectedId === r.id
                      ? "text-white border-transparent"
                      : "text-muted-foreground border-border/50 hover:text-foreground",
                  )}
                  style={
                    selectedId === r.id
                      ? { backgroundColor: BAR_COLORS[i % BAR_COLORS.length] }
                      : {}
                  }
                >
                  {r.name}
                </button>
              ))}
            </div>

            {/* Stats for selected receptionist */}
            {selectedStat && (
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="rounded-xl border border-border/50 bg-muted/20 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
                    Invoices completed
                  </p>
                  <p className="text-2xl font-semibold tabular-nums">
                    {selectedStat.invoices}
                  </p>
                </div>
                <div className="rounded-xl border border-border/50 bg-muted/20 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
                    Revenue collected
                  </p>
                  <p className="text-2xl font-semibold tabular-nums">
                    {fmtTRY(selectedStat.revenue)}
                  </p>
                </div>
                <div className="rounded-xl border border-border/50 bg-muted/20 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
                    Share of total invoices
                  </p>
                  <p className="text-2xl font-semibold tabular-nums">
                    {totals.invoices === 0
                      ? "0%"
                      : `${Math.round((selectedStat.invoices / totals.invoices) * 100)}%`}
                  </p>
                </div>
              </div>
            )}

            {/* Totals context */}
            <div className="mt-4 flex flex-wrap items-center gap-4 rounded-lg border border-border/50 bg-muted/30 px-4 py-3">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                All receptionists total
              </span>
              <span className="text-sm font-semibold text-foreground">
                {totals.invoices} invoices
              </span>
              <span className="text-sm font-semibold text-foreground">
                {fmtTRY(totals.revenue)}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
