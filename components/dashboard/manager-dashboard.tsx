"use client";

import {
  CalendarDays,
  TrendingUp,
  Users,
  XCircle,
  UserX,
  BarChart3,
  Download,
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
import { Button } from "@/components/ui/button";
import { KpiCard } from "@/components/dashboard/kpi-card";

interface DailyPoint {
  date: string; // "Apr 1"
  appointments: number;
}

interface InsurancePoint {
  name: string;
  value: number;
}

interface DoctorPoint {
  name: string;
  appointments: number;
}

interface ManagerDashboardProps {
  fullName: string;
  todayCount: number;
  weekCount: number;
  monthCount: number;
  noShowRate: number;     // percentage 0-100
  cancelRate: number;     // percentage 0-100
  totalPatients: number;
  dailySeries: DailyPoint[];
  insuranceSeries: InsurancePoint[];
  topDoctors: DoctorPoint[];
}

const PIE_COLORS = [
  "hsl(var(--primary))",
  "#6366F1",
  "#F59E0B",
  "#10B981",
  "#EF4444",
  "#8B5CF6",
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-md">
      <p className="font-medium">{label}</p>
      {payload.map((p: { color: string; name: string; value: number }, i: number) => (
        <p key={i} style={{ color: p.color }}>
          {p.name}: <span className="font-semibold">{p.value}</span>
        </p>
      ))}
    </div>
  );
}

export function ManagerDashboard({
  fullName,
  todayCount,
  weekCount,
  monthCount,
  noShowRate,
  cancelRate,
  totalPatients,
  dailySeries,
  insuranceSeries,
  topDoctors,
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
        <Button variant="outline" size="sm" className="gap-2" disabled>
          <Download className="h-4 w-4" />
          Export CSV
        </Button>
      </div>

      {/* KPIs */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          title="Today"
          value={todayCount}
          icon={CalendarDays}
          variant="primary"
        />
        <KpiCard
          title="This week"
          value={weekCount}
          icon={TrendingUp}
        />
        <KpiCard
          title="This month"
          value={monthCount}
          icon={BarChart3}
          variant="success"
        />
        <KpiCard
          title="Total patients"
          value={totalPatients}
          icon={Users}
        />
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

      {/* 30-day line chart */}
      <div className="rounded-xl border border-border/50 bg-card p-5">
        <h2 className="mb-4 text-sm font-semibold">Appointments — last 30 days</h2>
        {dailySeries.length === 0 ? (
          <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
            No data yet
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={dailySeries} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="hsl(var(--border))"
                strokeOpacity={0.5}
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
              <Tooltip content={<CustomTooltip />} />
              <Line
                type="monotone"
                dataKey="appointments"
                name="Appointments"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0 }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Insurance breakdown donut */}
        <div className="rounded-xl border border-border/50 bg-card p-5">
          <h2 className="mb-4 text-sm font-semibold">Insurance breakdown</h2>
          {insuranceSeries.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
              No data yet
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={insuranceSeries}
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={85}
                  paddingAngle={3}
                  dataKey="value"
                >
                  {insuranceSeries.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
                <Legend
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ fontSize: 11 }}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Top doctors bar chart */}
        <div className="rounded-xl border border-border/50 bg-card p-5">
          <h2 className="mb-4 text-sm font-semibold">Top doctors — this month</h2>
          {topDoctors.length === 0 ? (
            <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
              No data yet
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart
                data={topDoctors}
                layout="vertical"
                margin={{ top: 0, right: 16, bottom: 0, left: 0 }}
              >
                <CartesianGrid
                  horizontal={false}
                  strokeDasharray="3 3"
                  stroke="hsl(var(--border))"
                  strokeOpacity={0.5}
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
                  width={90}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip content={<CustomTooltip />} />
                <Bar
                  dataKey="appointments"
                  name="Appointments"
                  fill="hsl(var(--primary))"
                  radius={[0, 4, 4, 0]}
                  maxBarSize={20}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
