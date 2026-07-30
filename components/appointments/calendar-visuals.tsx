"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";
import type { ClinicWorkingHoursValues } from "@/lib/validations/settings";
import { useTranslations } from "next-intl";

export const CALENDAR_HEADER_HEIGHT_PX = 32;

/**
 * Shared visual vocabulary for every appointment calendar surface.
 * Keep structural contrast here so week/day/month views cannot drift back to
 * unrelated opacity values.
 */
export const CALENDAR_STYLES = {
  frame: "overflow-x-auto rounded-xl border border-calendar-grid-strong bg-card",
  timeAxis: "w-16 shrink-0 border-e border-calendar-grid-strong bg-card",
  timeAxisHeader: "h-8 border-b border-calendar-grid-strong bg-muted",
  hourRow: "relative border-b border-calendar-grid",
  hourLabel:
    "whitespace-nowrap text-[11px] font-medium leading-none tabular-nums text-foreground/70",
  dayHeader:
    "flex h-8 items-center justify-center border-b border-calendar-grid-strong bg-muted text-xs font-semibold text-foreground",
  todayHeader:
    "flex h-8 items-center justify-center border-b border-primary/50 bg-primary/15 text-xs font-semibold text-foreground",
  todayBody: "bg-primary/5",
  nonWorkingLabel:
    "rounded border border-calendar-grid bg-card/90 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-widest text-foreground/70",
  secondaryLabel: "text-foreground/70",
  selectedSlotTrigger:
    "border-primary/70 bg-primary/10 font-semibold text-foreground ring-2 ring-primary/20",
  selectedSlotItem:
    "data-[state=checked]:bg-primary/15 data-[state=checked]:font-semibold data-[state=checked]:text-foreground",
} as const;

export function timeStringToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

export function minutesInClinicTimeZone(
  date = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
): number {
  return timeStringToMinutes(
    date.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
    }),
  );
}

/** Keeps the visual now/today affordances accurate on long-lived calendar tabs. */
export function useCalendarNow(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  return now;
}

export interface CalendarGridBounds {
  startMin: number;
  endMin: number;
}

export function getCalendarGridBounds(
  clinicHours: ClinicWorkingHoursValues,
): CalendarGridBounds {
  const shifts = clinicHours.flatMap((day) => (day.open ? day.shifts : []));
  if (shifts.length === 0) return { startMin: 8 * 60, endMin: 18 * 60 };

  return {
    startMin: Math.min(...shifts.map((shift) => timeStringToMinutes(shift.shift_start))),
    endMin: Math.max(...shifts.map((shift) => timeStringToMinutes(shift.shift_end))),
  };
}

export interface CalendarNonWorkingBand {
  startMin: number;
  endMin: number;
  kind: "break" | "non-working" | "closed";
  label: "break" | "non-working" | "closed";
}

/**
 * Derives visual-only schedule bands. This never participates in availability,
 * booking, conflict, duration, or timezone calculations.
 */
export function getCalendarNonWorkingBands(
  clinicHours: ClinicWorkingHoursValues,
  dayOfWeek: number,
  bounds: CalendarGridBounds,
): CalendarNonWorkingBand[] {
  // An entirely unconfigured clinic keeps the historical 08:00–18:00 open grid.
  if (!clinicHours.some((day) => day.open)) return [];

  const day = clinicHours.find((candidate) => candidate.day_of_week === dayOfWeek);
  if (!day?.open || day.shifts.length === 0) {
    return [{ ...bounds, kind: "closed", label: "closed" }];
  }

  const shifts = [...day.shifts]
    .map((shift) => ({
      startMin: Math.max(bounds.startMin, timeStringToMinutes(shift.shift_start)),
      endMin: Math.min(bounds.endMin, timeStringToMinutes(shift.shift_end)),
    }))
    .filter((shift) => shift.endMin > shift.startMin)
    .sort((a, b) => a.startMin - b.startMin);

  const bands: CalendarNonWorkingBand[] = [];
  let cursor = bounds.startMin;

  for (const shift of shifts) {
    if (shift.startMin > cursor) {
      const isOpeningGap = cursor === bounds.startMin;
      bands.push({
        startMin: cursor,
        endMin: shift.startMin,
        kind: isOpeningGap ? "non-working" : "break",
        label: isOpeningGap ? "non-working" : "break",
      });
    }
    cursor = Math.max(cursor, shift.endMin);
  }

  if (cursor < bounds.endMin) {
    bands.push({
      startMin: cursor,
      endMin: bounds.endMin,
      kind: "non-working",
      label: "non-working",
    });
  }

  return bands;
}

export function CalendarNonWorkingBands({
  bands,
  gridStartMin,
  hourHeightPx,
}: {
  bands: CalendarNonWorkingBand[];
  gridStartMin: number;
  hourHeightPx: number;
}) {
  const t = useTranslations("appointments");
  return bands.map((band) => {
    const top =
      CALENDAR_HEADER_HEIGHT_PX +
      ((band.startMin - gridStartMin) / 60) * hourHeightPx;
    const height = ((band.endMin - band.startMin) / 60) * hourHeightPx;

    return (
      <div
        key={`${band.kind}-${band.startMin}-${band.endMin}`}
        data-calendar-non-working={band.kind}
        className="calendar-non-working-band pointer-events-none absolute inset-x-0 z-0 flex items-center justify-center"
        style={{ top, height }}
      >
        <span className={CALENDAR_STYLES.nonWorkingLabel}>
          {t(band.kind === "closed" ? "calendarClosed" : band.kind === "break" ? "calendarBreak" : "calendarNonWorking")}
        </span>
      </div>
    );
  });
}

export function CalendarNowIndicator({
  top,
  label,
}: {
  top: number;
  label: string;
}) {
  return (
    <div
      role="separator"
      aria-label={label}
      data-calendar-now-indicator
      className="pointer-events-none absolute inset-x-0 z-20 flex items-center"
      style={{ top } satisfies CSSProperties}
    >
      <span className="size-2 shrink-0 rounded-full bg-primary ring-2 ring-card" />
      <span className="h-0.5 flex-1 bg-primary" />
    </div>
  );
}
