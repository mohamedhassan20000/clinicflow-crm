"use client";

import { Wallet, TrendingUp, CalendarDays, Clock, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { useTranslations } from "next-intl";

interface RevenueBucket {
  label: string;
  amount: number;
  sub?: string;
}

interface PriorMonth {
  label: string;
  amount: number;
}

export interface RevenueWidgetProps {
  today: number;
  week: number;
  month: number;
  lastMonth: number;
  priorMonths: PriorMonth[]; // last 6 months excluding current
  outstanding: number;
}

export function RevenueWidget({
  today,
  week,
  month,
  lastMonth,
  priorMonths,
  outstanding,
}: RevenueWidgetProps) {
  const t = useTranslations("dashboard");
  const { formatCurrency } = useClinicSettings();
  const fmtMoney = (n: number) =>
    formatCurrency(n, { maximumFractionDigits: 0 });
  const monthTrend =
    lastMonth === 0 ? 0 : Math.round(((month - lastMonth) / lastMonth) * 100);

  const buckets: (RevenueBucket & { icon: typeof Wallet; accent: string })[] = [
    { label: t("today"), amount: today, icon: Clock, accent: "text-primary" },
    { label: t("thisWeek"), amount: week, icon: CalendarDays, accent: "text-cyan-600 dark:text-cyan-400" },
    {
      label: t("thisMonth"),
      amount: month,
      sub: lastMonth > 0 ? `${monthTrend >= 0 ? "+" : ""}${monthTrend}% vs last` : undefined,
      icon: TrendingUp,
      accent: "text-emerald-600 dark:text-emerald-400",
    },
  ];

  const maxPrior = Math.max(...priorMonths.map((p) => p.amount), 1);

  return (
    <div className="rounded-xl border border-border/50 bg-card">
      <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
        <div className="flex items-center gap-2">
          <Wallet className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">{t("revenueCollected")}</h2>
        </div>
        {outstanding > 0 && (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
            {t("outstandingAmount", { amount: fmtMoney(outstanding) })}
          </span>
        )}
      </div>

      {/* Buckets */}
      <div
        className="grid grid-cols-1 gap-px border-b border-border/50 bg-border/40 min-[360px]:grid-cols-2 sm:grid-cols-3"
        data-testid="dashboard-revenue-buckets"
      >
        {buckets.map(({ label, amount, sub, icon: Icon, accent }, index) => (
          <div
            key={label}
            data-testid="dashboard-revenue-bucket"
            className={cn(
              "flex min-w-0 items-center justify-between gap-3 bg-card px-3 py-3 min-[360px]:block min-[360px]:px-4 min-[360px]:py-4",
              index === 2 && "min-[360px]:col-span-2 sm:col-span-1",
            )}
          >
            <div className="flex items-center gap-1.5">
              <Icon className={cn("h-3 w-3", accent)} />
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {label}
              </p>
            </div>
            <div className="shrink-0 text-end min-[360px]:text-start">
              <p
                className="whitespace-nowrap text-base font-semibold tabular-nums min-[360px]:mt-1 min-[390px]:text-lg"
                data-testid="dashboard-revenue-value"
              >
                {fmtMoney(amount)}
              </p>
              {sub && (
                <p
                  className={cn(
                    "mt-0.5 flex items-center justify-end gap-0.5 text-[10px] font-medium min-[360px]:justify-start",
                    sub.startsWith("+")
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400",
                  )}
                >
                  {/* Trend deltas, not navigation: "up and to the right" means rising over time, in
                      the chart's coordinate space, which stays LTR by design (§4.2 step 4).
                      Mirroring these would point growth backwards. */}
                  {sub.startsWith("+") ? (
                    // rtl-allow: trend delta, not navigation
                    <ArrowUpRight className="h-3 w-3" />
                  ) : (
                    // rtl-allow: trend delta, not navigation
                    <ArrowDownRight className="h-3 w-3" />
                  )}
                  {sub}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Prior months bar chart */}
      <div className="px-5 py-4">
        <p className="mb-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          {t("previousMonths")}</p>
        {priorMonths.length === 0 ? (
          <p className="py-2 text-center text-xs text-muted-foreground">
            {t("noHistoryYet")}</p>
        ) : (
          <div className="space-y-2">
            {priorMonths.map((m) => {
              const pct = Math.max(4, Math.round((m.amount / maxPrior) * 100));
              return (
                <div key={m.label} className="flex items-center gap-3">
                  <span className="w-12 shrink-0 text-xs font-medium text-muted-foreground">
                    {m.label}
                  </span>
                  <div className="relative h-5 flex-1 overflow-hidden rounded-md bg-muted/40">
                    <div
                      className="absolute inset-y-0 start-0 rounded-md bg-gradient-to-r from-primary/70 to-primary/50"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-20 shrink-0 text-end text-xs font-semibold tabular-nums">
                    {fmtMoney(m.amount)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
