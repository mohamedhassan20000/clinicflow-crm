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
};

interface WeekCalendarProps {
  appointments: Appointment[];
  weekStart: Date;
  canEdit: boolean;
}

function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function WeekCalendar({
  appointments,
  weekStart,
  canEdit,
}: WeekCalendarProps) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = new Date();

  const prevWeek = addDays(weekStart, -7);
  const nextWeek = addDays(weekStart, 7);
  const fmt = (d: Date) => d.toISOString().split("T")[0];

  return (
    <div className="space-y-4">
      {/* Nav */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link href={`/appointments?week=${fmt(prevWeek)}`}>
            <Button variant="outline" size="sm" className="h-8 w-8 p-0">
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </Link>
          <span className="text-sm font-medium">
            {weekStart.toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
            })}{" "}
            —{" "}
            {addDays(weekStart, 6).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </span>
          <Link href={`/appointments?week=${fmt(nextWeek)}`}>
            <Button variant="outline" size="sm" className="h-8 w-8 p-0">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>

        {canEdit && (
          <Link href="/appointments/new">
            <Button size="sm" className="gap-1.5">
              <CalendarPlus className="h-4 w-4" />
              New appointment
            </Button>
          </Link>
        )}
      </div>

      {/* 7-column grid */}
      <div className="grid grid-cols-7 gap-2 overflow-x-auto">
        {days.map((day, i) => {
          const isToday = isSameDay(day, today);
          const dayAppts = appointments
            .filter((a) => isSameDay(new Date(a.scheduled_at), day))
            .sort(
              (a, b) =>
                new Date(a.scheduled_at).getTime() -
                new Date(b.scheduled_at).getTime(),
            );

          return (
            <div key={i} className="min-w-[130px]">
              {/* Day header */}
              <div
                className={`mb-2 rounded-lg px-2 py-1.5 text-center ${
                  isToday
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted/40 text-muted-foreground"
                }`}
              >
                <p className="text-xs font-medium">{DAY_NAMES[i]}</p>
                <p
                  className={`text-lg font-semibold leading-none mt-0.5 ${isToday ? "" : "text-foreground"}`}
                >
                  {day.getDate()}
                </p>
              </div>

              {/* Appointments */}
              <div className="space-y-1.5">
                {dayAppts.length === 0 && (
                  <p className="px-1 text-xs text-muted-foreground/40 text-center py-2">
                    —
                  </p>
                )}
                {dayAppts.map((appt) => (
                  <AppointmentCard
                    key={appt.id}
                    appt={appt}
                    canEdit={canEdit}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AppointmentCard({
  appt,
  canEdit,
}: {
  appt: Appointment;
  canEdit: boolean;
}) {
  const time = new Date(appt.scheduled_at).toLocaleTimeString("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Istanbul",
  });

  return (
    <div className="group rounded-lg border border-border/50 bg-card p-2 text-xs space-y-1 hover:border-primary/30 hover:bg-primary/5 transition-colors">
      <div className="font-medium text-foreground leading-tight truncate">
        {appt.patients?.full_name ?? "Unknown"}
      </div>
      <div className="text-muted-foreground">{time}</div>
      <div className="text-muted-foreground/70 truncate">
        {appt.profiles?.full_name ?? "—"}
      </div>
      <StatusBadge status={appt.status} />
      {canEdit && (
        <div className="pt-0.5">
          <AppointmentActions appointmentId={appt.id} currentStatus={appt.status} />
        </div>
      )}
    </div>
  );
}
