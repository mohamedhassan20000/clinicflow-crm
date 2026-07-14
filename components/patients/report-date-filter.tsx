"use client";

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { CalendarDays, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t("from")}</label>
        <input
          type="date"
          value={fromVal}
          onChange={(e) => setFromVal(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t("to")}</label>
        <input
          type="date"
          value={toVal}
          onChange={(e) => setToVal(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
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
