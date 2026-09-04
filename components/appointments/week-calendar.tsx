"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, CalendarPlus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/appointments/status-badge";
import { AppointmentActions } from "@/components/appointments/appointment-actions";
import { softDeleteAppointment, restoreAppointment } from "@/actions/appointments";
import {
  AppointmentDetailDialog,
  type AppointmentForDetail,
} from "@/components/appointments/appointment-detail-dialog";
import type { ClinicWorkingHoursValues } from "@/lib/validations/settings";
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
import {
  addCalendarDays,
  calendarDateKey,
  calendarDayOfWeek,
  toCalendarEventPlacement,
} from "@/lib/appointments/calendar";
import { isOverduePending } from "@/lib/appointments/overdue-pending";
import { CALENDAR_APPOINTMENT_PARAM } from "@/lib/navigation/ai-review-targets";
import { cn } from "@/lib/utils";

type Appointment = AppointmentForDetail;

// ── Time grid constants ────────────────────────────────────────────────────────
const BUCKET_H_PX = 420; // fixed height per hour row — fits 3 full compact cards
const CARD_H_PX   = 110; // compact card: name + badge + time + doctor + dept

// Returns the appointment's start time in clinic-local minutes since midnight.
function apptStartMin(appt: Appointment, timeZone: string): number {
  return toCalendarEventPlacement(appt, timeZone).startMinutes;
}

// Groups appointments by hour bucket (floor to nearest hour).
function groupByHourBucket(
  appts: Appointment[],
  timeZone: string,
): Map<number, Appointment[]> {
  const groups = new Map<number, Appointment[]>();
  for (const appt of appts) {
    const startMin = apptStartMin(appt, timeZone);
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
  weekStart: string;
  canEdit: boolean;
  currentUserId?: string;
  currentUserRole?: "admin" | "receptionist" | "manager" | "doctor" | "assistant";
  clinicHours?: ClinicWorkingHoursValues;
  newAppointmentHref?: string;
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
  const {
    formatSlotTime,
    formatCalendarDate,
    locale,
  } = useClinicSettings();
  const allDays = Array.from({ length: 7 }, (_, i) => ({
    day: addCalendarDays(weekStart, i),
    originalIndex: i,
  }));
  // Closed-day bands remain visible, but persisted appointments must never be
  // hidden merely because working-hours configuration later changed.
  const displayDays = allDays;
  const colCount = displayDays.length;
  const today = useCalendarNow();
  const todayKey = calendarDateKey(today, locale.timeZone);
  const nowMin = minutesInClinicTimeZone(today, locale.timeZone);

  const appointmentsByDate = useMemo(() => {
    const grouped = new Map<string, Appointment[]>();
    const sorted = [...appointments].sort(
      (a, b) =>
        new Date(a.scheduled_at).getTime() -
        new Date(b.scheduled_at).getTime(),
    );
    for (const appointment of sorted) {
      const key = toCalendarEventPlacement(
        appointment,
        locale.timeZone,
      ).date;
      const dayAppointments = grouped.get(key) ?? [];
      dayAppointments.push(appointment);
      grouped.set(key, dayAppointments);
    }
    return grouped;
  }, [appointments, locale.timeZone]);

  const bounds = getCalendarGridBounds(clinicHours);
  const { startMin, endMin } = bounds;

  // One row per hour within the grid range
  const hourRows: number[] = [];
  for (let m = startMin; m < endMin; m += 60) hourRows.push(m);

  const prevWeek = addCalendarDays(weekStart, -7);
  const nextWeek = addCalendarDays(weekStart, 7);

  return (
    <div className="space-y-4" data-calendar-view="week">
      {/* Nav */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm" className="h-8 w-8 p-0">
            <Link href={`/appointments?week=${prevWeek}`} aria-label={t("previousWeek")}>
              <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
            </Link>
          </Button>
          <span className="min-w-0 text-sm font-medium">
            {formatCalendarDate(weekStart, { day: "numeric", month: "short" })}{" "}
            —{" "}
            {formatCalendarDate(addCalendarDays(weekStart, 6), {
              day: "numeric", month: "short", year: "numeric",
            })}
          </span>
          <Button asChild variant="outline" size="sm" className="h-8 w-8 p-0">
            <Link href={`/appointments?week=${nextWeek}`} aria-label={t("nextWeek")}>
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
              const isToday = day === todayKey;
              const dayAppts = appointmentsByDate.get(day) ?? [];
              const dow = calendarDayOfWeek(day);
              const nonWorkingBands = getCalendarNonWorkingBands(
                clinicHours,
                dow,
                bounds,
              );
              const hourBuckets = groupByHourBucket(
                dayAppts,
                locale.timeZone,
              );
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
                    <span className={isToday ? "" : CALENDAR_STYLES.secondaryLabel}>
                      {formatCalendarDate(day, { weekday: "short" })}
                    </span>
                    <span>{Number(day.slice(8, 10))}</span>
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
  const searchParams = useSearchParams();
  const cardRef = useRef<HTMLDivElement | null>(null);
  // One auto-open per arrival, for the same reason the intake table latches its
  // scroll: any later render that touches the search params would otherwise
  // reopen a dialog the staff member has just closed.
  const deepLinkedRef = useRef(false);

  /**
   * P10 — arriving from the dashboard's "AI appointments awaiting confirmation"
   * card, which links straight to one appointment.
   *
   * The card is rendered by the calendar for the day the link pins, so by the
   * time this runs the target either exists on screen or is not in range at
   * all — in which case nothing happens, which is the correct outcome for a
   * stale link to an appointment that has since been moved or confirmed.
   */
  useEffect(() => {
    if (deepLinkedRef.current) return;
    if (searchParams.get(CALENDAR_APPOINTMENT_PARAM) !== appt.id) return;
    deepLinkedRef.current = true;
    // Opened on the next frame rather than inside the effect: the card has to
    // be scrolled into view first, and a dialog that mounts in the same commit
    // as the scroll cancels it. The frame boundary also keeps this out of the
    // render pass that scheduled it.
    const frame = requestAnimationFrame(() => {
      cardRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      setDetailOpen(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [appt.id, searchParams]);

  const time = formatTime(appt.scheduled_at);
  const overduePending = isOverduePending(appt);

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
        ref={cardRef}
        role="button"
        tabIndex={0}
        aria-pressed={detailOpen}
        data-calendar-event
        data-appointment-id={appt.id}
        onClick={() => setDetailOpen(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setDetailOpen(true); }}
        data-overdue-pending={overduePending ? "true" : undefined}
        className={cn(
          "group relative h-full w-full cursor-pointer overflow-hidden rounded-md border text-xs transition-[filter,box-shadow] hover:brightness-[1.04] hover:ring-1 hover:ring-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary aria-pressed:ring-2 aria-pressed:ring-primary",
          overduePending && "ring-1 ring-amber-500/70",
        )}
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
              {overduePending ? (
                <Badge variant="outline" className="self-start border-amber-500/50 bg-amber-500/10 text-[10px] text-amber-800 dark:text-amber-200">
                  {t("overduePending")}
                </Badge>
              ) : (
                <StatusBadge status={appt.status} />
              )}
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

          {!compact && (
            overduePending ? (
              <Badge variant="outline" className="border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-200">
                {t("overduePending")}
              </Badge>
            ) : (
              <StatusBadge status={appt.status} />
            )
          )}

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
                overduePending={overduePending}
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
