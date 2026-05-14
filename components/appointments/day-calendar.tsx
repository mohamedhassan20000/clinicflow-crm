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
import { formatDoctorName } from "@/lib/format-doctor";
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

type LayoutAppt = Appointment & { colIndex: number; colCount: number };

function computeOverlapLayout(appts: Appointment[]): LayoutAppt[] {
  if (appts.length === 0) return [];
  const sorted = [...appts].sort(
    (a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime(),
  );
  const items = sorted.map((a) => ({
    appt: a,
    start: apptStartMin(a),
    end: apptStartMin(a) + (a.duration_minutes ?? 30),
    colIndex: 0,
    colCount: 1,
  }));

  let groupStart = 0;
  let groupEndMin = items[0]!.end;
  for (let i = 1; i < items.length; i++) {
    if (items[i]!.start < groupEndMin) {
      groupEndMin = Math.max(groupEndMin, items[i]!.end);
    } else {
      assignColumns(items, groupStart, i);
      groupStart = i;
      groupEndMin = items[i]!.end;
    }
  }
  assignColumns(items, groupStart, items.length);
  return items.map(({ appt, colIndex, colCount }) => ({ ...appt, colIndex, colCount }));
}

function assignColumns(
  items: { colIndex: number; colCount: number; start: number; end: number }[],
  from: number,
  to: number,
) {
  const group = items.slice(from, to);
  const colCount = group.length;
  const freeAt: number[] = Array(colCount).fill(0);
  for (const item of group) {
    let col = 0;
    for (let c = 0; c < colCount; c++) {
      if ((freeAt[c] ?? 0) <= item.start) { col = c; break; }
    }
    item.colIndex = col;
    freeAt[col] = item.end;
  }
  const maxCol = Math.max(...group.map((g) => g.colIndex)) + 1;
  for (const item of group) item.colCount = maxCol;
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
  const gridHeightPx = ((endMin - startMin) / STEP_MIN) * ROW_PX;

  const hourLabels: number[] = [];
  for (let m = startMin; m <= endMin; m += 60) hourLabels.push(m);

  const breaks = getBreakBands(clinicHours, dow);
  const closed = isDayClosed(clinicHours, dow);
  const layoutAppts = computeOverlapLayout(sorted);

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

          {/* Time axis */}
          <div className="relative w-10 shrink-0 border-r border-border/30" style={{ height: gridHeightPx + 32 }}>
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
              {hourLabels.map((min) => (
                <div
                  key={`line-${min}`}
                  className="absolute left-0 right-0 border-t border-border/20"
                  style={{ top: ((min - startMin) / STEP_MIN) * ROW_PX }}
                />
              ))}
            </div>
          </div>

          {/* Single day column */}
          <div className="flex-1 flex flex-col">
            {/* Day header */}
            <div className="h-8 flex items-center justify-center text-xs font-medium border-b border-border/30 bg-muted/30 text-muted-foreground">
              {date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
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

              {/* Empty state */}
              {!closed && layoutAppts.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <span className="text-xs text-muted-foreground/40">No appointments</span>
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
                    <DayCard appt={appt} canEdit={canEdit} compact={height < 56} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Day grid card ─────────────────────────────────────────────────────────────

function DayCard({
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
                {appt.profiles?.full_name ? formatDoctorName(appt.profiles.full_name) : "—"}
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

// ── DayRow: list fallback (mobile) ────────────────────────────────────────────

function DayRow({ appt, canEdit }: { appt: Appointment; canEdit: boolean }) {
  const [deleted, setDeleted] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
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
