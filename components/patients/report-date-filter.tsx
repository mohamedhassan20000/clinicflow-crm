"use client";

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { CalendarDays, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DateRangePicker } from "@/components/ui/clinic-date-picker";
import { useTranslations } from "next-intl";

interface Props {
  from?: string;
  to?: string;
}

export function ReportDateFilter({ from, to }: Props) {
  const t = useTranslations("patients");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [fromVal, setFromVal] = useState(from ?? "");
  const [toVal, setToVal] = useState(to ?? "");

  function apply() {
    const params = new URLSearchParams(searchParams.toString());
    if (fromVal) params.set("from", fromVal);
    else params.delete("from");
    if (toVal) params.set("to", toVal);
    else params.delete("to");
    router.push(`${pathname}?${params.toString()}`);
  }

  function clear() {
    setFromVal("");
    setToVal("");
    const params = new URLSearchParams(searchParams.toString());
    params.delete("from");
    params.delete("to");
    router.push(`${pathname}?${params.toString()}`);
  }

  const isFiltered = !!(from || to);

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border/50 bg-card p-4 print:hidden">
      <CalendarDays className="h-4 w-4 shrink-0 self-end mb-1.5 text-muted-foreground" aria-hidden />
      <DateRangePicker
        from={fromVal}
        to={toVal}
        onFromChange={setFromVal}
        onToChange={setToVal}
        labels={{ from: t("from"), to: t("to") }}
        className="w-full sm:w-[22rem]"
        compact
      />
      <Button size="sm" className="h-8" onClick={apply}>
        {t("applyFilter")}</Button>
      {isFiltered && (
        <Button size="sm" variant="ghost" className="h-8 gap-1" onClick={clear}>
          <X className="h-3.5 w-3.5" />
          {t("clear")}</Button>
      )}
      {isFiltered && (
        <span className="self-end pb-1.5 text-xs text-muted-foreground">
          {t("showingFilteredResults")}</span>
      )}
    </div>
  );
}
