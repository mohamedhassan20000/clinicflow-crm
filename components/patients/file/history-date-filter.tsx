"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarDays, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DateRangePicker } from "@/components/ui/clinic-date-picker";
import { useTranslations } from "next-intl";
import type { HistoryPreset } from "@/lib/patients/file-data";

const PRESETS: { value: HistoryPreset; labelKey: string }[] = [
  { value: "all", labelKey: "presetAll" },
  { value: "last_week", labelKey: "presetLastWeek" },
  { value: "last_month", labelKey: "presetLastMonth" },
  { value: "last_year", labelKey: "presetLastYear" },
  { value: "custom", labelKey: "presetCustom" },
];

interface Props {
  preset: HistoryPreset;
  from: string | null;
  to: string | null;
}

/**
 * P7-11 — date filter for the full history / packages / deposits pages. Offers
 * rolling presets (last week / month / year) plus a custom range, all
 * URL-driven so the server component re-renders with the scoped result set.
 */
export function HistoryDateFilter({ preset, from, to }: Props) {
  const t = useTranslations("patients");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [fromVal, setFromVal] = useState(from ?? "");
  const [toVal, setToVal] = useState(to ?? "");

  function pushParams(next: URLSearchParams) {
    const qs = next.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  function selectPreset(value: HistoryPreset) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "all") {
      params.delete("preset");
      params.delete("from");
      params.delete("to");
    } else if (value === "custom") {
      params.set("preset", "custom");
    } else {
      params.set("preset", value);
      params.delete("from");
      params.delete("to");
    }
    pushParams(params);
  }

  function applyCustom() {
    const params = new URLSearchParams(searchParams.toString());
    params.set("preset", "custom");
    if (fromVal) params.set("from", fromVal);
    else params.delete("from");
    if (toVal) params.set("to", toVal);
    else params.delete("to");
    pushParams(params);
  }

  function clearCustom() {
    setFromVal("");
    setToVal("");
    selectPreset("all");
  }

  return (
    <div className="space-y-3 rounded-xl border border-border/50 bg-card p-4 print:hidden">
      <div className="flex flex-wrap items-center gap-2">
        <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        {PRESETS.map((p) => (
          <Button
            key={p.value}
            size="sm"
            variant={preset === p.value ? "default" : "outline"}
            className="h-8"
            onClick={() => selectPreset(p.value)}
          >
            {t(p.labelKey)}
          </Button>
        ))}
      </div>

      {preset === "custom" && (
        <div className="flex flex-wrap items-end gap-3">
          <DateRangePicker
            from={fromVal}
            to={toVal}
            onFromChange={setFromVal}
            onToChange={setToVal}
            labels={{ from: t("from"), to: t("to") }}
            className="w-full sm:w-[22rem]"
            compact
          />
          <Button size="sm" className="h-8" onClick={applyCustom}>
            {t("applyFilter")}
          </Button>
          {(from || to) && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1"
              onClick={clearCustom}
            >
              <X className="h-3.5 w-3.5" />
              {t("clear")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
