"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { ReportDateRange, ReportDateRangePreset } from "@/types/reports";

const PRESETS: { value: ReportDateRangePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "this_week", label: "This week" },
  { value: "this_month", label: "This month" },
  { value: "custom", label: "Custom range" },
];

export function ReportsDateFilter({ range }: { range: ReportDateRange }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function updateParams(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    for (const [key, value] of Object.entries(next)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    const qs = params.toString();
    startTransition(() => router.push(qs ? `/reports?${qs}` : "/reports"));
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
            Date range
          </div>
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
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="reports-from" className="text-xs text-muted-foreground">
              From
            </Label>
            <Input
              id="reports-from"
              type="date"
              value={range.from}
              onChange={(event) =>
                updateParams({ preset: "custom", from: event.target.value, to: range.to })
              }
              className="h-8 w-36"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reports-to" className="text-xs text-muted-foreground">
              To
            </Label>
            <Input
              id="reports-to"
              type="date"
              value={range.to}
              onChange={(event) =>
                updateParams({ preset: "custom", from: range.from, to: event.target.value })
              }
              className="h-8 w-36"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => updateParams({ preset: "custom", from: range.from, to: range.to })}
          >
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}
