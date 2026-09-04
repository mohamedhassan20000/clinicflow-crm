"use client";

import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  ClipboardCheck,
  ExternalLink,
  FileCheck2,
  HeartPulse,
  History,
  Loader2,
  MessageCircleMore,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Signal,
  TestTube2,
  Webhook,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { runWhatsAppHealthAction } from "@/actions/messaging-health";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  WhatsAppHealthAction,
  WhatsAppHealthSnapshot,
  WhatsAppHealthTimelineEvent,
} from "@/lib/messaging/health";
import { cn } from "@/lib/utils";

type Props = {
  snapshot: WhatsAppHealthSnapshot;
  entitled: boolean;
};

const ACTIONS: Array<{
  action: WhatsAppHealthAction;
  title: string;
  description: string;
  icon: typeof RefreshCw;
  metaOnly?: boolean;
}> = [
  {
    action: "refresh_status",
    title: "healthRefreshStatus",
    description: "healthRefreshStatusDescription",
    icon: RefreshCw,
    metaOnly: true,
  },
  {
    action: "sync_templates",
    title: "healthSyncTemplates",
    description: "healthSyncTemplatesDescription",
    icon: RotateCw,
  },
  {
    action: "repair_webhook",
    title: "healthRepairWebhook",
    description: "healthRepairWebhookDescription",
    icon: Webhook,
  },
  {
    action: "test_connectivity",
    title: "healthTestConnectivity",
    description: "healthTestConnectivityDescription",
    icon: TestTube2,
  },
];

function pretty(value: string | null): string {
  return value ? value.replaceAll("_", " ").toLowerCase() : "—";
}

/**
 * Every recovery action in the registry drives a Cloud API credential — a
 * template sync, a webhook registration, a credentialed provider probe. A
 * linked device has none of them, so the whole panel is reported as not
 * applicable rather than offered and then refused by the server.
 */
function isCloudApiProvider(
  provider: WhatsAppHealthSnapshot["provider"],
): boolean {
  return provider === "meta" || provider === "dialog360";
}

function StatusMark({
  status,
}: {
  status: "passed" | "failed" | "unavailable";
}) {
  if (status === "passed") {
    return (
      <CheckCircle2
        className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400"
        aria-hidden
      />
    );
  }
  if (status === "failed") {
    return (
      <CircleAlert
        className="size-5 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden
      />
    );
  }
  return (
    <CircleDashed
      className="size-5 shrink-0 text-muted-foreground"
      aria-hidden
    />
  );
}

function TimelineCopy({
  event,
}: {
  event: WhatsAppHealthTimelineEvent;
}) {
  const t = useTranslations("settings");
  if (event.type === "inbound") return t("healthTimelineInbound");
  if (event.type === "outbound") {
    return t("healthTimelineOutbound", { status: pretty(event.value) });
  }
  if (event.type === "sync") return t("healthTimelineSync");
  if (event.type === "connection") {
    return t("healthTimelineConnection", { state: pretty(event.value) });
  }
  if (event.type === "template") {
    return t("healthTimelineTemplate", { status: pretty(event.value) });
  }
  if (event.type === "webhook") {
    return t("healthTimelineWebhook", { status: pretty(event.value) });
  }
  const action =
    event.action === "refresh_status"
      ? t("healthRefreshStatus")
      : event.action === "sync_templates"
        ? t("healthSyncTemplates")
        : event.action === "repair_webhook"
          ? t("healthRepairWebhook")
          : t("healthTestConnectivity");
  return t("healthTimelineRecovery", { action });
}

