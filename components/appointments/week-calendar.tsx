"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, CalendarPlus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { StatusBadge } from "@/components/appointments/status-badge";
import { AppointmentActions } from "@/components/appointments/appointment-actions";
import { softDeleteAppointment, restoreAppointment } from "@/actions/appointments";
import {
  AppointmentDetailDialog,
  type AppointmentForDetail,
} from "@/components/appointments/appointment-detail-dialog";
import type { ClinicWorkingHoursValues } from "@/lib/validations/settings";

type Appointment = AppointmentForDetail;

// ── Time grid constants ────────────────────────────────────────────────────────
const ROW_PX = 24; // px per 15-minute slot
const STEP_MIN = 15;

function timeStrToMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

// Returns the appointment's start time in minutes since midnight (Istanbul).
function apptStartMin(appt: Appointment): number {
  return timeStrToMin(
    new Date(appt.scheduled_at).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Istanbul",
    }),
  );
}

interface GridBounds {
  startMin: number; // grid top edge in minutes
  endMin: number;   // grid bottom edge in minutes
}

// Break periods = gaps between consecutive clinic shifts for a given day.
interface BreakBand {
  startMin: number;
  endMin: number;
}

function getGridBounds(clinicHours: ClinicWorkingHoursValues): GridBounds {
  const allShifts = clinicHours.flatMap((d) => (d.open ? d.shifts : []));
  if (allShifts.length === 0) return { startMin: 8 * 60, endMin: 18 * 60 };
  const starts = allShifts.map((s) => timeStrToMin(s.shift_start));
  const ends = allShifts.map((s) => timeStrToMin(s.shift_end));
  return { startMin: Math.min(...starts), endMin: Math.max(...ends) };
}

// Returns break bands for a specific day-of-week (0=Sun…6=Sat).
function getBreakBands(
  clinicHours: ClinicWorkingHoursValues,
  dow: number,
): BreakBand[] {
  const day = clinicHours.find((d) => d.day_of_week === dow);
  if (!day?.open || day.shifts.length < 2) return [];
  const sorted = [...day.shifts].sort(
    (a, b) => timeStrToMin(a.shift_start) - timeStrToMin(b.shift_start),
  );
  const bands: BreakBand[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const gapStart = timeStrToMin(sorted[i]!.shift_end);
    const gapEnd = timeStrToMin(sorted[i + 1]!.shift_start);
    if (gapEnd > gapStart) bands.push({ startMin: gapStart, endMin: gapEnd });
  }
  return bands;
}

function isDayClosed(clinicHours: ClinicWorkingHoursValues, dow: number): boolean {
  // Only mark closed if hours are configured AND this day is not open.
  const hasAnyConfig = clinicHours.some((d) => d.open);
  if (!hasAnyConfig) return false;
  const day = clinicHours.find((d) => d.day_of_week === dow);
  return !day?.open;
}

// Overlap layout: assigns colIndex/colCount to each appointment.
type LayoutAppt = Appointment & { colIndex: number; colCount: number };

