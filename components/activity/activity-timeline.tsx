"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  getActivityTimeline,
  type ActivityEventView,
} from "@/actions/activity";
import {
  activityActionMessageKey,
  activityActionTone,
  type ActivityEntityType,
  type ActivityTone,
} from "@/lib/activity/events";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { cn } from "@/lib/utils";

const TONE_DOT: Record<ActivityTone, string> = {
  neutral: "bg-muted-foreground/40",
  positive: "bg-emerald-500",
  warning: "bg-amber-500",
  negative: "bg-destructive",
};

type Props = {
  entityType?: ActivityEntityType;
  entityId?: string;
  patientId?: string;
  /** Compact mode trims the section chrome for embedding inside a dialog. */
  compact?: boolean;
};

export function ActivityTimeline({ entityType, entityId, patientId, compact }: Props) {
  const t = useTranslations("activity");
  const { formatDate, formatTime } = useClinicSettings();
  const [events, setEvents] = useState<ActivityEventView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(
    async (before?: string) => {
      const result = await getActivityTimeline({
        entityType,
        entityId,
        patientId,
        before,
      });
      return result;
    },
    [entityType, entityId, patientId],
  );

  useEffect(() => {
    let active = true;
    load()
      .then((result) => {
        if (!active) return;
        setEvents(result.events);
        setCursor(result.nextCursor);
        setFailed(false);
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [load]);

  function handleLoadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    load(cursor)
      .then((result) => {
        setEvents((prev) => [...prev, ...result.events]);
        setCursor(result.nextCursor);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoadingMore(false));
  }

  function actorLabel(event: ActivityEventView) {
    if (event.isSystem) return t("systemActor");
    return event.actorName ?? t("unknownActor");
  }

  return (
    <section className="space-y-2">
      {!compact && (
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("title")}
        </p>
      )}
      <div className="rounded-lg border border-border/50 bg-muted/30 p-3">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            {t("loading")}
          </div>
        ) : failed ? (
          <p className="text-xs text-destructive">{t("failed")}</p>
        ) : events.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <>
            <ol className="flex flex-col gap-3">
              {events.map((event) => (
                <li key={event.id} className="flex gap-2.5">
                  <span
                    aria-hidden
                    className={cn(
                      "mt-1 size-2 shrink-0 rounded-full",
                      TONE_DOT[activityActionTone(event.action)],
                    )}
                  />
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm leading-snug">
                      {t(`actions.${activityActionMessageKey(event.action)}`)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {actorLabel(event)}
                      {" · "}
                      {formatDate(event.occurredAt, {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                      {" · "}
                      {formatTime(event.occurredAt)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
            {cursor && (
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline disabled:opacity-50"
              >
                {loadingMore && (
                  <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                )}
                {t("loadMore")}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