function DataPoint({
  label,
  value,
  unavailable,
}: {
  label: string;
  value: React.ReactNode;
  unavailable?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border/70 bg-background/60 p-4">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-2 break-words text-sm font-semibold",
          unavailable && "font-normal text-muted-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

export function WhatsAppHealthDashboard({ snapshot, entitled }: Props) {
  const t = useTranslations("settings");
  const format = useFormatter();
  const router = useRouter();
  const [pendingAction, setPendingAction] =
    useState<WhatsAppHealthAction | null>(null);
  const [isPending, startTransition] = useTransition();

  const dateTime = (value: string | null) =>
    value
      ? format.dateTime(new Date(value), {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : "—";
  const linkedDevice = snapshot.linkedDevice;
  const cloudApi = isCloudApiProvider(snapshot.provider);
  const providerLabel =
    snapshot.provider === "meta"
      ? t("healthProviderMeta")
      : snapshot.provider === "dialog360"
        ? t("healthProviderDialog360")
        : snapshot.provider === "linked_device"
          ? t("healthProviderLinkedDevice")
          : t("statusNotConnected");
  const notApplicable = t("notAvailableOnConnection");
  // Route-level rejection counters only exist for a provider callback. On a
  // linked device the absence of a number is "not applicable", never "the
  // telemetry backend is down".
  const telemetryUnavailable =
    cloudApi &&
    (snapshot.webhook.signatureFailures === null ||
      snapshot.webhook.rateLimitRejections === null);
  const heartbeatLabel = !linkedDevice
    ? notApplicable
    : linkedDevice.heartbeat === "online"
      ? t("healthWorker_online")
      : linkedDevice.heartbeat === "stale"
        ? t("healthWorker_stale")
        : t("healthWorker_offline");
  const overallStatus = !snapshot.configured
    ? "not_connected"
    : snapshot.readiness.ready
      ? "ready"
      : "attention";
  const overallLabel =
    overallStatus === "ready"
      ? t("healthOverall_ready")
      : overallStatus === "attention"
        ? t("healthOverall_attention")
        : t("healthOverall_not_connected");
  const webhookLabel =
    snapshot.webhook.status === "healthy"
      ? t("healthWebhook_healthy")
      : snapshot.webhook.status === "degraded"
        ? t("healthWebhook_degraded")
        : t("healthWebhook_unknown");
  const readinessLabels = {
    channel: t("healthReadiness_channel"),
    session: t("healthReadiness_session"),
    webhook: t("healthReadiness_webhook"),
    template: t("healthReadiness_template"),
    business_verification: t("healthReadiness_business_verification"),
    quality: t("healthReadiness_quality"),
  };

  const runAction = (action: WhatsAppHealthAction) => {
    setPendingAction(action);
    startTransition(async () => {
      const result = await runWhatsAppHealthAction(action);
      setPendingAction(null);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(t("healthActionCompleted"));
      router.refresh();
    });
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <header className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="w-fit px-0">
          <Link href="/settings/messaging">
            <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
            {t("healthBackToMessaging")}
          </Link>
        </Button>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
              {t("healthEyebrow")}
            </p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">
              {t("healthTitle")}
            </h1>
            <p className="mt-2 text-muted-foreground">
              {t("healthDescription")}
            </p>
          </div>
          <Badge
            variant={
              overallStatus === "ready"
                ? "default"
                : overallStatus === "attention"
                  ? "outline"
                  : "secondary"
            }
            className="min-h-8 px-3"
          >
            {overallLabel}
          </Badge>
        </div>
      </header>

      {!entitled ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-800 dark:text-amber-300">
          {t("whatsAppNotIncluded")}
        </div>
      ) : null}

      <section
        className="grid overflow-hidden rounded-2xl border bg-card shadow-sm lg:grid-cols-[18rem_1fr]"
        aria-labelledby="health-overview-title"
      >
        <div
          className={cn(
            "relative flex min-h-56 flex-col justify-between overflow-hidden p-6 text-white",
            snapshot.readiness.ready
              ? "bg-emerald-700 dark:bg-emerald-800"
              : "bg-slate-900",
          )}
        >
          <Signal
            className="absolute -bottom-8 -end-8 size-40 opacity-10"
            aria-hidden
          />
          <div className="relative">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/65">
              {t("healthCurrentRoute")}
            </p>
            <p className="mt-3 text-2xl font-semibold">{providerLabel}</p>
            <p className="mt-1 text-sm text-white/70">
              {snapshot.connectionState
                ? pretty(snapshot.connectionState)
                : snapshot.channelStatus
                  ? pretty(snapshot.channelStatus)
                  : t("healthNoChannel")}
            </p>
          </div>
          <div className="relative mt-8">
            <p className="text-4xl font-bold tabular-nums" dir="ltr">
              {
                snapshot.readiness.checks.filter(
                  (check) => check.status === "passed",
                ).length
              }
              <span className="text-lg font-medium text-white/60">
                {" "}
                /{" "}
                {
                  snapshot.readiness.checks.filter(
                    (check) => check.status !== "unavailable",
                  ).length
                }
              </span>
            </p>
            <p className="mt-1 text-sm text-white/70">
              {t("healthChecksPassing")}
            </p>
          </div>
        </div>
        <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-3">
          <DataPoint
            label={t("connectionStatus")}
            value={pretty(snapshot.connectionState ?? snapshot.channelStatus)}
          />
          {linkedDevice ? (
            <>
              <DataPoint
                label={t("healthConnectedNumber")}
                value={
                  linkedDevice.phoneNumber ? (
                    <span dir="ltr">{linkedDevice.phoneNumber}</span>
                  ) : (
                    "—"
                  )
                }
              />
              <DataPoint
                label={t("healthWorkerHeartbeat")}
                value={heartbeatLabel}
                unavailable={linkedDevice.heartbeat === "offline"}
              />
            </>
          ) : (
            <>
              <DataPoint label={t("healthWebhookStatus")} value={webhookLabel} />
              <DataPoint
                label={t("healthLastVerifiedEvent")}
                value={dateTime(snapshot.webhook.lastVerifiedAt)}
              />
            </>
          )}
          <DataPoint
            label={t("healthLastIncoming")}
            value={dateTime(snapshot.lastIncomingAt)}
          />
          <DataPoint
            label={t("healthLastOutgoing")}
            value={
              snapshot.lastOutgoing
                ? `${dateTime(snapshot.lastOutgoing.occurredAt)} · ${pretty(
                    snapshot.lastOutgoing.status,
                  )}`
                : "—"
            }
          />
          <DataPoint
            label={
              linkedDevice ? t("healthLastHeartbeat") : t("lastSyncedLabel")
            }
            value={dateTime(
              linkedDevice
                ? linkedDevice.lastHeartbeatAt
                : snapshot.lastSyncedAt,
            )}
          />
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)]">
        <div className="space-y-6">
          <Card id="provider-health">
            <CardHeader className="border-b">
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                  <HeartPulse className="size-5" aria-hidden />
                </span>
                <div>
                  <CardTitle id="health-overview-title">
                    {t("healthProviderSignals")}
                  </CardTitle>
                  <CardDescription>
                    {t("healthProviderSignalsDescription")}
                  </CardDescription>
                </div>
              </div>
              <CardAction>
                <Badge variant="outline">{providerLabel}</Badge>
              </CardAction>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-3 sm:grid-cols-2">
                <DataPoint
                  label={t("healthBusinessVerification")}
                  value={
                    snapshot.meta
                      ? pretty(
                          snapshot.meta.businessVerificationStatus ??
                            snapshot.meta.accountReviewStatus,
                        )
                      : t("notAvailableOnConnection")
                  }
                  unavailable={!snapshot.meta}
                />
                <DataPoint
                  label={t("healthPhoneStatus")}
                  value={
                    snapshot.meta
                      ? pretty(snapshot.meta.phoneStatus)
                      : t("notAvailableOnConnection")
                  }
                  unavailable={!snapshot.meta}
                />
                <DataPoint
                  label={t("qualityRatingLabel")}
                  value={
                    snapshot.meta
                      ? pretty(snapshot.meta.qualityRating)
                      : t("notAvailableOnConnection")
                  }
                  unavailable={!snapshot.meta}
                />
                <DataPoint
                  label={t("messagingLimitLabel")}
                  value={
                    snapshot.meta
                      ? pretty(snapshot.meta.messagingLimitTier)
                      : t("notAvailableOnConnection")
                  }
                  unavailable={!snapshot.meta}
                />
              </dl>
              {snapshot.meta &&
              !snapshot.meta.businessVerificationStatus &&
              !snapshot.meta.accountReviewStatus ? (
                <p className="mt-4 text-xs text-muted-foreground">
                  {t("healthMetaSignalNotReported")}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b">
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-sky-500/10 text-sky-700 dark:text-sky-400">
                  <Activity className="size-5" aria-hidden />
                </span>
                <div>
                  <CardTitle>{t("healthMessageAndTemplateSignals")}</CardTitle>
                  <CardDescription>
                    {t("healthMessageAndTemplateSignalsDescription")}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid gap-3 sm:grid-cols-2">
                <DataPoint
                  label={t("healthApprovedTemplates")}
                  value={
                    cloudApi
                      ? format.number(snapshot.templates.approved)
                      : notApplicable
                  }
                  unavailable={!cloudApi}
                />
                <DataPoint
                  label={t("healthTemplatesTotal")}
                  value={
                    cloudApi
                      ? format.number(snapshot.templates.total)
                      : notApplicable
                  }
                  unavailable={!cloudApi}
                />
                <DataPoint
                  label={t("healthSignatureFailures", {
                    hours: snapshot.webhook.telemetryWindowHours,
                  })}
                  value={
                    !cloudApi
                      ? notApplicable
                      : snapshot.webhook.signatureFailures === null
                        ? t("healthTelemetryUnavailable")
                        : format.number(snapshot.webhook.signatureFailures)
                  }
                  unavailable={
                    !cloudApi || snapshot.webhook.signatureFailures === null
                  }
                />
                <DataPoint
                  label={t("healthRateLimitRejections", {
                    hours: snapshot.webhook.telemetryWindowHours,
                  })}
                  value={
                    !cloudApi
                      ? notApplicable
                      : snapshot.webhook.rateLimitRejections === null
                        ? t("healthTelemetryUnavailable")
                        : format.number(snapshot.webhook.rateLimitRejections)
                  }
                  unavailable={
                    !cloudApi || snapshot.webhook.rateLimitRejections === null
                  }
                />
              </dl>
              <p className="text-xs text-muted-foreground">
                {t("healthTelemetryScope")}
              </p>
              {telemetryUnavailable ? (
                <p className="text-xs text-muted-foreground">
                  {t("healthTelemetryUnavailableDescription")}
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card id="diagnostics">
            <CardHeader className="border-b">
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-violet-500/10 text-violet-700 dark:text-violet-400">
                  <ShieldCheck className="size-5" aria-hidden />
                </span>
                <div>
                  <CardTitle>{t("healthDiagnostics")}</CardTitle>
                  <CardDescription>
                    {t("healthDiagnosticsDescription")}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              {ACTIONS.map((item) => {
                const Icon = item.icon;
                const unavailable =
                  !snapshot.configured ||
                  !entitled ||
                  !cloudApi ||
                  (item.metaOnly && snapshot.provider !== "meta");
                const busy = isPending && pendingAction === item.action;
                return (
                  <div
                    key={item.action}
                    className="flex min-h-44 flex-col rounded-xl border border-border/70 p-4"
                  >
                    <Icon className="size-5 text-primary" aria-hidden />
                    <h3 className="mt-3 text-sm font-semibold">
                      {t(item.title)}
                    </h3>
                    <p className="mt-1 flex-1 text-xs leading-5 text-muted-foreground">
                      {t(item.description)}
                    </p>
                    <Button
                      className="mt-4 w-full"
                      variant="outline"
                      onClick={() => runAction(item.action)}
                      disabled={unavailable || isPending}
                    >
                      {busy ? (
                        <Loader2
                          className="size-4 animate-spin motion-reduce:animate-none"
                          aria-hidden
                        />
                      ) : (
                        <Icon className="size-4" aria-hidden />
                      )}
                      {t(item.title)}
                    </Button>
                    {!cloudApi ||
                    (item.metaOnly && snapshot.provider !== "meta") ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {notApplicable}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader className="border-b">
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400">
                  <ClipboardCheck className="size-5" aria-hidden />
                </span>
                <div>
                  <CardTitle>{t("healthReadinessTitle")}</CardTitle>
                  <CardDescription>
                    {t("healthReadinessDescription")}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <ol className="space-y-1">
                {snapshot.readiness.checks.map((check) => (
                  <li key={check.key}>
                    <Link
                      href={check.href}
                      className="group flex min-h-14 items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      <StatusMark status={check.status} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">
                          {readinessLabels[check.key]}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {check.status === "unavailable"
                            ? notApplicable
                            : check.key === "session"
                              ? heartbeatLabel
                              : check.value
                                ? pretty(check.value)
                                : t("healthCheckNeedsAttention")}
                        </span>
                      </span>
                      <ExternalLink
                        className="size-4 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5"
                        aria-hidden
                      />
                    </Link>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b">
              <div className="flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-slate-500/10 text-slate-700 dark:text-slate-300">
                  <History className="size-5" aria-hidden />
                </span>
                <div>
                  <CardTitle>{t("healthTimelineTitle")}</CardTitle>
                  <CardDescription>
                    {t("healthTimelineDescription")}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {snapshot.timeline.length === 0 ? (
                <div className="py-8 text-center">
                  <FileCheck2
                    className="mx-auto size-7 text-muted-foreground"
                    aria-hidden
                  />
                  <p className="mt-3 text-sm font-medium">
                    {t("healthTimelineEmpty")}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("healthTimelineEmptyDescription")}
                  </p>
                </div>
              ) : (
                <ol className="relative space-y-0 before:absolute before:bottom-3 before:start-[0.4375rem] before:top-3 before:w-px before:bg-border">
                  {snapshot.timeline.map((event) => (
                    <li
                      key={event.id}
                      className="relative flex gap-3 py-3 first:pt-0 last:pb-0"
                    >
                      <span className="relative z-10 mt-1 size-3.5 shrink-0 rounded-full border-2 border-background bg-primary ring-1 ring-border" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          <TimelineCopy event={event} />
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          <time dateTime={event.occurredAt}>
                            {dateTime(event.occurredAt)}
                          </time>
                          {event.provider ? (
                            <>
                              {" "}
                              ·{" "}
                              {event.provider === "meta"
                                ? t("healthProviderMeta")
                                : event.provider === "linked_device"
                                  ? t("healthProviderLinkedDevice")
                                  : t("healthProviderDialog360")}
                            </>
                          ) : null}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <p className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <MessageCircleMore className="size-4" aria-hidden />
        {t("healthNoMessageContent")}
      </p>
    </div>
  );
}
