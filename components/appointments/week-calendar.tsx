"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, CalendarPlus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/appointments/status-badge";
import { AppointmentActions } from "@/components/appointments/appointment-actions";
import { softDeleteAppointment, restoreAppointment } from "@/actions/appointments";
import type { Tables } from "@/types/database";

type Appointment = Tables<"appointments"> & {
  patients: { full_name: string } | null;
  profiles: { full_name: string } | null;
  departments: { name: string; color: string } | null;
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
  // Local YYYY-MM-DD so we don't shift into the previous day via UTC conversion
  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  return (
    <div className="space-y-4">
      {/* Nav */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm" className="h-8 w-8 p-0">
            <Link href={`/appointments?week=${fmt(prevWeek)}`} aria-label="Previous week">
              <ChevronLeft className="h-4 w-4" />
            </Link>
          </Button>
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
          <Button asChild variant="outline" size="sm" className="h-8 w-8 p-0">
            <Link href={`/appointments?week=${fmt(nextWeek)}`} aria-label="Next week">
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
  const [deleted, setDeleted] = useState(false);
  const [isDeleting, startDelete] = useTransition();
  const [isRestoring, setIsRestoring] = useState(false);
  const isRestoringRef = useRef(false);

  const time = new Date(appt.scheduled_at).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Istanbul",
  });

  const deptColor = appt.departments?.color ?? "#64748b";
  const deptName = appt.departments?.name ?? "General";
  const patientName = appt.patients?.full_name ?? "Unknown";

  if (deleted) return null;

  function handleDelete() {
    if (isDeleting || isRestoring) return;
    startDelete(async () => {
      const res = await softDeleteAppointment(appt.id);
      if (res.error) {
        toast.error(res.error);
      } else {
        setDeleted(true);
        toast.success(`Appointment for ${patientName} deleted.`, {
          duration: 10000,
          action: {
            label: "Undo",
            onClick: () => {
              if (isRestoringRef.current) return;
              isRestoringRef.current = true;
              setIsRestoring(true);
              restoreAppointment(appt.id)
                .then((r) => {
                  if (r.error) toast.error(r.error);
                  else setDeleted(false);
                })
                .finally(() => {
                  isRestoringRef.current = false;
                  setIsRestoring(false);
                });
            },
          },
        });
      }
    });
  }

  return (
    <div
      className="group relative rounded-lg border p-2 pl-2.5 text-xs space-y-1 transition-colors hover:brightness-[1.02]"
      style={{
        borderColor: `color-mix(in oklab, ${deptColor} 35%, transparent)`,
        backgroundColor: `color-mix(in oklab, ${deptColor} 8%, var(--card))`,
      }}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1 rounded-l-lg"
        style={{ backgroundColor: deptColor }}
      />
      <div className="flex items-start justify-between gap-1">
        <div className="font-medium text-foreground leading-tight truncate">
          {patientName}
        </div>
        {canEdit && (
          <button
            onClick={handleDelete}
            disabled={isDeleting || isRestoring}
            className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-destructive transition-opacity"
            title="Delete appointment"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className="flex items-center justify-between text-muted-foreground">
        <span>{time}</span>
        <span
          className="rounded-sm px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
          style={{
            backgroundColor: `color-mix(in oklab, ${deptColor} 18%, transparent)`,
            color: deptColor,
          }}
        >
          {deptName}
        </span>
      </div>
      <div className="text-muted-foreground/70 truncate">
        {appt.profiles?.full_name ?? "—"}
      </div>
      <StatusBadge status={appt.status} />
      {canEdit && (
        <div className="pt-0.5">
          <AppointmentActions
            appointmentId={appt.id}
            currentStatus={appt.status}
            hasInsurance={Boolean(appt.insurance_provider_id)}
          />
        </div>
      )}
    </div>
  );
}
