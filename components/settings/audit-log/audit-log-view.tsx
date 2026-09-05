"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import {
  ArrowRight,
  Bot,
  Loader2,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { getAuditLog, type AuditLogActor, type AuditLogFilters } from "@/actions/audit-log";
import {
  AUDIT_MODULES,
  auditActionMessageKey,
  type AuditModule,
  type AuditTone,
} from "@/lib/audit/events";
import { auditChangeLines, auditDetailLines } from "@/lib/audit/describe";
import type { AuditFeedEvent } from "@/lib/audit/feed";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { useClinicSettings } from "@/contexts/clinic-settings-context";
import { cn } from "@/lib/utils";
import { AuditValueText } from "@/components/settings/audit-log/audit-value";

const TONE_DOT: Record<AuditTone, string> = {
  neutral: "bg-muted-foreground/40",
  positive: "bg-emerald-500",
  warning: "bg-amber-500",
  negative: "bg-destructive",
};

const ANY = "__any__";

type Props = {
  initialEvents: AuditFeedEvent[];
  initialCursor: string | null;
  actors: AuditLogActor[];
  /** Managers cannot open the AI provider screen and do not read its history. */
  canReadAi: boolean;
};

/**
 * P18 — the Audit Log.
 *
 * Filters are applied server-side and the list is cursor-paginated: the whole
 * history never reaches the browser, which matters because this is the one
 * screen whose table only ever grows. Every row is a sentence first; the raw
 * structured diff lives one click away, for the reader who needs to be certain
 * rather than informed.
 */
