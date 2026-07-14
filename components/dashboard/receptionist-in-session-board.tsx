"use client";

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { CalendarClock, RefreshCcw, UserRound } from "lucide-react";
import {
  fetchReceptionInSessionBoard,
  type ReceptionInSessionGroup,
  type ReceptionInSessionItem,
} from "@/actions/receptionist-dashboard";
import { StatusBadge } from "@/components/appointments/status-badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDoctorName } from "@/lib/format-doctor";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";
import { useTranslations } from "next-intl";

function formatElapsed(startIso: string, now: number) {
  const elapsedMinutes = Math.max(
    0,
    Math.floor((now - new Date(startIso).getTime()) / 60000),
  );
  const hours = Math.floor(elapsedMinutes / 60);
  const minutes = elapsedMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function appointmentDayLink(iso: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const date = `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;

  return `/appointments?view=day&date=${date}`;
}

export function ReceptionistInSessionBoard({
  initialGroups,
}: {
  initialGroups: ReceptionInSessionGroup[];
}) {
  const t = useTranslations("dashboard");
  const [groups, setGroups] = useState(initialGroups);
  const [now, setNow] = useState(() => Date.now());
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(interval);
  }, []);

  const refreshBoard = useCallback(() => {
    startTransition(async () => {
      const next = await fetchReceptionInSessionBoard();
      setGroups(next);
      setNow(Date.now());
    });
  }, []);

  useEffect(() => {
    const refreshOnFocus = () => refreshBoard();
    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") refreshBoard();
    };

    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [refreshBoard]);

  const total = useMemo(
    () => groups.reduce((sum, group) => sum + group.items.length, 0),
    [groups],
  );

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{t("patientsInSession")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("activeSessionsAcrossDepartments", { sessions: total, departments: groups.length })}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={refreshBoard}
          disabled={isPending}
          aria-label={t("refreshInSessionBoard")}
          title={t("refreshInSessionBoard")}
        >
          <RefreshCcw className={cn("h-3.5 w-3.5", isPending && "animate-spin")} />
        </Button>
      </div>

      {total === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-card px-4 py-8 text-center">
          <CalendarClock className="mx-auto mb-2 h-6 w-6 text-muted-foreground/45" />
          <p className="text-sm text-muted-foreground">{t("noPatientsAreCurrentlyInSession")}</p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {groups.map((group) => (
            <DepartmentSessionCard key={group.departmentId ?? "unassigned"} group={group} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}

function DepartmentSessionCard({
  group,
  now,
}: {
  group: ReceptionInSessionGroup;
  now: number;
}) {
  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-4 dark:border-violet-900/50 dark:bg-violet-950/10">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="truncate text-sm font-semibold">{group.departmentName}</h3>
        <span className="rounded-full bg-background/80 px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {group.items.length}
        </span>
      </div>
      <div className="space-y-2">
        {group.items.map((item) => (
          <SessionRow key={item.id} item={item} now={now} />
        ))}
      </div>
    </div>
  );
}

function SessionRow({ item, now }: { item: ReceptionInSessionItem; now: number }) {
  const t = useTranslations("dashboard");
  const { formatTime } = useClinicSettings();
  const elapsedMinutes = Math.max(
    0,
    Math.floor((now - new Date(item.sessionStartedAt).getTime()) / 60000),
  );
  const isLongRunning = elapsedMinutes >= 60;

  return (
    <div
      className={cn(
        "rounded-lg border border-border/60 bg-background p-3",
        isLongRunning && "border-s-4 border-s-amber-500",
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={item.status} />
            <span
              className={cn(
                "text-xs font-semibold tabular-nums",
                isLongRunning ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
              )}
            >
              {formatElapsed(item.sessionStartedAt, now)}
            </span>
          </div>
          <p className="truncate text-sm font-semibold">{item.patientName}</p>
          <p className="truncate text-xs text-muted-foreground">
            {formatDoctorName(item.doctorName)} · {item.serviceName ?? t("noService")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("scheduled")}{" "}
            <span className="font-mono tabular-nums">{formatTime(item.scheduledAt)}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button asChild variant="outline" size="icon-sm" title={t("openAppointment")}>
            <Link href={appointmentDayLink(item.scheduledAt)} aria-label={t("openAppointment")}>
              <CalendarClock className="h-3.5 w-3.5" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="icon-sm" title={t("openPatient")}>
            <Link href={`/patients/${item.patientId}`} aria-label={t("openPatient")}>
              <UserRound className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
