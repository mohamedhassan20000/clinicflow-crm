"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, CalendarPlus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { HourAppointmentsDialog } from "@/components/appointments/hour-appointments-dialog";
import { DeleteConfirmDialog } from "@/components/appointments/delete-confirm-dialog";
import {
  CALENDAR_HEADER_HEIGHT_PX,
  CALENDAR_STYLES,
  CalendarNonWorkingBands,
  CalendarNowIndicator,
  getCalendarGridBounds,
  getCalendarNonWorkingBands,
  minutesInClinicTimeZone,
  useCalendarNow,
} from "@/components/appointments/calendar-visuals";
import { useTranslations } from "next-intl";

type Appointment = AppointmentForDetail;

// ── Time grid constants ────────────────────────────────────────────────────────
const BUCKET_H_PX = 420; // fixed height per hour row — fits 3 full compact cards
const CARD_H_PX   = 110; // compact card: name + badge + time + doctor + dept

// Returns the appointment's start time in minutes since midnight (Istanbul).
function apptStartMin(appt: Appointment): number {
  return minutesInClinicTimeZone(new Date(appt.scheduled_at));
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
  currentUserId?: string;
  currentUserRole?: "admin" | "receptionist" | "manager" | "doctor" | "assistant";
  clinicHours?: ClinicWorkingHoursValues;
  newAppointmentHref?: string;
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

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function dayIndexToDow(i: number, weekStart: number): number {
  return (weekStart + i) % 7;
}

// ── Main component ────────────────────────────────────────────────────────────

export function WeekCalendar({
  appointments,
  weekStart,
  canEdit,
  currentUserId,
  currentUserRole,
  clinicHours = [],
  newAppointmentHref = "/appointments/new",
}: WeekCalendarProps) {
  const t = useTranslations("appointments");
  const { formatSlotTime, formatDate, weekStart: configuredWeekStart } = useClinicSettings();
  const allDays = Array.from({ length: 7 }, (_, i) => ({
    day: addDays(weekStart, i),
    originalIndex: i,
  }));
  // Hide closed days from the week view (month view is unaffected)
  const visibleDays = allDays.filter(({ originalIndex }) => {
    const dow = dayIndexToDow(originalIndex, configuredWeekStart);
    return !isDayClosed(clinicHours, dow);
  });
  // Fall back to showing all 7 if no clinic hours are configured
  const displayDays = visibleDays.length > 0 ? visibleDays : allDays;
  const colCount = displayDays.length;
  const today = useCalendarNow();
  const nowMin = minutesInClinicTimeZone(today);

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

  const bounds = getCalendarGridBounds(clinicHours);
  const { startMin, endMin } = bounds;

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
    <div className="space-y-4" data-calendar-view="week">
      {/* Nav */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm" className="h-8 w-8 p-0">
            <Link href={`/appointments?week=${fmt(prevWeek)}`} aria-label={t("previousWeek")}>
              <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
            </Link>
          </Button>
          <span className="min-w-0 text-sm font-medium">
            {formatDate(weekStart, { day: "numeric", month: "short" })}{" "}
            —{" "}
            {formatDate(addDays(weekStart, 6), {
              day: "numeric", month: "short", year: "numeric",
            })}
          </span>
          <Button asChild variant="outline" size="sm" className="h-8 w-8 p-0">
            <Link href={`/appointments?week=${fmt(nextWeek)}`} aria-label={t("nextWeek")}>
              <ChevronRight className="h-4 w-4 rtl:rotate-180" />
            </Link>
          </Button>
        </div>
        {canEdit && (
          <Button asChild size="sm" className="shrink-0 gap-1.5">
            <Link href={newAppointmentHref}>
              <CalendarPlus className="h-4 w-4" />
              {t("newAppointment")}</Link>
          </Button>
        )}
      </div>

      {/* Grid */}
      <div className={CALENDAR_STYLES.frame} data-calendar-grid>
        <div className="flex" style={{ minWidth: `${colCount * 146}px` }}>

          {/* Time axis */}
          <div className={CALENDAR_STYLES.timeAxis}>
            {/* Spacer for day-header row */}
            <div className={CALENDAR_STYLES.timeAxisHeader} />
            {/* Hour labels — one per row, aligned with day columns */}
            {hourRows.map((hMin) => (
              <div
                key={hMin}
                className={`${CALENDAR_STYLES.hourRow} flex items-start justify-center pt-1`}
                style={{ height: BUCKET_H_PX }}
              >
                <span className={CALENDAR_STYLES.hourLabel} data-calendar-hour-label>
                  {formatSlotTime(`${String(Math.floor(hMin / 60)).padStart(2, "0")}:00`)}
                </span>
              </div>
            ))}
          </div>

          {/* Day columns */}
          <div
            className="grid flex-1 divide-x divide-calendar-grid-strong"
            style={{ gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))` }}
          >
            {displayDays.map(({ day, originalIndex }) => {
              const i = originalIndex;
              const isToday = isSameDay(day, today);
              const dayAppts = appointmentsByDate.get(localDateKey(day)) ?? [];
              const dow = dayIndexToDow(i, configuredWeekStart);
              const nonWorkingBands = getCalendarNonWorkingBands(
                clinicHours,
                dow,
                bounds,
              );
              const hourBuckets = groupByHourBucket(dayAppts);
              // Current-time indicator: only on today's column, only if now is
              // within the visible grid range.
              const showNowLine = isToday && nowMin >= startMin && nowMin <= endMin;
              const nowTopPx =
                CALENDAR_HEADER_HEIGHT_PX +
                ((nowMin - startMin) / 60) * BUCKET_H_PX;

              return (
                <div
                  key={i}
                  data-calendar-today-body={isToday ? "true" : undefined}
                  className={`relative flex flex-col ${
                    isToday ? CALENDAR_STYLES.todayBody : ""
                  }`}
                >
                  {/* Day header */}
                  <div
                    data-calendar-day-header
                    data-today={isToday ? "true" : undefined}
                    className={`${
                      isToday
                        ? CALENDAR_STYLES.todayHeader
                        : CALENDAR_STYLES.dayHeader
                    } gap-1`}
                  >
                    <span className={isToday ? "" : CALENDAR_STYLES.secondaryLabel}>{DAY_NAMES[dow]}</span>
                    <span>{day.getDate()}</span>
                  </div>

                  <CalendarNonWorkingBands
                    bands={nonWorkingBands}
                    gridStartMin={startMin}
                    hourHeightPx={BUCKET_H_PX}
                  />

                  {/* Hour bucket rows */}
                  {hourRows.map((hMin) => {
                    const appts = hourBuckets.get(hMin) ?? [];
                    return (
                      <HourBucketRow
                        key={hMin}
                        appts={appts}
                        bucketMin={hMin}
                        canEdit={canEdit}
                        currentUserId={currentUserId}
                        currentUserRole={currentUserRole}
                      />
                    );
                  })}

                  {showNowLine && (
                    <CalendarNowIndicator
                      top={nowTopPx}
                      label={t("currentTimeNamed", { time: formatSlotTime(
                        `${String(Math.floor(nowMin / 60)).padStart(2, "0")}:${String(
                          nowMin % 60,
                        ).padStart(2, "0")}`,
                      ) })}
                    />
                  )}
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
  currentUserId,
  currentUserRole,
}: {
  appts: Appointment[];
  bucketMin: number;
  canEdit: boolean;
  currentUserId?: string;
  currentUserRole?: "admin" | "receptionist" | "manager" | "doctor" | "assistant";
}) {
  const t = useTranslations("appointments");
  const [showAllOpen, setShowAllOpen] = useState(false);
  const hasMore = appts.length > MAX_VISIBLE;
  const visibleAppts = hasMore ? appts.slice(0, 3) : appts;

  return (
    <div
      className={`${CALENDAR_STYLES.hourRow} z-10 flex flex-col gap-0.5 overflow-hidden px-0.5 py-0.5`}
      style={{ height: BUCKET_H_PX }}
    >
      {visibleAppts.map((appt) => (
        <div key={appt.id} style={{ height: CARD_H_PX }} className="min-w-0 shrink-0">
          <AppointmentCard
            appt={appt}
            canEdit={canEdit}
            currentUserId={currentUserId}
            currentUserRole={currentUserRole}
            compact
          />
        </div>
      ))}
      {hasMore && (
        <button
          onClick={() => setShowAllOpen(true)}
          className="mt-auto px-1 py-0.5 text-start text-[11px] font-medium leading-none text-foreground/70 hover:text-foreground hover:underline"
        >
          {t("showAll")}{appts.length})
        </button>
      )}
      {showAllOpen && (
        <HourAppointmentsDialog
          appointments={appts}
          bucketMin={bucketMin}
          open={showAllOpen}
          onOpenChange={setShowAllOpen}
          canEdit={canEdit}
          currentUserId={currentUserId}
          currentUserRole={currentUserRole}
        />
      )}
    </div>
  );
}

// ── Appointment card ──────────────────────────────────────────────────────────

export function AppointmentCard({
  appt,
  canEdit,
  currentUserId,
  currentUserRole,
  compact = false,
}: {
  appt: Appointment;
  canEdit: boolean;
  currentUserId?: string;
  currentUserRole?: "admin" | "receptionist" | "manager" | "doctor" | "assistant";
  compact?: boolean;
}) {
  const t = useTranslations("appointments");
  const { formatTime } = useClinicSettings();
  const [deleted, setDeleted] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [isDeleting, startDelete] = useTransition();
  const [isRestoring, setIsRestoring] = useState(false);
  const isRestoringRef = useRef(false);

  const time = formatTime(appt.scheduled_at);

  const deptColor = appt.departments?.color ?? "#64748b";
  const deptName = appt.departments?.name ?? t("general");
  const patientName = appt.patients?.full_name ?? t("unknown");

  if (deleted) return null;

  function handleDelete() {
    if (isDeleting || isRestoring) return;
    startDelete(async () => {
      const res = await softDeleteAppointment(appt.id);
      if (res.error) {
        toast.error(res.error);
      } else {
        setDeleted(true);
        toast.success(t("appointmentMovedToTrashForPatient", { patient: patientName }), {
          duration: 10000,
          action: {
            label: t("undo"),
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
        aria-pressed={detailOpen}
        data-calendar-event
        onClick={() => setDetailOpen(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setDetailOpen(true); }}
        className="group relative h-full w-full cursor-pointer overflow-hidden rounded-md border text-xs transition-[filter,box-shadow] hover:brightness-[1.04] hover:ring-1 hover:ring-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary aria-pressed:ring-2 aria-pressed:ring-primary"
        style={{
          borderColor: `color-mix(in oklab, ${deptColor} 35%, transparent)`,
          backgroundColor: `color-mix(in oklab, ${deptColor} 8%, var(--card))`,
        }}
      >
        {/* Left accent bar */}
        <span
          aria-hidden
          className="absolute inset-y-0 start-0 w-1 rounded-s-sm"
          style={{ backgroundColor: deptColor }}
        />

        <div className="flex h-full min-w-0 flex-col justify-start gap-0.5 ps-2 pe-1 pt-0.5">
          <div className="flex items-start justify-between gap-1">
            <span className="font-medium text-foreground leading-tight truncate">
              {patientName}
            </span>

            {canEdit && (appt.status === "pending" || appt.status === "confirmed") && (
              <button
                onClick={(e) => { e.stopPropagation(); setConfirmOpen(true); }}
                disabled={isDeleting || isRestoring}
                className="shrink-0 p-1 opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-destructive transition-opacity"
                title={t("moveToTrash")}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>

          {!compact && (
            <>
              <div className="flex min-w-0 items-center justify-between gap-1 text-foreground/70">
                <span>{time}</span>
                <span
                  className="max-w-[70px] truncate rounded-sm border px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-foreground"
                  style={{
                    backgroundColor: `color-mix(in oklab, ${deptColor} 18%, transparent)`,
                    borderColor: `color-mix(in oklab, ${deptColor} 45%, transparent)`,
                  }}
                >
                  {deptName}
                </span>
              </div>
              <div className="truncate text-foreground/70">
                {appt.profiles?.full_name ?? "—"}
              </div>
            </>
          )}

          {compact && (
            <div className="flex flex-col gap-0.5 min-w-0">
              <StatusBadge status={appt.status} />
              <span className="truncate text-[10px] text-foreground/70">{time}</span>
              {appt.profiles?.full_name && (
                <span className="truncate text-[10px] text-foreground/70">
                  {t("dr")}{appt.profiles.full_name}
                </span>
              )}
              {appt.departments?.name && (
                <span
                  className="self-start truncate rounded-sm border px-1 py-px text-[10px] font-semibold uppercase tracking-wider text-foreground"
                  style={{
                    backgroundColor: `color-mix(in oklab, ${deptColor} 18%, transparent)`,
                    borderColor: `color-mix(in oklab, ${deptColor} 45%, transparent)`,
                  }}
                >
                  {deptName}
                </span>
              )}
            </div>
          )}

          {!compact && <StatusBadge status={appt.status} />}

          {(canEdit || currentUserRole === "doctor") && !compact && (
            <div className="pt-0.5" onClick={(e) => e.stopPropagation()}>
              <AppointmentActions
                appointmentId={appt.id}
                currentStatus={appt.status}
                patientId={appt.patient_id}
                doctorId={appt.doctor_id}
                scheduledAt={appt.scheduled_at}
                durationMinutes={appt.duration_minutes}
                currentUserId={currentUserId}
                currentUserRole={currentUserRole}
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
        currentUserId={currentUserId}
        currentUserRole={currentUserRole}
        onDeleted={() => setDeleted(true)}
      />
      <DeleteConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={handleDelete}
        disabled={isDeleting || isRestoring}
      />
    </>
  );
}
