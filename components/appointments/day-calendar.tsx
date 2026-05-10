"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, CalendarPlus, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/appointments/status-badge";
import { AppointmentActions } from "@/components/appointments/appointment-actions";
import { softDeleteAppointment, restoreAppointment } from "@/actions/appointments";
import type { Tables } from "@/types/database";
import { formatDoctorName } from "@/lib/format-doctor";

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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm" className="h-8 w-8 p-0">
            <Link href={`/appointments?view=day&date=${fmt(prev)}`} aria-label="Previous day">
              <ChevronLeft className="h-4 w-4" />
            </Link>
          </Button>
          <span className="min-w-0 text-sm font-medium">
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
          <Button asChild size="sm" className="shrink-0 gap-1.5">
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
        <div className="divide-y divide-border/40 rounded-xl border border-border/50 bg-card">
          {sorted.map((a) => (
            <DayRow key={a.id} appt={a} canEdit={canEdit} />
          ))}
        </div>
      )}
    </div>
  );
}

function DayRow({ appt, canEdit }: { appt: Appointment; canEdit: boolean }) {
  const [deleted, setDeleted] = useState(false);
  const [isDeleting, startDelete] = useTransition();

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
              restoreAppointment(appt.id).then((r) => {
                if (r.error) toast.error(r.error);
                else setDeleted(false);
              });
            },
          },
        });
      }
    });
  }

  return (
    <div
      className="flex flex-wrap items-start gap-3 px-3 py-3 sm:gap-4 sm:px-4"
      style={{
        backgroundColor: `color-mix(in oklab, ${deptColor} 4%, transparent)`,
      }}
    >
      <div className="flex min-w-[58px] flex-col sm:min-w-[70px]">
        <span className="font-mono text-base font-semibold tabular-nums">
          {time}
        </span>
      </div>
      <span
        aria-hidden
        className="h-10 w-1 shrink-0 rounded-full"
        style={{ backgroundColor: deptColor }}
      />
      <div className="min-w-0 flex-[1_1_220px] space-y-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 truncate font-medium text-foreground">
            {patientName}
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
          {appt.profiles?.full_name
            ? formatDoctorName(appt.profiles.full_name)
            : "Unassigned"}
        </div>
        {appt.notes && (
          <p className="line-clamp-2 max-w-2xl rounded bg-muted/40 px-2 py-1 text-xs leading-snug text-muted-foreground">
            {appt.notes}
          </p>
        )}
      </div>
      <div className="ml-auto flex w-full shrink-0 flex-wrap items-center justify-start gap-2 sm:w-auto sm:justify-end">
        <StatusBadge status={appt.status} />
        {canEdit && (
          <>
            <AppointmentActions
              appointmentId={appt.id}
              currentStatus={appt.status}
              hasInsurance={Boolean(appt.insurance_provider_id)}
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground/50 hover:text-destructive"
              onClick={handleDelete}
              disabled={isDeleting}
              title="Delete appointment"
            >
              {isDeleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
