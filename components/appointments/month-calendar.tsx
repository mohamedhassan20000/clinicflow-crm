"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, CalendarPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Tables } from "@/types/database";
import type { ClinicWorkingHoursValues } from "@/lib/validations/settings";
import { isDayClosed } from "@/lib/calendar-utils";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { CALENDAR_STYLES, useCalendarNow } from "@/components/appointments/calendar-visuals";
import { useTranslations } from "next-intl";
import {
  addCalendarDays,
  addCalendarMonths,
  calendarDateKey,
  calendarDayOfWeek,
  startOfCalendarWeek,
  toCalendarEventPlacement,
} from "@/lib/appointments/calendar";

type Appointment = Pick<
  Tables<"appointments">,
  "id" | "scheduled_at" | "status" | "insurance_provider_id" | "notes"
> & {
  patients: { full_name: string } | null;
  profiles: { full_name: string } | null;
  departments: { name: string; color: string } | null;
};

interface Props {
  appointments: Appointment[];
  monthStart: string;
  canEdit: boolean;
  clinicHours?: ClinicWorkingHoursValues;
  newAppointmentHref?: string;
}

export function MonthCalendar({ appointments, monthStart, canEdit, clinicHours = [], newAppointmentHref = "/appointments/new" }: Props) {
  const t = useTranslations("appointments");
  const {
    formatTime,
    formatCalendarDate,
    weekStart,
    locale,
  } = useClinicSettings();
  const today = useCalendarNow();
  const todayKey = calendarDateKey(today, locale.timeZone);
  const currentTimeLabel = formatTime(today.toISOString());
  const monthKey = monthStart.slice(0, 7);
  const prevMonth = addCalendarMonths(monthKey, -1);
  const nextMonth = addCalendarMonths(monthKey, 1);
  const appointmentsByDate = useMemo(() => {
    const grouped = new Map<string, Appointment[]>();
    const sorted = [...appointments].sort(
      (a, b) =>
        new Date(a.scheduled_at).getTime() -
        new Date(b.scheduled_at).getTime(),
    );

    for (const appointment of sorted) {
      const key = toCalendarEventPlacement(
        appointment,
        locale.timeZone,
      ).date;
      const dayAppointments = grouped.get(key) ?? [];
      dayAppointments.push(appointment);
      grouped.set(key, dayAppointments);
    }

    return grouped;
  }, [appointments, locale.timeZone]);

  // Build grid: start from the clinic's configured week start on/before the 1st
  const gridStart = startOfCalendarWeek(monthStart, weekStart);
  const cells: string[] = [];
  for (let i = 0; i < 42; i++) {
    cells.push(addCalendarDays(gridStart, i));
  }

  // Trim to 5 rows if the 6th row is entirely outside this month
  const showRows =
    cells[35].slice(0, 7) === monthKey ||
    cells[35 + 6]?.slice(0, 7) === monthKey
      ? 6
      : 5;
  const visible = cells.slice(0, showRows * 7);

  return (
    <div className="space-y-4" data-calendar-view="month">
      {/* Nav */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm" className="h-8 w-8 p-0">
            <Link href={`/appointments?view=month&month=${prevMonth}`} aria-label={t("previousMonth")}>
              <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
            </Link>
          </Button>
          <span className="min-w-0 text-sm font-medium">
            {formatCalendarDate(monthStart, {
              month: "long",
              year: "numeric",
            })}
          </span>
          <Button asChild variant="outline" size="sm" className="h-8 w-8 p-0">
            <Link href={`/appointments?view=month&month=${nextMonth}`} aria-label={t("nextMonth")}>
              <ChevronRight className="h-4 w-4 rtl:rotate-180" />
            </Link>
          </Button>
        </div>

        {canEdit && (
          <Button asChild size="sm" className="shrink-0 gap-1.5">
            <Link href={newAppointmentHref}>
              <CalendarPlus className="h-4 w-4" />
              {t("newAppointment")}</Link>
          </Button>
        )}
      </div>

      <div className={CALENDAR_STYLES.frame} data-calendar-grid>
        <div className="min-w-[860px]">
          <div className="grid grid-cols-7 border-b-2 border-calendar-grid-strong bg-muted text-xs font-semibold uppercase tracking-wider text-foreground">
            {Array.from({ length: 7 }, (_, i) =>
              addCalendarDays("2024-01-07", (weekStart + i) % 7),
            ).map((dateIso) => (
              <div key={dateIso} data-calendar-day-header className="px-2 py-2.5 text-center">
                {formatCalendarDate(dateIso, { weekday: "short" })}
              </div>
            ))}
          </div>

          <div className="grid auto-rows-[minmax(110px,_1fr)] grid-cols-7">
            {visible.map((day, i) => {
              const inMonth = day.slice(0, 7) === monthKey;
              const isToday = day === todayKey;
              const dayAppts = appointmentsByDate.get(day) ?? [];
              const dow = calendarDayOfWeek(day);
              const closed = inMonth && isDayClosed(clinicHours, dow);

              const cellBase = `border-b border-e border-calendar-grid p-1.5 transition-colors ${
                i % 7 === 6 ? "border-e-0" : ""
              } ${isToday ? CALENDAR_STYLES.todayBody : ""}`;

              const cellContent = (
                <>
                  <div className="mb-1 flex items-center justify-between">
                    <span
                      className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                        isToday
                          ? "bg-primary/15 text-foreground ring-1 ring-primary/50"
                          : inMonth
                            ? "text-foreground"
                            : ""
                      }`}
                    >
                      {Number(day.slice(8, 10))}
                    </span>
                    <span className="flex items-center gap-1">
                      {isToday && (
                        <span
                          data-calendar-now-indicator
                          aria-label={t("currentTimeNamed", { time: currentTimeLabel })}
                          className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-foreground"
                        >
                          <span aria-hidden className="size-1.5 rounded-full bg-primary" />
                          {t("now")}{currentTimeLabel}
                        </span>
                      )}
                      {closed ? (
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground/70">
                          {t("closed")}</span>
                      ) : dayAppts.length > 0 ? (
                        <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium tabular-nums text-foreground/70">
                          {dayAppts.length}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  <div className="space-y-0.5">
                    {dayAppts.slice(0, 3).map((a) => {
                        const color = a.departments?.color ?? "#64748b";
                        const time = formatTime(a.scheduled_at);
                        return (
                          <div
                            key={a.id}
                            data-calendar-event
                            data-appointment-id={a.id}
                            className="truncate rounded border px-1.5 py-1 text-[11px] transition-[filter,box-shadow] hover:brightness-[1.04] hover:ring-1 hover:ring-primary/40"
                            style={{
                              backgroundColor: `color-mix(in oklab, ${color} 10%, var(--card))`,
                              borderColor: `color-mix(in oklab, ${color} 42%, var(--calendar-grid))`,
                              borderInlineStartColor: color,
                              borderInlineStartWidth: 3,
                            }}
                            title={`${time} · ${a.patients?.full_name ?? ""}${a.notes ? ` · ${a.notes}` : ""}`}
                          >
                            <span className="font-semibold tabular-nums">
                              {time}
                            </span>
                            <span className="ms-1 text-foreground">
                              {a.patients?.full_name ?? "—"}
                            </span>
                            {a.notes && (
                              <span className="ms-1 text-foreground/70">
                                •
                              </span>
                            )}
                          </div>
                        );
                    })}
                    {dayAppts.length > 3 && (
                      <div className="px-1 text-[10px] text-foreground/70">
                {t("moreCount", { count: dayAppts.length - 3 })}
                      </div>
                    )}
                  </div>
                </>
              );

              if (!inMonth) {
                return (
                  <Link
                    key={i}
                    href={`/appointments?view=day&date=${day}`}
                    aria-current={isToday ? "date" : undefined}
                    className={`${cellBase} bg-muted/30 text-foreground/65 hover:bg-muted/50 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary`}
                  >
                    {cellContent}
                  </Link>
                );
              }

              return (
                <Link
                  key={i}
                  href={`/appointments?view=day&date=${day}`}
                  aria-current={isToday ? "date" : undefined}
                  data-calendar-non-working={closed ? "closed" : undefined}
                  className={
                    // i18n-allow: Tailwind and calendar CSS class names; not user-facing copy.
                    `${cellBase} ${
                      closed ? "calendar-non-working-band" : "hover:bg-muted/30"
                    } focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary`
                  }
                >
                  {cellContent}
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
