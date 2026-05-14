"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, CalendarPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AppointmentDetailDialog,
  type AppointmentForDetail,
} from "@/components/appointments/appointment-detail-dialog";
import { AppointmentCard } from "@/components/appointments/week-calendar";
import { HourAppointmentsDialog } from "@/components/appointments/hour-appointments-dialog";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import type { ClinicWorkingHoursValues } from "@/lib/validations/settings";

type Appointment = AppointmentForDetail;

// ── Time grid constants (must match week-calendar) ────────────────────────────
const BUCKET_H_PX = 420;
const CARD_H_PX   = 110;

function timeStrToMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function apptStartMin(appt: Appointment): number {
  return timeStrToMin(
    new Date(appt.scheduled_at).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Istanbul",
    }),
  );
}

interface GridBounds { startMin: number; endMin: number; }
interface BreakBand  { startMin: number; endMin: number; }

function getGridBounds(clinicHours: ClinicWorkingHoursValues): GridBounds {
  const allShifts = clinicHours.flatMap((d) => (d.open ? d.shifts : []));
  if (allShifts.length === 0) return { startMin: 8 * 60, endMin: 18 * 60 };
  const starts = allShifts.map((s) => timeStrToMin(s.shift_start));
  const ends   = allShifts.map((s) => timeStrToMin(s.shift_end));
  return { startMin: Math.min(...starts), endMin: Math.max(...ends) };
}

function getBreakBands(clinicHours: ClinicWorkingHoursValues, dow: number): BreakBand[] {
  const day = clinicHours.find((d) => d.day_of_week === dow);
  if (!day?.open || day.shifts.length < 2) return [];
  const sorted = [...day.shifts].sort(
    (a, b) => timeStrToMin(a.shift_start) - timeStrToMin(b.shift_start),
  );
  const bands: BreakBand[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const gapStart = timeStrToMin(sorted[i]!.shift_end);
    const gapEnd   = timeStrToMin(sorted[i + 1]!.shift_start);
    if (gapEnd > gapStart) bands.push({ startMin: gapStart, endMin: gapEnd });
  }
  return bands;
}

function isDayClosed(clinicHours: ClinicWorkingHoursValues, dow: number): boolean {
  const hasAnyConfig = clinicHours.some((d) => d.open);
  if (!hasAnyConfig) return false;
  const day = clinicHours.find((d) => d.day_of_week === dow);
  return !day?.open;
}

function groupByHourBucket(appts: Appointment[]): Map<number, Appointment[]> {
  const groups = new Map<number, Appointment[]>();
  for (const appt of appts) {
    const bucket = Math.floor(apptStartMin(appt) / 60) * 60;
    const existing = groups.get(bucket) ?? [];
    existing.push(appt);
    groups.set(bucket, existing);
  }
  for (const [key, list] of groups) {
    groups.set(
      key,
      [...list].sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime()),
    );
  }
  return groups;
}

function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function fmt(d: Date) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dateToDow(d: Date): number { return d.getDay(); }

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  appointments: Appointment[];
  date: Date;
  canEdit: boolean;
  clinicHours?: ClinicWorkingHoursValues;
}

