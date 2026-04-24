"use client";

import Link from "next/link";
import { ChevronLeft, ChevronRight, CalendarPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/appointments/status-badge";
import { AppointmentActions } from "@/components/appointments/appointment-actions";
import type { Tables } from "@/types/database";

type Appointment = Tables<"appointments"> & {
  patients: { full_name: string } | null;
  profiles: { full_name: string } | null;
  departments: { name: string; color: string } | null;
};

interface Props {
  appointments: Appointment[];
  date: Date;
  canEdit: boolean;
}

function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function fmt(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function DayCalendar({ appointments, date, canEdit }: Props) {
  const prev = addDays(date, -1);
  const next = addDays(date, 1);

  const sorted = [...appointments].sort(
    (a, b) =>
      new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime(),
  );

  return (
    <div className="space-y-4">
      {/* Nav */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm" className="h-8 w-8 p-0">
            <Link href={`/appointments?view=day&date=${fmt(prev)}`} aria-label="Previous day">
              <ChevronLeft className="h-4 w-4" />
            </Link>
          </Button>
          <span className="text-sm font-medium">
            {date.toLocaleDateString("en-GB", {
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </span>
          <Button asChild variant="outline" size="sm" className="h-8 w-8 p-0">
            <Link href={`/appointments?view=day&date=${fmt(next)}`} aria-label="Next day">
              <ChevronRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>

        {canEdit && (
          <Button asChild size="sm" className="gap-1.5">
            <Link href="/appointments/new">
              <CalendarPlus className="h-4 w-4" />
              New appointment
            </Link>
          </Button>
        )}
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-6 py-12 text-center text-sm text-muted-foreground">
          No appointments scheduled for this day.
        </div>
      ) : (
        <div className="rounded-xl border border-border/50 bg-card divide-y divide-border/40">
          {sorted.map((a) => (
            <DayRow key={a.id} appt={a} canEdit={canEdit} />
          ))}
        </div>
      )}
    </div>
  );
}

function DayRow({ appt, canEdit }: { appt: Appointment; canEdit: boolean }) {
  const time = new Date(appt.scheduled_at).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Istanbul",
  });
  const deptColor = appt.departments?.color ?? "#64748b";
  const deptName = appt.departments?.name ?? "General";

  return (
    <div
      className="flex flex-wrap items-center gap-4 px-4 py-3"
      style={{
        backgroundColor: `color-mix(in oklab, ${deptColor} 4%, transparent)`,
      }}
    >
      <div className="flex min-w-[70px] flex-col">
        <span className="font-mono text-base font-semibold tabular-nums">
          {time}
        </span>
      </div>
      <span
        aria-hidden
        className="h-10 w-1 shrink-0 rounded-full"
        style={{ backgroundColor: deptColor }}
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">
            {appt.patients?.full_name ?? "Unknown"}
          </span>
          <span
            className="rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
            style={{
              backgroundColor: `color-mix(in oklab, ${deptColor} 18%, transparent)`,
              color: deptColor,
            }}
          >
            {deptName}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          Dr. {appt.profiles?.full_name ?? "Unassigned"}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <StatusBadge status={appt.status} />
        {canEdit && (
          <AppointmentActions
            appointmentId={appt.id}
            currentStatus={appt.status}
            hasInsurance={Boolean(appt.insurance_provider_id)}
          />
        )}
      </div>
    </div>
  );
}
