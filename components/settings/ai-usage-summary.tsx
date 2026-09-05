import { Activity, Gauge, KeyRound, ServerCog, ShieldCheck } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ClinicAiCommercialUsage } from "@/lib/ai/commercial";

function microsToUsd(micros: number): number {
  return micros / 1_000_000;
}

/**
 * The clinic-facing meter.
 *
 * Customer-facing wording only: "included AI usage", a percentage, a reset date,
 * and which key the clinic is running on. The cost-weighted internals that drive
 * enforcement (micros, worst-case reservations, cache-write pricing, billing
 * dispositions) stay on the operator side, where they mean something. The one
 * currency figure shown is the clinic's OWN estimated provider spend under BYOK,
 * which is the clinic's own bill and is labelled as an estimate.
 */
export function AiUsageSummary({ usage }: { usage: ClinicAiCommercialUsage }) {
  const t = useTranslations("settings");
  const format = useFormatter();

  const thresholdLabel = !usage.managedAllowanceConfigured
    ? t("aiManagedAllowanceNotConfigured")
    : usage.threshold === "exhausted"
      ? t("aiUsageThresholdExhausted")
      : usage.threshold === "critical"
        ? t("aiUsageThresholdCritical")
        : usage.threshold === "warning"
          ? t("aiUsageThresholdWarning")
          : t("aiUsageThresholdNormal");
  const thresholdVariant = !usage.managedAllowanceConfigured
    ? "outline"
    : usage.threshold === "exhausted"
      ? "destructive"
      : usage.threshold === "normal"
        ? "secondary"
        : "outline";

  const providerLabel =
    usage.providerState === "byok"
      ? t("aiProviderStateByok")
      : usage.providerState === "auto_byok"
        ? t("aiProviderStateAutoByok")
        : t("aiProviderStateManaged");
  const providerNote =
    usage.providerState === "byok"
      ? t("aiProviderStateByokNote")
      : usage.providerState === "auto_byok"
        ? t("aiProviderStateAutoByokNote")
        : t("aiProviderStateManagedNote");

  // The one action the clinic can actually take, surfaced exactly when it is
  // actionable — and never for a clinic already running on its own key.
  const callToAction =
    usage.providerState !== "managed" || !usage.managedAllowanceConfigured
      ? null
      : usage.threshold === "exhausted"
        ? t("aiUsageExhaustedNoKeyNote")
        : usage.threshold === "critical"
          ? t("aiUsageNearlyExhaustedNote")
          : null;

  const barTone =
    usage.threshold === "exhausted"
      ? "bg-destructive"
      : usage.threshold === "critical"
        ? "bg-amber-500"
        : "bg-primary";

  const showByok = usage.byokRequestUsed > 0 || usage.byokEstimatedCostMicros > 0;

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="size-5 text-primary" aria-hidden="true" />
            {t("aiUsageTitle")}
          </CardTitle>
          <CardDescription>{t("aiUsageDescription")}</CardDescription>
        </div>
        <Badge variant={thresholdVariant}>{thresholdLabel}</Badge>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="font-medium">{t("aiManagedAllowance")}</span>
            <span className="tabular-nums">
              {usage.managedAllowanceConfigured
                ? t("aiUsagePercentUsed", {
                    percent: format.number(usage.usedPercent, { maximumFractionDigits: 0 }),
                  })
                : "—"}
            </span>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label={t("aiManagedAllowance")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={usage.usedPercent}
          >
            <div
              className={`h-full rounded-full transition-[width] motion-reduce:transition-none ${barTone}`}
              style={{ width: `${usage.usedPercent}%` }}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              {usage.managedAllowanceConfigured
                ? t("aiUsageRemainingOfAllowance", {
                    remaining: format.number(usage.requestRemaining),
                    allowance: format.number(usage.requestLimit),
                  })
                : t("aiManagedAllowanceNotConfiguredNote")}
            </span>
            {usage.managedAllowanceConfigured ? (
              <span>
                {t("aiUsageResetsOn", {
                  date: format.dateTime(new Date(`${usage.resetDate}T00:00:00Z`), {
                    dateStyle: "medium",
                    timeZone: "UTC",
                  }),
                })}
              </span>
            ) : null}
          </div>
          {usage.managedAllowanceConfigured && usage.reservedMicros > 0 ? (
            <p className="text-xs text-muted-foreground">{t("aiAllowanceIncludesInFlight")}</p>
          ) : null}
        </div>

        <div className="rounded-lg border bg-muted/20 p-4">
          <div className="flex items-center gap-2">
            <ServerCog className="size-4 text-primary" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">{t("aiProviderStateTitle")}</p>
          </div>
          <p className="mt-1 font-medium">{providerLabel}</p>
          <p className="mt-1 text-xs text-muted-foreground">{providerNote}</p>
        </div>

        {callToAction ? (
          <p
            className={
              usage.threshold === "exhausted"
                ? "rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
                : "rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm"
            }
          >
            {callToAction}
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border bg-muted/20 p-4">
            <Activity className="size-4 text-primary" aria-hidden="true" />
            <p className="mt-2 text-sm text-muted-foreground">{t("aiRequestsThisMonth")}</p>
            <p className="mt-1 text-lg font-semibold tabular-nums" dir="ltr">
              {format.number(usage.requestUsed)} / {format.number(usage.requestLimit)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("aiRequestsRemaining", { count: usage.requestRemaining })}
            </p>
          </div>
          <div className="rounded-lg border bg-muted/20 p-4">
            <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
            <p className="mt-2 text-sm text-muted-foreground">{t("aiBillingPolicy")}</p>
            <p className="mt-1 font-medium">
              {usage.overageMode === "contracted"
                ? t("aiContractedOverage")
                : usage.hasAddon
                  ? t("aiPrepaidAddon")
                  : t("aiHardCap")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{t("aiByokAllowanceNote")}</p>
          </div>
        </div>

        {showByok ? (
          <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-4">
            <div className="flex items-center gap-2">
              <KeyRound className="size-4 text-violet-700 dark:text-violet-300" aria-hidden="true" />
              <p className="text-sm font-medium">{t("aiByokUsageTitle")}</p>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground">{t("aiByokRequests")}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums" dir="ltr">
                  {format.number(usage.byokRequestUsed)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t("aiByokEstimatedCost")}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums" dir="ltr">
                  {format.number(microsToUsd(usage.byokEstimatedCostMicros), {
                    style: "currency",
                    currency: "USD",
                    maximumFractionDigits: 2,
                  })}
                </p>
              </div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">{t("aiByokEstimateDisclaimer")}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
