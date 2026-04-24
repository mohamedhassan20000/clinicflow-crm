"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

const VIEWS = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
] as const;

export type CalendarView = (typeof VIEWS)[number]["value"];

export function ViewSwitcher({ current }: { current: CalendarView }) {
  const router = useRouter();
  const params = useSearchParams();

  function set(v: CalendarView) {
    const next = new URLSearchParams(params.toString());
    next.set("view", v);
    // Clear range params that don't apply to the new view so we start clean.
    next.delete("week");
    next.delete("date");
    next.delete("month");
    router.push(`/appointments?${next.toString()}`);
  }

  return (
    <div className="inline-flex items-center rounded-lg border border-border/60 bg-card p-0.5 text-xs font-medium shadow-sm">
      {VIEWS.map((v) => {
        const active = current === v.value;
        return (
          <button
            key={v.value}
            type="button"
            onClick={() => set(v.value)}
            className={cn(
              "rounded-md px-3 py-1.5 transition-colors",
              active
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {v.label}
          </button>
        );
      })}
    </div>
  );
}
