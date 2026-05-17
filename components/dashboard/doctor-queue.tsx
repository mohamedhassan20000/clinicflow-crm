"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { ExternalLink, RefreshCcw, Volume2, VolumeX } from "lucide-react";
import {
  fetchDoctorDashboardQueue,
  type DoctorDashboardQueue,
  type DoctorQueueItem,
} from "@/actions/doctor-dashboard";
import { StatusBadge } from "@/components/appointments/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const EMPTY_QUEUE: DoctorDashboardQueue = {
  inSession: [],
  arrived: [],
  confirmedToday: [],
  confirmedTomorrow: [],
};

function formatTime(iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Europe/Istanbul",
  }).format(new Date(iso));
}

function useArrivalChime() {
  const [enabled, setEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("doctor-arrival-chime-enabled") === "true";
  });
  const audioContextRef = useRef<AudioContext | null>(null);
  const userInteractedRef = useRef(false);
  const enabledRef = useRef(false);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    window.localStorage.setItem("doctor-arrival-chime-enabled", String(enabled));
  }, [enabled]);

  useEffect(() => {
    const handleInteraction = () => {
      userInteractedRef.current = true;
    };

    window.addEventListener("pointerdown", handleInteraction, { once: true });
    window.addEventListener("keydown", handleInteraction, { once: true });
    return () => {
      window.removeEventListener("pointerdown", handleInteraction);
      window.removeEventListener("keydown", handleInteraction);
    };
  }, []);

  const play = useCallback(() => {
    if (!enabledRef.current || !userInteractedRef.current) return;
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;

    try {
      const ctx = audioContextRef.current ?? new AudioContextCtor();
      audioContextRef.current = ctx;

      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(660, ctx.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.035, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.24);
    } catch {
      // Browser audio policies can block playback; queue rendering should never care.
    }
  }, []);

  return { enabled, setEnabled, play };
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

export function DoctorQueue() {
  const [queue, setQueue] = useState<DoctorDashboardQueue>(EMPTY_QUEUE);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isPending, startTransition] = useTransition();
  const previousArrivedIdsRef = useRef<Set<string> | null>(null);
  const { enabled, setEnabled, play } = useArrivalChime();

  const refreshQueue = useCallback(() => {
    startTransition(async () => {
      const next = await fetchDoctorDashboardQueue();
      const nextArrivedIds = new Set(next.arrived.map((item) => item.id));
      const previousArrivedIds = previousArrivedIdsRef.current;

      if (previousArrivedIds) {
        const hasNewArrival = next.arrived.some((item) => !previousArrivedIds.has(item.id));
        if (hasNewArrival) play();
      }

      previousArrivedIdsRef.current = nextArrivedIds;
      setQueue(next);
      setHasLoaded(true);
    });
  }, [play]);

  useEffect(() => {
    refreshQueue();
  }, [refreshQueue]);

  useEffect(() => {
    const refreshOnFocus = () => refreshQueue();
    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") refreshQueue();
    };

    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnVisible);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [refreshQueue]);

  const total = useMemo(
    () =>
      queue.inSession.length +
      queue.arrived.length +
      queue.confirmedToday.length +
      queue.confirmedTomorrow.length,
    [queue],
  );

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">My Queue</h2>
          <p className="text-xs text-muted-foreground">
            {hasLoaded ? `${total} active appointment${total === 1 ? "" : "s"}` : "Loading queue..."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant={enabled ? "secondary" : "outline"}
            size="sm"
            aria-pressed={enabled}
            onClick={() => setEnabled((value) => !value)}
          >
            {enabled ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
            Arrival sound
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            onClick={refreshQueue}
            disabled={isPending}
            aria-label="Refresh queue"
            title="Refresh queue"
          >
            <RefreshCcw className={cn("h-3.5 w-3.5", isPending && "animate-spin")} />
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <QueueCard
            title="In Session"
            items={queue.inSession}
            loading={!hasLoaded}
            variant="inSession"
          />
          <QueueCard
            title="Arrived"
            items={queue.arrived}
            loading={!hasLoaded}
            variant="arrived"
          />
          <QueueCard
            title="Confirmed Today"
            items={queue.confirmedToday}
            loading={!hasLoaded}
          />
        </div>
        <QueueCard
          title="Tomorrow Confirmed"
          items={queue.confirmedTomorrow}
          loading={!hasLoaded}
        />
      </div>
    </section>
  );
}

function QueueCard({
  title,
  items,
  loading,
  variant = "default",
}: {
  title: string;
  items: DoctorQueueItem[];
  loading: boolean;
  variant?: "default" | "arrived" | "inSession";
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border/50 bg-card p-4",
        variant === "arrived" && "border-sky-200 bg-sky-50/40 dark:border-sky-900/50 dark:bg-sky-950/10",
        variant === "inSession" &&
          "border-violet-200 bg-violet-50/50 dark:border-violet-900/50 dark:bg-violet-950/10",
      )}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {items.length}
        </span>
      </div>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border/70 px-3 py-5 text-center text-sm text-muted-foreground">
          No appointments
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <QueueRow key={item.id} item={item} highlighted={variant === "inSession"} />
          ))}
        </div>
      )}
    </div>
  );
}

function QueueRow({ item, highlighted }: { item: DoctorQueueItem; highlighted: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border/60 bg-background p-3 sm:flex-row sm:items-center sm:justify-between",
        highlighted && "border-l-4 border-l-violet-500",
      )}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold tabular-nums">{formatTime(item.scheduledAt)}</span>
          <StatusBadge status={item.status} />
        </div>
        <p className="truncate text-sm font-medium">{item.patientName}</p>
        <p className="truncate text-xs text-muted-foreground">
          {item.serviceName ?? "No service"}
          {item.departmentName ? ` · ${item.departmentName}` : ""}
        </p>
      </div>
      <Button asChild variant="outline" size="sm" className="self-start sm:self-center">
        <Link href={`/patients/${item.patientId}`}>
          Open patient
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </Button>
    </div>
  );
}
