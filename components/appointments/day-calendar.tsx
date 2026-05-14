"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
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
import { formatDoctorName } from "@/lib/format-doctor";
import {
  AppointmentDetailDialog,
  type AppointmentForDetail,
} from "@/components/appointments/appointment-detail-dialog";
import type { ClinicWorkingHoursValues } from "@/lib/validations/settings";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { HourAppointmentsDialog } from "@/components/appointments/hour-appointments-dialog";

type Appointment = AppointmentForDetail;

// ── Time grid constants ────────────────────────────────────────────────────────
const BUCKET_H_PX = 380; // fixed height per hour row
const CARD_H_PX   = 110; // appointment card height inside bucket

// Responsive: how many cards to show before "Show all" in the day time grid.
function useVisibleCount(): number {
  const [count, setCount] = useState(5);
  useEffect(() => {
    function update() {
      if (window.innerWidth >= 1280) setCount(8);
      else if (window.innerWidth >= 768) setCount(5);
      else setCount(2);
    }
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return count;
}

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

interface GridBounds {
  startMin: number;
  endMin: number;
}

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
  const hasAnyConfig = clinicHours.some((d) => d.open);
  if (!hasAnyConfig) return false;
  const day = clinicHours.find((d) => d.day_of_week === dow);
  return !day?.open;
}

// Groups appointments by hour bucket using Math.floor so 09:45 → 09:00 bucket.
function groupByHourBucket(appts: Appointment[]): Map<number, Appointment[]> {
  const groups = new Map<number, Appointment[]>();
  for (const appt of appts) {
    const startMin = apptStartMin(appt);
    const bucket = Math.floor(startMin / 60) * 60;
    const existing = groups.get(bucket) ?? [];
    existing.push(appt);
    groups.set(bucket, existing);
  }
  for (const [key, list] of groups) {
    groups.set(key, [...list].sort(
      (a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime(),
    ));
  }
  return groups;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// JS getDay(): 0=Sun…6=Sat
function dateToDow(d: Date): number {
  return d.getDay();
}

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
  const visibleCount = useVisibleCount();
  const prev = addDays(date, -1);
  const next = addDays(date, 1);
  const dow = dateToDow(date);

  const sorted = useMemo(
    () =>
      [...appointments].sort(
        (a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime(),
      ),
    [appointments],
  );

  const { startMin, endMin } = getGridBounds(clinicHours);

  // One row per hour within the grid range
  const hourRows: number[] = [];
  for (let m = startMin; m < endMin; m += 60) hourRows.push(m);

  const breaks = getBreakBands(clinicHours, dow);
  const closed = isDayClosed(clinicHours, dow);
  const hourBuckets = groupByHourBucket(sorted);

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

      {/* Mobile: list fallback */}
      <div className="sm:hidden">
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

      {/* Desktop: time grid */}
      <div className="hidden sm:block overflow-x-auto rounded-xl border border-border/40 bg-card/40">
        <div className="flex" style={{ minWidth: 360 }}>

          {/* Time axis — one label per hour row */}
          <div className="w-10 shrink-0 border-r border-border/30">
            <div className="h-8 border-b border-border/30" />
            {hourRows.map((hMin) => (
              <div
                key={hMin}
                className="border-b border-border/20 flex items-start justify-end pr-1 pt-0.5"
                style={{ height: BUCKET_H_PX }}
              >
                <span className="text-[9px] text-muted-foreground/50 leading-none">
                  {formatSlotTime(`${String(Math.floor(hMin / 60)).padStart(2, "0")}:00`)}
                </span>
              </div>
            ))}
          </div>

          {/* Single day column */}
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
                    <DayHourBucketRow
                      key={hMin}
                      appts={appts}
                      bucketMin={hMin}
                      visibleCount={visibleCount}
                      canEdit={canEdit}
                    />
                  );
                })}
                {sorted.length === 0 && (
                  <div
                    className="flex items-center justify-center"
                    style={{ height: hourRows.length * BUCKET_H_PX }}
                  >
                    <span className="text-xs text-muted-foreground/40">No appointments</span>
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

// ── Hour bucket row (desktop grid) ───────────────────────────────────────────

function DayHourBucketRow({
  appts,
  bucketMin,
  visibleCount,
  canEdit,
}: {
  appts: Appointment[];
  bucketMin: number;
  visibleCount: number;
  canEdit: boolean;
}) {
  const [showAllOpen, setShowAllOpen] = useState(false);
  const hasMore = appts.length > visibleCount;
  const visible = hasMore ? appts.slice(0, visibleCount) : appts;

  return (
    <div
      className="relative border-b border-border/20 flex flex-col gap-0.5 px-0.5 py-0.5 overflow-hidden"
      style={{ height: BUCKET_H_PX }}
    >
      <div className="flex gap-0.5 flex-1 min-h-0 overflow-hidden">
        {visible.map((appt) => (
          <div key={appt.id} style={{ height: CARD_H_PX }} className="min-w-0 flex-1 shrink-0">
            <DayCard appt={appt} canEdit={canEdit} />
          </div>
        ))}
      </div>
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

// ── Day grid card ─────────────────────────────────────────────────────────────

function DayCard({
  appt,
  canEdit,
}: {
  appt: Appointment;
  canEdit: boolean;
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
            {canEdit && (
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

          <div className="flex flex-col gap-0.5 min-w-0">
            <StatusBadge status={appt.status} />
            <span className="text-muted-foreground truncate text-[10px]">{time}</span>
            {appt.profiles?.full_name && (
              <span className="text-muted-foreground/70 truncate text-[10px]">
                Dr. {formatDoctorName(appt.profiles.full_name)}
              </span>
            )}
            <span
              className="truncate rounded-sm px-1 py-px text-[9px] font-semibold uppercase tracking-wider self-start"
              style={{
                backgroundColor: `color-mix(in oklab, ${deptColor} 18%, transparent)`,
                color: deptColor,
              }}
            >
              {deptName}
            </span>
          </div>

          {canEdit && (
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

// ── DayRow: list fallback (mobile) ────────────────────────────────────────────

function DayRow({ appt, canEdit }: { appt: Appointment; canEdit: boolean }) {
  const { formatTime } = useClinicSettings();
  const [deleted, setDeleted] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [isDeleting, startDelete] = useTransition();

  const time = formatTime(appt.scheduled_at);
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
        toast.success(`Appointment for ${patientName} moved to trash.`, {
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
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setDetailOpen(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setDetailOpen(true); }}
        className="flex flex-wrap items-start gap-3 px-3 py-3 sm:gap-4 sm:px-4 cursor-pointer hover:brightness-[0.97] transition-[filter]"
        style={{ backgroundColor: `color-mix(in oklab, ${deptColor} 4%, transparent)` }}
      >
        <div className="flex min-w-[58px] flex-col sm:min-w-[70px]">
          <span className="font-mono text-base font-semibold tabular-nums">{time}</span>
        </div>
        <span aria-hidden className="h-10 w-1 shrink-0 rounded-full" style={{ backgroundColor: deptColor }} />
        <div className="min-w-0 flex-[1_1_220px] space-y-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 truncate font-medium text-foreground">{patientName}</span>
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
            {appt.profiles?.full_name ? formatDoctorName(appt.profiles.full_name) : "Unassigned"}
          </div>
          {appt.notes && (
            <p className="line-clamp-2 max-w-2xl rounded bg-muted/40 px-2 py-1 text-xs leading-snug text-muted-foreground">
              {appt.notes}
            </p>
          )}
        </div>
        <div
          className="ml-auto flex w-full shrink-0 flex-wrap items-center justify-start gap-2 sm:w-auto sm:justify-end"
          onClick={(e) => e.stopPropagation()}
        >
          <StatusBadge status={appt.status} />
          {canEdit && (
            <>
              <AppointmentActions
                appointmentId={appt.id}
                currentStatus={appt.status}
                hasInsurance={Boolean(appt.insurance_provider_id)}
              />
              <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground/50 hover:text-destructive"
                  onClick={(e) => { e.stopPropagation(); setConfirmOpen(true); }}
                  disabled={isDeleting}
                  title="Move appointment to trash"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Move appointment to trash?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The appointment for <strong>{patientName}</strong> will be moved to the recycle bin and can be restored within 30 days.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      disabled={isDeleting}
                      onClick={(e) => {
                        e.preventDefault();
                        setConfirmOpen(false);
                        handleDelete();
                      }}
                    >
                      Move to trash
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
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