function computeOverlapLayout(appts: Appointment[]): LayoutAppt[] {
  if (appts.length === 0) return [];
  const sorted = [...appts].sort(
    (a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime(),
  );

  // Build augmented list with start/end in minutes
  const items = sorted.map((a) => ({
    appt: a,
    start: apptStartMin(a),
    end: apptStartMin(a) + (a.duration_minutes ?? 30),
    colIndex: 0,
    colCount: 1,
  }));

  // Sweep-line grouping
  let groupStart = 0;
  let groupEndMin = items[0]!.end;

  for (let i = 1; i < items.length; i++) {
    if (items[i]!.start < groupEndMin) {
      // Part of the current overlap group
      groupEndMin = Math.max(groupEndMin, items[i]!.end);
    } else {
      // Close current group
      assignColumns(items, groupStart, i);
      groupStart = i;
      groupEndMin = items[i]!.end;
    }
  }
  assignColumns(items, groupStart, items.length);

  return items.map(({ appt, colIndex, colCount }) => ({
    ...appt,
    colIndex,
    colCount,
  }));
}

function assignColumns(
  items: { colIndex: number; colCount: number; start: number; end: number }[],
  from: number,
  to: number,
) {
  const group = items.slice(from, to);
  const colCount = group.length; // simple: one column per appointment in the group
  // Assign columns using a free-list (greedy interval scheduling)
  const freeAt: number[] = Array(colCount).fill(0);
  for (const item of group) {
    let col = 0;
    for (let c = 0; c < colCount; c++) {
      if ((freeAt[c] ?? 0) <= item.start) { col = c; break; }
    }
    item.colIndex = col;
    freeAt[col] = item.end;
  }
  // Determine actual max column used in this group for width calculation
  const maxCol = Math.max(...group.map((g) => g.colIndex)) + 1;
  for (const item of group) {
    item.colCount = maxCol;
  }
}

// ── Calendar helpers ──────────────────────────────────────────────────────────

interface WeekCalendarProps {
  appointments: Appointment[];
  weekStart: Date;
  canEdit: boolean;
  clinicHours?: ClinicWorkingHoursValues;
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

function localDateKey(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// JS getDay(): 0=Sun,1=Mon…6=Sat → convert day index (0=Mon…6=Sun) to JS dow
function dayIndexToDow(i: number): number {
  return i === 6 ? 0 : i + 1;
}

// ── Main component ────────────────────────────────────────────────────────────

export function WeekCalendar({
  appointments,
  weekStart,
  canEdit,
  clinicHours = [],
}: WeekCalendarProps) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = new Date();

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

  const { startMin, endMin } = getGridBounds(clinicHours);
  const gridHeightPx = ((endMin - startMin) / STEP_MIN) * ROW_PX;

  // Hour labels: one per 60 min within the grid
  const hourLabels: number[] = [];
  for (let m = startMin; m <= endMin; m += 60) hourLabels.push(m);

  const prevWeek = addDays(weekStart, -7);
  const nextWeek = addDays(weekStart, 7);
  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${day}`;
  };

  return (
    <div className="space-y-4">
      {/* Nav */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm" className="h-8 w-8 p-0">
            <Link href={`/appointments?week=${fmt(prevWeek)}`} aria-label="Previous week">
              <ChevronLeft className="h-4 w-4" />
            </Link>
          </Button>
          <span className="min-w-0 text-sm font-medium">
            {weekStart.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}{" "}
            —{" "}
            {addDays(weekStart, 6).toLocaleDateString("en-GB", {
              day: "numeric", month: "short", year: "numeric",
            })}
          </span>
          <Button asChild variant="outline" size="sm" className="h-8 w-8 p-0">
            <Link href={`/appointments?week=${fmt(nextWeek)}`} aria-label="Next week">
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

      {/* Grid */}
      <div className="overflow-x-auto rounded-xl border border-border/40 bg-card/40">
        <div className="flex min-w-[1020px]">

          {/* Time axis */}
          <div className="relative w-10 shrink-0 border-r border-border/30" style={{ height: gridHeightPx + 32 }}>
            {/* Spacer for day-header row */}
            <div className="h-8" />
            <div className="relative" style={{ height: gridHeightPx }}>
              {hourLabels.map((min) => (
                <div
                  key={min}
                  className="absolute right-1 text-[9px] text-muted-foreground/50 leading-none -translate-y-2"
                  style={{ top: ((min - startMin) / STEP_MIN) * ROW_PX }}
                >
                  {String(Math.floor(min / 60)).padStart(2, "0")}:{String(min % 60).padStart(2, "0")}
                </div>
              ))}
              {/* Horizontal grid lines */}
              {hourLabels.map((min) => (
                <div
                  key={`line-${min}`}
                  className="absolute left-0 right-0 border-t border-border/20"
                  style={{ top: ((min - startMin) / STEP_MIN) * ROW_PX }}
                />
              ))}
            </div>
          </div>

          {/* Day columns */}
          <div className="grid flex-1 grid-cols-7 divide-x divide-border/30">
            {days.map((day, i) => {
              const isToday = isSameDay(day, today);
              const dayAppts = appointmentsByDate.get(localDateKey(day)) ?? [];
              const dow = dayIndexToDow(i);
              const breaks = getBreakBands(clinicHours, dow);
              const closed = isDayClosed(clinicHours, dow);
              const layoutAppts = computeOverlapLayout(dayAppts);

              return (
                <div key={i} className="flex flex-col">
                  {/* Day header */}
                  <div
                    className={`h-8 flex items-center justify-center gap-1 text-xs font-medium border-b border-border/30 ${
                      isToday ? "bg-primary text-primary-foreground" : "bg-muted/30 text-muted-foreground"
                    }`}
                  >
                    <span>{DAY_NAMES[i]}</span>
                    <span className={isToday ? "" : "text-foreground font-semibold"}>
                      {day.getDate()}
                    </span>
                  </div>

                  {/* Time grid body */}
                  <div className="relative" style={{ height: gridHeightPx }}>
                    {/* Hour lines */}
                    {hourLabels.map((min) => (
                      <div
                        key={min}
                        className="absolute inset-x-0 border-t border-border/20"
                        style={{ top: ((min - startMin) / STEP_MIN) * ROW_PX }}
                      />
                    ))}

                    {/* Break bands */}
                    {breaks.map((b, bi) => {
                      const top = ((b.startMin - startMin) / STEP_MIN) * ROW_PX;
                      const height = ((b.endMin - b.startMin) / STEP_MIN) * ROW_PX;
                      return (
                        <div
                          key={bi}
                          className="absolute inset-x-0 bg-muted/40 flex items-center justify-center pointer-events-none"
                          style={{ top, height }}
                        >
                          <span className="text-[9px] text-muted-foreground/50 font-medium uppercase tracking-widest">
                            Break
                          </span>
                        </div>
                      );
                    })}

                    {/* Closed-day overlay */}
                    {closed && (
                      <div className="absolute inset-0 bg-muted/50 flex items-center justify-center pointer-events-none">
                        <span className="text-[9px] text-muted-foreground/50 font-medium uppercase tracking-widest">
                          Closed
                        </span>
                      </div>
                    )}

                    {/* Appointment cards */}
                    {layoutAppts.map((appt) => {
                      const apptMin = apptStartMin(appt);
                      const duration = appt.duration_minutes ?? 30;
                      const top = ((apptMin - startMin) / STEP_MIN) * ROW_PX;
                      const height = Math.max((duration / STEP_MIN) * ROW_PX, ROW_PX);
                      const leftPct = (appt.colIndex / appt.colCount) * 100;
                      const widthPct = (1 / appt.colCount) * 100;

                      return (
                        <div
                          key={appt.id}
                          className="absolute px-0.5 py-0.5 box-border"
                          style={{
                            top,
                            height,
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                          }}
                        >
                          <AppointmentCard appt={appt} canEdit={canEdit} compact={height < 56} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Appointment card ──────────────────────────────────────────────────────────

function AppointmentCard({
  appt,
  canEdit,
  compact = false,
}: {
  appt: Appointment;
  canEdit: boolean;
  compact?: boolean;
}) {
  const [deleted, setDeleted] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
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
        toast.success(`Appointment for ${patientName} moved to trash.`, {
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
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setDetailOpen(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setDetailOpen(true); }}
        className="group relative h-full w-full overflow-hidden rounded-md border text-xs transition-colors hover:brightness-[1.02] cursor-pointer"
        style={{
          borderColor: `color-mix(in oklab, ${deptColor} 35%, transparent)`,
          backgroundColor: `color-mix(in oklab, ${deptColor} 8%, var(--card))`,
        }}
      >
        {/* Left accent bar */}
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-1 rounded-l-sm"
          style={{ backgroundColor: deptColor }}
        />

        <div className="pl-2 pr-1 pt-0.5 h-full flex flex-col justify-start gap-0.5 min-w-0">
          <div className="flex items-start justify-between gap-1">
            <span className="font-medium text-foreground leading-tight truncate">
              {patientName}
            </span>
            {canEdit && !compact && (
              <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
                <button
                  onClick={(e) => { e.stopPropagation(); setConfirmOpen(true); }}
                  disabled={isDeleting || isRestoring}
                  className="shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-destructive transition-opacity"
                  title="Move to trash"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Move appointment to trash?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The appointment for <strong>{patientName}</strong> will be moved to the recycle bin.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      disabled={isDeleting}
                      onClick={(e) => { e.preventDefault(); setConfirmOpen(false); handleDelete(); }}
                    >
                      Move to trash
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>

          {!compact && (
            <>
              <div className="flex min-w-0 items-center justify-between gap-1 text-muted-foreground">
                <span>{time}</span>
                <span
                  className="max-w-[70px] truncate rounded-sm px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
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
            </>
          )}

          {compact && (
            <span className="text-muted-foreground truncate">{time}</span>
          )}

          {!compact && <StatusBadge status={appt.status} />}

          {canEdit && !compact && (
            <div className="pt-0.5" onClick={(e) => e.stopPropagation()}>
              <AppointmentActions
                appointmentId={appt.id}
                currentStatus={appt.status}
                hasInsurance={Boolean(appt.insurance_provider_id)}
              />
            </div>
          )}
        </div>
      </div>

      <AppointmentDetailDialog
        appointment={appt}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        canEdit={canEdit}
      />
    </>
  );
}