export function DayCalendar({
  appointments,
  date,
  canEdit,
  clinicHours = [],
}: Props) {
  const { formatSlotTime } = useClinicSettings();

  const prev = addDays(date, -1);
  const next = addDays(date, 1);
  const dow  = dateToDow(date);

  const sorted = useMemo(
    () =>
      [...appointments].sort(
        (a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime(),
      ),
    [appointments],
  );

  const { startMin, endMin } = getGridBounds(clinicHours);
  const hourRows: number[] = [];
  for (let m = startMin; m < endMin; m += 60) hourRows.push(m);

  const breaks      = getBreakBands(clinicHours, dow);
  const closed      = isDayClosed(clinicHours, dow);
  const hourBuckets = groupByHourBucket(sorted);

  return (
    <div className="space-y-4">
      {/* Navigation */}
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

      {/* Time grid — same bucket layout as week view */}
      <div className="overflow-x-auto rounded-xl border border-border/40 bg-card/40">
        <div className="flex" style={{ minWidth: 320 }}>

          {/* Time axis */}
          <div className="w-16 shrink-0 border-r border-border/30">
            <div className="h-8 border-b border-border/30" />
            {hourRows.map((hMin) => (
              <div
                key={hMin}
                className="border-b border-border/20 flex items-center justify-center"
                style={{ height: BUCKET_H_PX }}
              >
                <span className="text-[9px] text-muted-foreground/50 leading-none whitespace-nowrap">
                  {formatSlotTime(`${String(Math.floor(hMin / 60)).padStart(2, "0")}:00`)}
                </span>
              </div>
            ))}
          </div>

          {/* Day column */}
          <div className="flex-1 flex flex-col">
            {/* Day header */}
            <div className="h-8 flex items-center justify-center text-xs font-medium border-b border-border/30 bg-muted/30 text-muted-foreground">
              {date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
            </div>

            {closed ? (
              <div
                className="flex items-center justify-center bg-muted/40"
                style={{ height: hourRows.length * BUCKET_H_PX }}
              >
                <span className="text-[9px] text-muted-foreground/50 font-medium uppercase tracking-widest">
                  Closed
                </span>
              </div>
            ) : (
              <>
                {hourRows.map((hMin) => {
                  const isBreak = breaks.some(
                    (b) => b.startMin <= hMin && b.endMin >= hMin + 60,
                  );
                  if (isBreak) {
                    return (
                      <div
                        key={hMin}
                        className="border-b border-border/20 bg-muted/40 flex items-center justify-center"
                        style={{ height: BUCKET_H_PX }}
                      >
                        <span className="text-[9px] text-muted-foreground/50 font-medium uppercase tracking-widest">
                          Break
                        </span>
                      </div>
                    );
                  }

                  const appts = hourBuckets.get(hMin) ?? [];
                  return (
                    <DayBucketCell
                      key={hMin}
                      appts={appts}
                      bucketMin={hMin}
                      canEdit={canEdit}
                    />
                  );
                })}

                {sorted.length === 0 && (
                  <div
                    className="flex items-center justify-center"
                    style={{ height: hourRows.length * BUCKET_H_PX }}
                  >
                    <span className="text-xs text-muted-foreground/40">
                      No appointments scheduled for this day.
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Day bucket cell ───────────────────────────────────────────────────────────
// Max 2 visible; if > 2 show 1 card + "Show all" button.

function DayBucketCell({
  appts,
  bucketMin,
  canEdit,
}: {
  appts: Appointment[];
  bucketMin: number;
  canEdit: boolean;
}) {
  const [showAllOpen, setShowAllOpen] = useState(false);
  const hasMore = appts.length > 3;
  const visible = hasMore ? appts.slice(0, 3) : appts;

  return (
    <div
      className="border-b border-border/20 px-0.5 py-0.5 flex flex-col gap-0.5 overflow-hidden"
      style={{ height: BUCKET_H_PX }}
    >
      {visible.map((appt) => (
        <div key={appt.id} style={{ height: CARD_H_PX }} className="min-w-0 shrink-0">
          <AppointmentCard appt={appt} canEdit={canEdit} compact />
        </div>
      ))}
      {hasMore && (
        <button
          onClick={() => setShowAllOpen(true)}
          className="mt-auto text-[9px] text-primary font-medium hover:underline text-left px-1 leading-none py-0.5 shrink-0"
        >
          Show all ({appts.length})
        </button>
      )}
      {showAllOpen && (
        <HourAppointmentsDialog
          appointments={appts}
          bucketMin={bucketMin}
          open={showAllOpen}
          onOpenChange={setShowAllOpen}
          canEdit={canEdit}
        />
      )}
    </div>
  );
}

// Keep AppointmentDetailDialog available for type re-export if needed
export type { AppointmentForDetail };
void AppointmentDetailDialog;
