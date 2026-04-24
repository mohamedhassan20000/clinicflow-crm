import { Wallet, TrendingUp, CalendarDays, Clock, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { cn } from "@/lib/utils";

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

function fmtTRY(n: number) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 0,
  }).format(n);
}

export function RevenueWidget({
  today,
  week,
  month,
  lastMonth,
  priorMonths,
  outstanding,
}: RevenueWidgetProps) {
  const monthTrend =
    lastMonth === 0 ? 0 : Math.round(((month - lastMonth) / lastMonth) * 100);

  const buckets: (RevenueBucket & { icon: typeof Wallet; accent: string })[] = [
    { label: "Today", amount: today, icon: Clock, accent: "text-primary" },
    { label: "This week", amount: week, icon: CalendarDays, accent: "text-cyan-600 dark:text-cyan-400" },
    {
      label: "This month",
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
          <h2 className="text-sm font-semibold">Revenue collected</h2>
        </div>
        {outstanding > 0 && (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
            {fmtTRY(outstanding)} outstanding
          </span>
        )}
      </div>

      {/* Buckets */}
      <div className="grid grid-cols-3 gap-px bg-border/40 border-b border-border/50">
        {buckets.map(({ label, amount, sub, icon: Icon, accent }) => (
          <div key={label} className="bg-card px-4 py-4">
            <div className="flex items-center gap-1.5">
              <Icon className={cn("h-3 w-3", accent)} />
              <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {label}
              </p>
            </div>
            <p className="mt-1 text-lg font-semibold tabular-nums">
              {fmtTRY(amount)}
            </p>
            {sub && (
              <p
                className={cn(
                  "mt-0.5 flex items-center gap-0.5 text-[10px] font-medium",
                  sub.startsWith("+")
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400",
                )}
              >
                {sub.startsWith("+") ? (
                  <ArrowUpRight className="h-3 w-3" />
                ) : (
                  <ArrowDownRight className="h-3 w-3" />
                )}
                {sub}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Prior months bar chart */}
      <div className="px-5 py-4">
        <p className="mb-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Previous months
        </p>
        {priorMonths.length === 0 ? (
          <p className="py-2 text-center text-xs text-muted-foreground">
            No history yet
          </p>
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
                      className="absolute inset-y-0 left-0 rounded-md bg-gradient-to-r from-primary/70 to-primary/50"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-20 shrink-0 text-right text-xs font-semibold tabular-nums">
                    {fmtTRY(m.amount)}
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
