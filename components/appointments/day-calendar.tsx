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

// ── Time grid constants (must match week-calendar) ────────────────────────────
const BUCKET_H_PX = 420;
const CARD_H_PX   = 110;

function apptStartMin(appt: Appointment): number {
  return minutesInClinicTimeZone(new Date(appt.scheduled_at));
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

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// ── Main component ────────────────────────────────────────────────────────────

interface Props {
  appointments: Appointment[];
  date: Date;
  canEdit: boolean;
  currentUserId?: string;
  currentUserRole?: "admin" | "receptionist" | "manager" | "doctor";
  clinicHours?: ClinicWorkingHoursValues;
  newAppointmentHref?: string;
}

export function DayCalendar({
  appointments,
  date,
  canEdit,
  currentUserId,
  currentUserRole,
  clinicHours = [],
  newAppointmentHref = "/appointments/new",
}: Props) {
  const t = useTranslations("appointments");
  const { formatSlotTime, formatDate } = useClinicSettings();
  const currentDate = useCalendarNow();

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

  const bounds = getCalendarGridBounds(clinicHours);
  const { startMin, endMin } = bounds;
  const hourRows: number[] = [];
  for (let m = startMin; m < endMin; m += 60) hourRows.push(m);

  const closed      = isDayClosed(clinicHours, dow);
  const nonWorkingBands = getCalendarNonWorkingBands(clinicHours, dow, bounds);
  const hourBuckets = groupByHourBucket(sorted);
  const isToday     = isSameDay(date, currentDate);
  const nowMin      = minutesInClinicTimeZone(currentDate);
  const showNowLine = isToday && !closed && nowMin >= startMin && nowMin <= endMin;
  const nowTopPx    = CALENDAR_HEADER_HEIGHT_PX + ((nowMin - startMin) / 60) * BUCKET_H_PX;

  return (
    <div className="space-y-4" data-calendar-view="day">
      {/* Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm" className="h-8 w-8 p-0">
            <Link href={`/appointments?view=day&date=${fmt(prev)}`} aria-label={t("previousDay")}>
              <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
            </Link>
          </Button>
          <span className="min-w-0 text-sm font-medium">
            {formatDate(date, {
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </span>
          <Button asChild variant="outline" size="sm" className="h-8 w-8 p-0">
            <Link href={`/appointments?view=day&date=${fmt(next)}`} aria-label={t("nextDay")}>
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

      {/* Time grid — same bucket layout as week view */}
      <div className={CALENDAR_STYLES.frame} data-calendar-grid>
        <div className="flex" style={{ minWidth: 320 }}>

          {/* Time axis */}
          <div className={CALENDAR_STYLES.timeAxis}>
            <div className={CALENDAR_STYLES.timeAxisHeader} />
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

          {/* Day column */}
          <div
            data-calendar-today-body={isToday && !closed ? "true" : undefined}
            className={`relative flex flex-1 flex-col ${
              isToday && !closed ? CALENDAR_STYLES.todayBody : ""
            }`}
          >
            {/* Day header */}
            <div
              data-calendar-day-header
              data-today={isToday ? "true" : undefined}
              className={
                isToday ? CALENDAR_STYLES.todayHeader : CALENDAR_STYLES.dayHeader
              }
            >
              {formatDate(date, { weekday: "short", day: "numeric", month: "short" })}
            </div>

            {closed ? (
              <div
                data-calendar-non-working="closed"
                className="calendar-non-working-band flex items-center justify-center"
                style={{ height: hourRows.length * BUCKET_H_PX }}
              >
                <span className={CALENDAR_STYLES.nonWorkingLabel}>
                  {t("closed")}</span>
              </div>
            ) : (
              <>
                <CalendarNonWorkingBands
                  bands={nonWorkingBands}
                  gridStartMin={startMin}
                  hourHeightPx={BUCKET_H_PX}
                />

                {hourRows.map((hMin) => {
                  const appts = hourBuckets.get(hMin) ?? [];
                  return (
                    <DayBucketCell
                      key={hMin}
                      appts={appts}
                      bucketMin={hMin}
                      canEdit={canEdit}
                      currentUserId={currentUserId}
                      currentUserRole={currentUserRole}
                    />
                  );
                })}

                {sorted.length === 0 && (
                  <div
                    className="pointer-events-none absolute inset-x-0 z-10 flex items-center justify-center"
                    style={{ top: CALENDAR_HEADER_HEIGHT_PX, height: hourRows.length * BUCKET_H_PX }}
                  >
                    <span className="text-xs text-foreground/70">
                      {t("noAppointmentsScheduledForThisDay")}</span>
                  </div>
                )}
              </>
            )}

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
  currentUserId,
  currentUserRole,
}: {
  appts: Appointment[];
  bucketMin: number;
  canEdit: boolean;
  currentUserId?: string;
  currentUserRole?: "admin" | "receptionist" | "manager" | "doctor";
}) {
  const t = useTranslations("appointments");
  const [showAllOpen, setShowAllOpen] = useState(false);
  const hasMore = appts.length > 3;
  const visible = hasMore ? appts.slice(0, 3) : appts;

  return (
    <div
      className={`${CALENDAR_STYLES.hourRow} z-10 flex flex-col gap-0.5 overflow-hidden px-0.5 py-0.5`}
      style={{ height: BUCKET_H_PX }}
    >
      {visible.map((appt) => (
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
          className="mt-auto shrink-0 px-1 py-0.5 text-start text-[11px] font-medium leading-none text-foreground/70 hover:text-foreground hover:underline"
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

// Keep AppointmentDetailDialog available for type re-export if needed
export type { AppointmentForDetail };
void AppointmentDetailDialog;
