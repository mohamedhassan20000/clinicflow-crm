"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DateRangePicker } from "@/components/ui/clinic-date-picker";
import { cn } from "@/lib/utils";
import type { ReportDateRange, ReportDateRangePreset } from "@/types/reports";
import { useTranslations } from "next-intl";

const PRESETS: { value: ReportDateRangePreset; labelKey: string }[] = [
  { value: "today", labelKey: "dateToday" },
  { value: "this_week", labelKey: "dateThisWeek" },
  { value: "this_month", labelKey: "dateThisMonth" },
  { value: "custom", labelKey: "dateCustomRange" },
];

export function ReportsDateFilter({ range }: { range: ReportDateRange }) {
  const t = useTranslations("reports");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function updateParams(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    for (const [key, value] of Object.entries(next)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    const qs = params.toString();
    startTransition(() => router.push(qs ? `${pathname}?${qs}` : pathname));
  }

  function setPreset(preset: ReportDateRangePreset) {
    updateParams({
      preset,
      from: preset === "custom" ? range.from : null,
      to: preset === "custom" ? range.to : null,
    });
  }

  return (
    <div className="rounded-xl border border-border/50 bg-card p-4 print:hidden">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <CalendarDays className="h-4 w-4 text-muted-foreground" aria-hidden />
            {t("dateRange")}</div>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((preset) => {
              const active = range.preset === preset.value;
              return (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() => setPreset(preset.value)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-medium transition",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(preset.labelKey)}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <DateRangePicker
            id="reports-date-range"
            from={range.from}
            to={range.to}
            labels={{ from: t("from"), to: t("to") }}
            onFromChange={(from) =>
              updateParams({ preset: "custom", from, to: range.to })
            }
            onToChange={(to) =>
              updateParams({ preset: "custom", from: range.from, to })
            }
            className="w-full sm:w-[22rem]"
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => updateParams({ preset: "custom", from: range.from, to: range.to })}
          >
            {t("apply")}</Button>
        </div>
      </div>
    </div>
  );
}
