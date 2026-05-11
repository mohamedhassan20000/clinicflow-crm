"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, CalendarPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Tables } from "@/types/database";

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
  monthStart: Date; // first day of month (local)
  canEdit: boolean;
}

function addMonths(d: Date, n: number) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

function fmtMonth(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function fmtDate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function localDateKey(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function MonthCalendar({ appointments, monthStart, canEdit }: Props) {
  const today = new Date();
  const prevMonth = addMonths(monthStart, -1);
  const nextMonth = addMonths(monthStart, 1);
  const appointmentsByDate = useMemo(() => {
    const grouped = new Map<string, Appointment[]>();
    const sorted = [...appointments].sort(
      (a, b) =>
        new Date(a.scheduled_at).getTime() -
        new Date(b.scheduled_at).getTime(),
    );

    for (const appointment of sorted) {
      const key = localDateKey(new Date(appointment.scheduled_at));
      const dayAppointments = grouped.get(key) ?? [];
      dayAppointments.push(appointment);
      grouped.set(key, dayAppointments);
    }

    return grouped;
  }, [appointments]);

  // Build grid: start from Monday on/before the 1st
  const firstDay = new Date(monthStart);
  const dayOfWeek = firstDay.getDay(); // 0=Sun..6=Sat
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const gridStart = new Date(firstDay);
  gridStart.setDate(gridStart.getDate() + mondayOffset);

  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + i);
    cells.push(d);
  }

  // Trim to 5 rows if the 6th row is entirely outside this month
  const showRows =
    cells[35].getMonth() === monthStart.getMonth() ||
    cells[35 + 6]?.getMonth() === monthStart.getMonth()
      ? 6
      : 5;
  const visible = cells.slice(0, showRows * 7);

  return (
    <div className="space-y-4">
      {/* Nav */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm" className="h-8 w-8 p-0">
            <Link href={`/appointments?view=month&month=${fmtMonth(prevMonth)}`} aria-label="Previous month">
              <ChevronLeft className="h-4 w-4" />
            </Link>
          </Button>
          <span className="min-w-0 text-sm font-medium">
            {monthStart.toLocaleDateString("en-GB", {
              month: "long",
              year: "numeric",
            })}
          </span>
          <Button asChild variant="outline" size="sm" className="h-8 w-8 p-0">
            <Link href={`/appointments?view=month&month=${fmtMonth(nextMonth)}`} aria-label="Next month">
              <ChevronRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>

        {canEdit && (
          <Button asChild size="sm" className="shrink-0 gap-1.5">
            <Link href="/appointments/new">
              <CalendarPlus className="h-4 w-4" />
              New appointment
            </Link>
          </Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-border/50">
        <div className="min-w-[860px]">
          <div className="grid grid-cols-7 border-b border-border/50 bg-muted/30 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {DAY_NAMES.map((d) => (
              <div key={d} className="px-2 py-2 text-center">
                {d}
              </div>
            ))}
          </div>

          <div className="grid auto-rows-[minmax(110px,_1fr)] grid-cols-7">
            {visible.map((day, i) => {
              const inMonth = day.getMonth() === monthStart.getMonth();
              const isToday = isSameDay(day, today);
              const dayAppts = appointmentsByDate.get(localDateKey(day)) ?? [];

              return (
                <Link
                  key={i}
                  href={`/appointments?view=day&date=${fmtDate(day)}`}
                  className={`group border-b border-r border-border/40 p-1.5 transition-colors hover:bg-muted/30 ${
                    i % 7 === 6 ? "border-r-0" : ""
                  } ${!inMonth ? "bg-muted/10 text-muted-foreground/50" : ""}`}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span
                      className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                        isToday
                          ? "bg-primary text-primary-foreground"
                          : inMonth
                            ? "text-foreground"
                            : ""
                      }`}
                    >
                      {day.getDate()}
                    </span>
                    {dayAppts.length > 0 && (
                      <span className="text-[10px] text-muted-foreground">
                        {dayAppts.length}
                      </span>
                    )}
                  </div>
                  <div className="space-y-0.5">
                    {dayAppts.slice(0, 3).map((a) => {
                      const color = a.departments?.color ?? "#64748b";
                      const time = new Date(a.scheduled_at).toLocaleTimeString(
                        "en-GB",
                        {
                          hour: "2-digit",
                          minute: "2-digit",
                          timeZone: "Europe/Istanbul",
                        },
                      );
                      return (
                        <div
                          key={a.id}
                          className="truncate rounded px-1 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: `color-mix(in oklab, ${color} 14%, transparent)`,
                            color,
                          }}
                          title={`${time} · ${a.patients?.full_name ?? ""}${a.notes ? ` · ${a.notes}` : ""}`}
                        >
                          <span className="font-semibold tabular-nums">
                            {time}
                          </span>
                          <span className="ml-1 text-foreground/80">
                            {a.patients?.full_name ?? "—"}
                          </span>
                          {a.notes && (
                            <span className="ml-1 text-muted-foreground">
                              •
                            </span>
                          )}
                        </div>
                      );
                    })}
                    {dayAppts.length > 3 && (
                      <div className="px-1 text-[10px] text-muted-foreground">
                        +{dayAppts.length - 3} more
                      </div>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