export function AuditLogView({ initialEvents, initialCursor, actors, canReadAi }: Props) {
  const t = useTranslations("auditLog");
  const { formatDateTime } = useClinicSettings();

  const [events, setEvents] = useState(initialEvents);
  const [cursor, setCursor] = useState(initialCursor);
  const [selected, setSelected] = useState<AuditFeedEvent | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  const [module, setModule] = useState<string>(ANY);
  const [actorId, setActorId] = useState<string>(ANY);
  const [outcome, setOutcome] = useState<string>(ANY);
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [applied, setApplied] = useState<AuditLogFilters>({});

  const modules = useMemo(
    () => AUDIT_MODULES.filter((value) => canReadAi || value !== "ai"),
    [canReadAi],
  );

  const currentFilters = useCallback((): AuditLogFilters => {
    return {
      ...(module !== ANY ? { module: module as AuditModule } : {}),
      ...(actorId !== ANY ? { actorId } : {}),
      ...(outcome !== ANY ? { outcome: outcome as "success" | "failure" } : {}),
      ...(search.trim() ? { search: search.trim() } : {}),
      // A date filter is inclusive of both ends of the chosen days.
      ...(from ? { from: `${from}T00:00:00.000Z` } : {}),
      ...(to ? { to: `${to}T23:59:59.999Z` } : {}),
    };
  }, [module, actorId, outcome, search, from, to]);

  const hasFilters =
    module !== ANY || actorId !== ANY || outcome !== ANY || !!search.trim() || !!from || !!to;

  function runSearch() {
    const filters = currentFilters();
    setApplied(filters);
    setFailed(false);
    startTransition(async () => {
      try {
        const page = await getAuditLog(filters);
        setEvents(page.events);
        setCursor(page.nextCursor);
      } catch {
        setFailed(true);
      }
    });
  }

  function reset() {
    setModule(ANY);
    setActorId(ANY);
    setOutcome(ANY);
    setSearch("");
    setFrom("");
    setTo("");
    setApplied({});
    setFailed(false);
    startTransition(async () => {
      try {
        const page = await getAuditLog({});
        setEvents(page.events);
        setCursor(page.nextCursor);
      } catch {
        setFailed(true);
      }
    });
  }

  function loadMore() {
    if (!cursor) return;
    startTransition(async () => {
      try {
        const page = await getAuditLog({ ...applied, cursor });
        setEvents((current) => [...current, ...page.events]);
        setCursor(page.nextCursor);
      } catch {
        setFailed(true);
      }
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-xl border border-border/50 p-3 sm:p-4">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Select value={module} onValueChange={setModule}>
            <SelectTrigger aria-label={t("filterModule")}>
              <SelectValue placeholder={t("filterModule")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t("filterAllModules")}</SelectItem>
              {modules.map((value) => (
                <SelectItem key={value} value={value}>
                  {moduleLabel(t, value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={actorId} onValueChange={setActorId}>
            <SelectTrigger aria-label={t("filterActor")}>
              <SelectValue placeholder={t("filterActor")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t("filterAllActors")}</SelectItem>
              {actors.map((actor) => (
                <SelectItem key={actor.id} value={actor.id}>
                  {actor.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={outcome} onValueChange={setOutcome}>
            <SelectTrigger aria-label={t("filterOutcome")}>
              <SelectValue placeholder={t("filterOutcome")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t("filterAnyOutcome")}</SelectItem>
              <SelectItem value="success">{t("outcomeSuccess")}</SelectItem>
              <SelectItem value="failure">{t("outcomeFailure")}</SelectItem>
            </SelectContent>
          </Select>

          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") runSearch();
              }}
              placeholder={t("filterSearch")}
              aria-label={t("filterSearch")}
              className="ps-9"
            />
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            aria-label={t("filterFrom")}
          />
          <Input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            aria-label={t("filterTo")}
          />
          <div className="flex gap-2 lg:col-span-2">
            <Button onClick={runSearch} disabled={pending} className="flex-1 sm:flex-none">
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("apply")}
            </Button>
            {hasFilters ? (
              <Button variant="ghost" onClick={reset} disabled={pending}>
                <X className="size-4" />
                {t("clear")}
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {failed ? (
        <p className="rounded-xl border border-border/50 p-8 text-center text-sm text-muted-foreground">
          {t("failed")}
        </p>
      ) : events.length === 0 ? (
        <p className="rounded-xl border border-border/50 p-10 text-center text-sm text-muted-foreground">
          {hasFilters ? t("emptyFiltered") : t("empty")}
        </p>
      ) : (
        <ul className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/50">
          {events.map((event) => (
            <li key={`${event.trail}-${event.id}`}>
              <button
                type="button"
                onClick={() => setSelected(event)}
                className="flex w-full items-start gap-3 px-3 py-3 text-start transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4"
              >
                <span
                  aria-hidden
                  className={cn("mt-2 size-2 shrink-0 rounded-full", TONE_DOT[event.tone])}
                />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-sm font-medium">
                      {actionLabel(t, event.action)}
                    </span>
                    {event.entityRef ? (
                      <span className="truncate text-sm text-muted-foreground">
                        {event.entityRef}
                      </span>
                    ) : null}
                    <Badge variant="secondary" className="text-[10px] font-normal">
                      {moduleLabel(t, event.module)}
                    </Badge>
                    {event.outcome === "failure" ? (
                      <Badge variant="destructive" className="text-[10px] font-normal">
                        {t("outcomeFailure")}
                      </Badge>
                    ) : null}
                  </span>

                  <AuditSummaryLine event={event} />

                  <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <ActorLabel event={event} />
                    <span aria-hidden>·</span>
                    <time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt)}</time>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {cursor ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("loadMore")}
          </Button>
        </div>
      ) : null}

      <AuditDetailSheet event={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

/**
 * The action and field vocabularies are open-ended by design: the database can
 * emit an action a future release adds before the message catalog learns its
 * name. Falling back to the raw identifier keeps such an event visible and
 * legible rather than crashing the page the moment it appears.
 */
type Translator = ReturnType<typeof useTranslations<"auditLog">>;

function actionLabel(t: Translator, action: string): string {
  const key = `actions.${auditActionMessageKey(action)}` as Parameters<Translator>[0];
  return t.has(key) ? t(key) : action;
}

function fieldLabel(t: Translator, field: string): string {
  const key = `fields.${field}` as Parameters<Translator>[0];
  return t.has(key) ? t(key) : field;
}

function moduleLabel(t: Translator, module: string): string {
  const key = `modules.${module}` as Parameters<Translator>[0];
  return t.has(key) ? t(key) : module;
}

function surfaceLabel(t: Translator, surface: string): string {
  const key = `surfaces.${surface}` as Parameters<Translator>[0];
  return t.has(key) ? t(key) : surface;
}

function ActorLabel({ event }: { event: AuditFeedEvent }) {
  const t = useTranslations("auditLog");
  const name =
    event.actorType === "staff"
      ? event.actorName ?? t("actorUnknown")
      : event.actorType === "integration"
        ? t("actorIntegration")
        : t("actorSystem");

  return (
    <span className="inline-flex items-center gap-1">
      {event.actorType === "staff" ? null : (
        <ShieldCheck aria-hidden className="size-3" />
      )}
      <span>{name}</span>
      {event.viaAi ? (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Sparkles aria-hidden className="size-3" />
          {t("viaAi")}
        </span>
      ) : null}
    </span>
  );
}

function AuditSummaryLine({ event }: { event: AuditFeedEvent }) {
  const t = useTranslations("auditLog");
  const lines = auditChangeLines(event, 2);
  if (lines.length === 0) return null;

  return (
    <span className="flex flex-col gap-0.5">
      {lines.map((line) => (
        <span
          key={line.field}
          className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground"
        >
          <span className="text-xs uppercase tracking-wide text-muted-foreground/70">
            {fieldLabel(t, line.field)}
          </span>
          <AuditValueText value={line.before} />
          <ArrowRight aria-hidden className="size-3 shrink-0 rtl:rotate-180" />
          <span className="font-medium text-foreground">
            <AuditValueText value={line.after} />
          </span>
        </span>
      ))}
    </span>
  );
}

function AuditDetailSheet({
  event,
  onClose,
}: {
  event: AuditFeedEvent | null;
  onClose: () => void;
}) {
  const t = useTranslations("auditLog");
  const { formatDateTime } = useClinicSettings();
  const lines = event ? auditDetailLines(event) : [];

  return (
    <Sheet open={!!event} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {event ? (
          <>
            <SheetHeader>
              <SheetTitle>
                {actionLabel(t, event.action)}
              </SheetTitle>
            </SheetHeader>

            <div className="space-y-4 px-4 pb-6 text-sm">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                <Detail label={t("detailWhen")}>{formatDateTime(event.occurredAt)}</Detail>
                <Detail label={t("detailWho")}>
                  <ActorLabel event={event} />
                </Detail>
                {event.actorRole ? (
                  <Detail label={t("detailRole")}>{event.actorRole}</Detail>
                ) : null}
                <Detail label={t("detailModule")}>{moduleLabel(t, event.module)}</Detail>
                <Detail label={t("detailEntity")}>
                  {event.entityRef ?? event.entityId ?? "—"}
                </Detail>
                <Detail label={t("detailSurface")}>
                  {surfaceLabel(t, event.surface)}
                </Detail>
                <Detail label={t("detailOutcome")}>
                  {event.outcome === "failure" ? t("outcomeFailure") : t("outcomeSuccess")}
                </Detail>
                {event.correlationId ? (
                  <Detail label={t("detailCorrelation")}>
                    <span className="font-mono text-xs break-all">{event.correlationId}</span>
                  </Detail>
                ) : null}
              </dl>

              {lines.length > 0 ? (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {t("detailChanges")}
                    </h3>
                    <ul className="space-y-2">
                      {lines.map((line) => (
                        <li key={line.field} className="rounded-lg border border-border/50 p-2">
                          <p className="text-xs uppercase tracking-wide text-muted-foreground">
                            {fieldLabel(t, line.field)}
                          </p>
                          <p className="flex flex-wrap items-center gap-1.5">
                            <AuditValueText value={line.before} />
                            <ArrowRight aria-hidden className="size-3 rtl:rotate-180" />
                            <span className="font-medium">
                              <AuditValueText value={line.after} />
                            </span>
                          </p>
                          {line.after.kind === "list" && line.after.items.length > 0 ? (
                            <ul className="mt-1 space-y-0.5 font-mono text-xs text-muted-foreground">
                              {line.after.items.map((item) => (
                                <li key={item}>{item}</li>
                              ))}
                            </ul>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              ) : null}

              <p className="flex items-start gap-2 rounded-lg bg-muted/40 p-2 text-xs text-muted-foreground">
                <Bot aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                {t("privacyNote")}
              </p>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}
