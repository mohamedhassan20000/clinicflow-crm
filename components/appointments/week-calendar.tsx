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
import { isDayClosed } from "@/lib/calendar-utils";
import { useClinicSettings } from "@/contexts/clinic-settings-context";

type Appointment = AppointmentForDetail;

// ── Time grid constants ────────────────────────────────────────────────────────
const BUCKET_H_PX = 260; // fixed height per hour row — fits 3 full compact cards
const CARD_H_PX   = 80;  // compact card: name + badge + time + doctor + dept

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

// Groups appointments by hour bucket (floor to nearest hour).
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

  // One row per hour within the grid range
  const hourRows: number[] = [];
  for (let m = startMin; m < endMin; m += 60) hourRows.push(m);

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
          <div className="w-10 shrink-0 border-r border-border/30">
            {/* Spacer for day-header row */}
            <div className="h-8 border-b border-border/30" />
            {/* Hour labels — one per row, aligned with day columns */}
            {hourRows.map((hMin) => (
              <div
                key={hMin}
                className="border-b border-border/20 flex items-start justify-end pr-1 pt-0.5"
                style={{ height: BUCKET_H_PX }}
              >
                <span className="text-[9px] text-muted-foreground/50 leading-none">
                  {String(Math.floor(hMin / 60)).padStart(2, "0")}:00
                </span>
              </div>
            ))}
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

                  {/* Hour bucket rows */}
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
                      <HourBucketRow
                        key={hMin}
                        appts={appts}
                        bucketMin={hMin}
                        canEdit={canEdit}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Hour bucket row ───────────────────────────────────────────────────────────

const MAX_VISIBLE = 3;

function HourBucketRow({
  appts,
  bucketMin,
  canEdit,
}: {
  appts: Appointment[];
  bucketMin: number;
  canEdit: boolean;
}) {
  const [showAllOpen, setShowAllOpen] = useState(false);
  const hasMore = appts.length > MAX_VISIBLE;
  const visibleAppts = hasMore ? appts.slice(0, 2) : appts;

  return (
    <div
      className="border-b border-border/20 px-0.5 py-0.5 flex flex-col gap-0.5 overflow-hidden"
      style={{ height: BUCKET_H_PX }}
    >
      {visibleAppts.map((appt) => (
        <div key={appt.id} style={{ height: CARD_H_PX }} className="min-w-0 shrink-0">
          <AppointmentCard appt={appt} canEdit={canEdit} compact />
        </div>
      ))}
      {hasMore && (
        <button
          onClick={() => setShowAllOpen(true)}
          className="mt-auto text-[9px] text-primary font-medium hover:underline text-left px-1 leading-none py-0.5"
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

// ── Hour appointments dialog ──────────────────────────────────────────────────

const STATUS_SORT_RANK: Record<string, number> = {
  confirmed: 0,
  pending: 1,
  completed: 2,
  no_show: 3,
  cancelled: 4,
};

function HourAppointmentsDialog({
  appointments,
  bucketMin,
  open,
  onOpenChange,
  canEdit,
}: {
  appointments: Appointment[];
  bucketMin: number;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  canEdit: boolean;
}) {
  const [selectedAppt, setSelectedAppt] = useState<Appointment | null>(null);
  const { formatTime } = useClinicSettings();

  const sorted = [...appointments].sort((a, b) => {
    const deptA = a.departments?.name ?? "";
    const deptB = b.departments?.name ?? "";
    if (deptA !== deptB) return deptA.localeCompare(deptB);
    return new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime();
  });

  const hourLabel = `${String(Math.floor(bucketMin / 60)).padStart(2, "0")}:00`;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{appointments.length} appointments at {hourLabel}</DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
            {sorted.map((appt) => {
              const time = formatTime(appt.scheduled_at);
              const deptColor = appt.departments?.color ?? "#64748b";
              return (
                <button
                  key={appt.id}
                  onClick={() => setSelectedAppt(appt)}
                  className="w-full text-left rounded-lg border border-border/40 overflow-hidden text-sm hover:bg-muted/40 transition-colors flex items-stretch gap-0"
                  style={{ borderLeftColor: deptColor, borderLeftWidth: 3 }}
                >
                  {/* Department color left accent */}
                  <div
                    className="w-0.5 shrink-0 self-stretch"
                    style={{ backgroundColor: deptColor }}
                  />
                  <div
                    className="flex flex-1 items-center gap-3 px-3 py-2"
                    style={{ backgroundColor: `color-mix(in oklab, ${deptColor} 5%, transparent)` }}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{appt.patients?.full_name ?? "—"}</div>
                      <div className="text-muted-foreground text-xs truncate">
                        {time} · {appt.duration_minutes ?? 30}min
                        {appt.profiles?.full_name ? ` · Dr. ${appt.profiles.full_name}` : ""}
                      </div>
                    </div>
                    <StatusBadge status={appt.status} />
                  </div>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

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
  const { formatTime } = useClinicSettings();
  const [deleted, setDeleted] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [isDeleting, startDelete] = useTransition();
  const [isRestoring, setIsRestoring] = useState(false);
  const isRestoringRef = useRef(false);

  const time = formatTime(appt.scheduled_at);

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
            <div className="flex flex-col gap-0.5 min-w-0">
              <StatusBadge status={appt.status} />
              <span className="text-muted-foreground truncate text-[10px]">{time}</span>
              {appt.profiles?.full_name && (
                <span className="text-muted-foreground/70 truncate text-[10px]">
                  Dr. {appt.profiles.full_name}
                </span>
              )}
              {appt.departments?.name && (
                <span
                  className="truncate rounded-sm px-1 py-px text-[9px] font-semibold uppercase tracking-wider self-start"
                  style={{
                    backgroundColor: `color-mix(in oklab, ${deptColor} 18%, transparent)`,
                    color: deptColor,
                  }}
                >
                  {deptName}
                </span>
              )}
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
