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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

// Groups appointments by 60-minute hour bucket based on start time.
// Appointments starting in the same hour (e.g. 10:00–10:59) are grouped together.
function groupByHourBucket(appts: Appointment[]): Map<number, Appointment[]> {
  const groups = new Map<number, Appointment[]>();
  for (const appt of appts) {
    const startMin = apptStartMin(appt);
    const bucket = Math.floor(startMin / 60) * 60;
    const existing = groups.get(bucket) ?? [];
    existing.push(appt);
    groups.set(bucket, existing);
  }
  // Sort each bucket by start time
  for (const [key, list] of groups) {
    groups.set(key, [...list].sort(
      (a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime(),
    ));
  }
  return groups;
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
  const allDays = Array.from({ length: 7 }, (_, i) => ({
    day: addDays(weekStart, i),
    originalIndex: i,
  }));
  // Hide closed days from the week view (month view is unaffected)
  const visibleDays = allDays.filter(({ originalIndex }) => {
    const dow = dayIndexToDow(originalIndex);
    return !isDayClosed(clinicHours, dow);
  });
  // Fall back to showing all 7 if no clinic hours are configured
  const displayDays = visibleDays.length > 0 ? visibleDays : allDays;
  const colCount = displayDays.length;
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
        <div className="flex" style={{ minWidth: `${colCount * 146}px` }}>

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
          <div
            className="grid flex-1 divide-x divide-border/30"
            style={{ gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))` }}
          >
            {displayDays.map(({ day, originalIndex }) => {
              const i = originalIndex;
              const isToday = isSameDay(day, today);
              const dayAppts = appointmentsByDate.get(localDateKey(day)) ?? [];
              const dow = dayIndexToDow(i);
              const breaks = getBreakBands(clinicHours, dow);
              const hourBuckets = groupByHourBucket(dayAppts);

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

                    {/* Appointment groups by hour bucket */}
                    {Array.from(hourBuckets.entries()).map(([bucketMin, appts]) => {
                      const groupTop = ((bucketMin - startMin) / STEP_MIN) * ROW_PX;

                      // 5+ in the same hour → summary card
                      if (appts.length >= 5) {
                        return (
                          <div
                            key={`summary-${bucketMin}`}
                            className="absolute inset-x-0 px-0.5 py-0.5 box-border"
                            style={{ top: groupTop, height: 4 * ROW_PX }}
                          >
                            <HourSummaryCard
                              appointments={appts}
                              canEdit={canEdit}
                              bucketMin={bucketMin}
                            />
                          </div>
                        );
                      }

                      // 2–4 → stack vertically from bucket top
                      if (appts.length > 1) {
                        return (
                          <div
                            key={`group-${bucketMin}`}
                            className="absolute inset-x-0 px-0.5 py-0.5 box-border flex flex-col gap-0.5"
                            style={{ top: groupTop }}
                          >
                            {appts.map((appt) => {
                              const h = Math.max(
                                ((appt.duration_minutes ?? 30) / STEP_MIN) * ROW_PX,
                                ROW_PX,
                              );
                              return (
                                <div key={appt.id} style={{ height: h }} className="min-w-0">
                                  <AppointmentCard appt={appt} canEdit={canEdit} compact={h < 56} />
                                </div>
                              );
                            })}
                          </div>
                        );
                      }

                      // Single appointment → position at exact time
                      const appt = appts[0]!;
                      const apptMin = apptStartMin(appt);
                      const h = Math.max(
                        ((appt.duration_minutes ?? 30) / STEP_MIN) * ROW_PX,
                        ROW_PX,
                      );
                      const top = ((apptMin - startMin) / STEP_MIN) * ROW_PX;
                      return (
                        <div
                          key={appt.id}
                          className="absolute inset-x-0 px-0.5 py-0.5 box-border"
                          style={{ top, height: h }}
                        >
                          <AppointmentCard appt={appt} canEdit={canEdit} compact={h < 56} />
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

// ── Hour summary card (5+ appointments in the same hour bucket) ───────────────

const STATUS_SORT_RANK: Record<string, number> = {
  confirmed: 0,
  pending: 1,
  completed: 2,
  no_show: 3,
  cancelled: 4,
};

function HourSummaryCard({
  appointments,
  canEdit,
  bucketMin,
}: {
  appointments: Appointment[];
  canEdit: boolean;
  bucketMin: number;
}) {
  const [open, setOpen] = useState(false);
  const [selectedAppt, setSelectedAppt] = useState<Appointment | null>(null);

  const sorted = [...appointments].sort(
    (a, b) => (STATUS_SORT_RANK[a.status] ?? 9) - (STATUS_SORT_RANK[b.status] ?? 9),
  );

  const hourLabel = `${String(Math.floor(bucketMin / 60)).padStart(2, "0")}:00`;

  const statusCounts = appointments.reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="h-full w-full overflow-hidden rounded-md border border-border/50 bg-muted/30 text-left text-xs transition-colors hover:bg-muted/50 flex flex-col items-center justify-center gap-1 cursor-pointer"
      >
        <span className="font-semibold text-foreground">{appointments.length} appointments</span>
        <span className="text-muted-foreground">{hourLabel} hour</span>
        <div className="flex gap-1 flex-wrap justify-center">
          {statusCounts["confirmed"] ? (
            <span className="rounded-full bg-primary/20 px-1.5 py-0.5 text-[9px] font-medium text-primary">
              {statusCounts["confirmed"]} confirmed
            </span>
          ) : null}
          {statusCounts["pending"] ? (
            <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-400">
              {statusCounts["pending"]} pending
            </span>
          ) : null}
          {statusCounts["completed"] ? (
            <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-600 dark:text-emerald-400">
              {statusCounts["completed"]} done
            </span>
          ) : null}
        </div>
      </button>

      {/* Appointment list dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{appointments.length} appointments at {hourLabel}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
            {sorted.map((appt) => {
              const time = new Date(appt.scheduled_at).toLocaleTimeString("en-GB", {
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "Europe/Istanbul",
              });
              const deptColor = appt.departments?.color ?? "#64748b";
              return (
                <button
                  key={appt.id}
                  onClick={() => setSelectedAppt(appt)}
                  className="w-full text-left rounded-lg border border-border/40 px-3 py-2 text-sm hover:bg-muted/40 transition-colors flex items-center gap-3"
                >
                  <span
                    className="h-2 w-2 rounded-full shrink-0"
                    style={{ backgroundColor: deptColor }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{appt.patients?.full_name ?? "—"}</div>
                    <div className="text-muted-foreground text-xs">
                      {time} · {appt.duration_minutes ?? 30}min
                      {appt.departments?.name ? ` · ${appt.departments.name}` : ""}
                    </div>
                  </div>
                  <StatusBadge status={appt.status} />
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      {/* Per-appointment detail dialog */}
      {selectedAppt && (
        <AppointmentDetailDialog
          appointment={selectedAppt}
          open={Boolean(selectedAppt)}
          onOpenChange={(v) => { if (!v) setSelectedAppt(null); }}
          canEdit={canEdit}
        />
      )}
    </>
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
            <div className="flex items-center gap-1 min-w-0">
              <span
                className="h-1.5 w-1.5 rounded-full shrink-0"
                style={{
                  backgroundColor:
                    appt.status === "confirmed" ? "hsl(var(--primary))"
                    : appt.status === "completed" ? "#10b981"
                    : appt.status === "cancelled" ? "hsl(var(--destructive))"
                    : appt.status === "no_show" ? "hsl(var(--muted-foreground))"
                    : "#f59e0b", // pending
                }}
              />
              <span className="text-muted-foreground truncate">{time}</span>
            </div>
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
