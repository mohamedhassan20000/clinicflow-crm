"use client";

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
import type { DoctorDashboardStats } from "@/actions/doctor-dashboard";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { useTranslations } from "next-intl";

export interface DoctorDashboardChartsProps {
  stats: DoctorDashboardStats;
  departmentName: string;
}

function pct(num: number, den: number) {
  if (den === 0) return 0;
  return Math.round((num / den) * 100);
}

function RateRow({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-semibold tabular-nums">{value}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted/50 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, value)}%` }} />
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

export default function DoctorDashboardCharts({ stats, departmentName }: DoctorDashboardChartsProps) {
  const t = useTranslations("dashboard");
  const { formatCurrency, formatNumber, formatPercent } = useClinicSettings();
  const fmtMoney = (n: number) =>
    formatCurrency(n, { maximumFractionDigits: 0 });
  const deptNoShowRate = pct(stats.deptNoShow, stats.deptTotal);
  const deptCancelRate = pct(stats.deptCancelled, stats.deptTotal);
  const myPatientShareOfDept = pct(stats.myPatients, stats.deptPatients || 1);
  const deptPatientShareOfClinic = pct(stats.deptPatients, stats.clinicPatients || 1);

  const patientShareData = [
    { name: t("myPatients"), value: stats.myPatients, color: "#3B82F6" },
    { name: t("departmentOtherPatients"), value: Math.max(0, stats.deptPatients - stats.myPatients), color: "#10B981" },
    { name: t("clinicOtherDepartments"), value: Math.max(0, stats.clinicPatients - stats.deptPatients), color: "#94A3B8" },
  ].filter((d) => d.value > 0);

  return (
    <>
      {/* Department section */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Dept rates */}
        <div className="rounded-xl border border-border/50 bg-card p-5 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {t("departmentRates", { department: departmentName })}
          </h2>
          <div className="space-y-3">
            <RateRow label={t("completionRate")} value={pct(stats.deptCompleted, stats.deptTotal)} color="bg-emerald-500" />
            <RateRow label={t("noShowRate")} value={deptNoShowRate} color="bg-amber-500" />
            <RateRow label={t("cancellationRate")} value={deptCancelRate} color="bg-rose-500" />
          </div>
          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border/30">
            <MiniStat label={t("deptTotalAppts")} value={stats.deptTotal} />
            <MiniStat label={t("deptPatients")} value={stats.deptPatients} />
            <MiniStat label={t("deptRevenue")} value={fmtMoney(stats.deptRevenue)} />
            <MiniStat label={t("noShows")} value={stats.deptNoShow} />
          </div>
        </div>

        {/* Patient share */}
        <div className="rounded-xl border border-border/50 bg-card p-5 space-y-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            {t("patientShare")}</h2>
          <div className="flex items-center gap-4">
            <div className="flex-1 space-y-2">
              <ShareRow
                label={t("myPatientsDept")}
                myVal={stats.myPatients}
                totalVal={stats.deptPatients}
                pctVal={myPatientShareOfDept}
                color="#3B82F6"
              />
              <ShareRow
                label={t("deptPatientsClinic")}
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
                      formatter={(val, name) => [formatNumber(Number(val)), name]}
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
          { name: t("allFine"), value: stats.followUpOutcomes.allFine, color: "#10B981" },
          { name: t("hasProblem"), value: stats.followUpOutcomes.hasProblem, color: "#F59E0B" },
        ].filter((d) => d.value > 0);
        const total = stats.followUpOutcomes.total;
        return (
          <div className="rounded-xl border border-border/50 bg-card p-5 space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              {t("myPatientsFollowUpOutcomes")}</h2>
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
                      formatter={(val, name) => [`${formatNumber(Number(val))} (${formatPercent(pct(Number(val), total))})`, name]}
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
                  {t("followUpsRecorded", { count: total })}
                </p>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Appointments chart */}
      <div className="rounded-xl border border-border/50 bg-card p-5 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          {t("appointmentsOverTime")}</h2>
        {stats.dailySeries.length > 1 ? (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={stats.dailySeries} margin={{ top: 4, right: 16, left: -16, bottom: 0 /* rtl-allow: Recharts margin is the chart's own LTR coordinate space, not page layout (AI_AGENT_PLAN §4.2 step 4) */ }}>
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
                name={t("myAppointments")}
                stroke="#3B82F6"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="dept"
                name={t("departmentTotal")}
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
            {t("notEnoughDataToChart")}</div>
        )}
      </div>
    </>
  );
}
