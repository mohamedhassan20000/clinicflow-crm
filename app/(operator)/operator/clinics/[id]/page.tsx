import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import {
  Building2,
  CalendarCheck,
  Database,
  FileText,
  History,
  PlugZap,
  Receipt,
  ShieldCheck,
  Sparkles,
  Users,
  UsersRound,
} from "lucide-react";
import {
  acceptAiCommercialTerms,
  cancelManualSubscription,
  extendSubscriptionDays,
  grantManualSubscription,
  pauseClinicAccess,
  reactivateClinicAccess,
  removeFeatureOverride,
  revokeAiCommercialTerms,
  upsertFeatureOverride,
  updateAiCommercialTerms,
} from "@/actions/operator";
import { AllowanceOverrideControls } from "@/components/operator/allowance-override-controls";
import { ClinicDetailTabs } from "@/components/operator/clinic-detail-tabs";
import { OperatorActionForm } from "@/components/operator/operator-action-form";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { UsageBar } from "@/components/shared/usage-bar";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resolveSubscriptionAccess } from "@/lib/billing/access";
import { resolveReturnTo } from "@/lib/navigation/return-url";
import {
  getOperatorClinicHistory,
  getOperatorClinicMetrics,
  OPERATOR_CLINIC_USAGE_METRICS,
  OPERATOR_CLINIC_USAGE_PAGE_SIZES,
  parseOperatorClinicUsageParams,
} from "@/lib/supabase/admin";
import {
  loadOperatorAllowanceReport,
  monthStartUtc,
  nextMonthStartUtc,
} from "@/lib/ai/operator-allowance";
import { cn } from "@/lib/utils";
import { getLocale, getTranslations } from "next-intl/server";
import { formatClinicNumber } from "@/lib/datetime";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * The panels of the owner clinic record. The value is also the `tab` search
 * param, so the usage-history pager can link straight back to the AI panel.
 */
const CLINIC_TABS = ["overview", "subscription", "ai-usage", "features", "history"] as const;
type ClinicTab = (typeof CLINIC_TABS)[number];

const DEFAULT_TAB: ClinicTab = "overview";

function parseTab(value: string | undefined): ClinicTab {
  return CLINIC_TABS.includes(value as ClinicTab) ? (value as ClinicTab) : DEFAULT_TAB;
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value)) + " UTC";
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value));
}

/** Micros are ClinicFlow's internal cost unit; the owner only ever sees USD. */
function usd(micros: number) {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/**
 * KpiCard's trend slot, or nothing. A null change means the previous month had
 * no activity at all — "+100%" against zero is a fabricated comparison, so the
 * card simply shows no trend rather than an impressive-looking non-fact.
 */
function trendFor(change: number | null, label: string) {
  return change === null ? undefined : { value: change, label };
}

function humanize(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function Section({
  id,
  title,
  description,
  children,
  className,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn("rounded-xl border bg-card", className)}>
      <div className="border-b px-5 py-4">
        <h2 id={`${id}-title`} className="font-semibold">{title}</h2>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

/** A small label/value tile, used by the allowance and billing summaries. */
function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 font-semibold tabular-nums" dir="ltr">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function StatusBadge({ value }: { value: string }) {
  const positive = value === "active" || value === "accepted" || value === "trialing";
  const negative = value === "cancelled" || value === "revoked" || value === "expired";
  return (
    <Badge variant={negative ? "destructive" : positive ? "default" : "secondary"}>
      {humanize(value)}
    </Badge>
  );
}

function workingHoursSummary(
  rows: Array<{ day_of_week: number; shift_start: string; shift_end: string }>,
  fallbackStart: string | null,
  fallbackEnd: string | null,
) {
  if (rows.length === 0) {
    return fallbackStart && fallbackEnd
      ? [`Clinic default: ${fallbackStart.slice(0, 5)}–${fallbackEnd.slice(0, 5)}`]
      : ["No working hours configured"];
  }
  const grouped = new Map<number, string[]>();
  for (const row of rows) {
    const shifts = grouped.get(row.day_of_week) ?? [];
    shifts.push(`${row.shift_start.slice(0, 5)}–${row.shift_end.slice(0, 5)}`);
    grouped.set(row.day_of_week, shifts);
  }
  return [...grouped.entries()].map(([day, shifts]) => `${DAY_NAMES[day] ?? `Day ${day}`}: ${shifts.join(", ")}`);
}

function couponBenefit(row: {
  kind: string;
  months: number | null;
  percent: number | null;
}) {
  if (row.kind === "lifetime_free") return "Lifetime free";
  if (row.kind === "months_free") return `${row.months ?? "—"} months free`;
  return `${row.percent ?? "—"}% discount`;
}

export default async function OperatorClinicPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    returnTo?: string;
    tab?: string;
    usageMetric?: string;
    usagePage?: string;
    usagePageSize?: string;
  }>;
}) {
  const locale = await getLocale();
  const t = await getTranslations("operator");
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const clinicsUrl = resolveReturnTo(query.returnTo, "/operator/clinics", ["/operator/clinics"]);
  const usageParams = parseOperatorClinicUsageParams(query);
  const activeTab = parseTab(query.tab);
  const now = new Date();
  // Aggregates and the allowance row are loaded alongside the history: all three
  // are count/commercial reads guarded by requirePlatformAdmin, and none of them
  // can return a tenant row.
  const [historyResult, metrics, allowanceReport] = await Promise.all([
    getOperatorClinicHistory(id, usageParams),
    getOperatorClinicMetrics(id, now),
    loadOperatorAllowanceReport({
      periodStart: monthStartUtc(now),
      periodReset: nextMonthStartUtc(now),
      clinicId: id,
    }),
  ]);
  const allowance = allowanceReport.rows[0] ?? null;
  if (!historyResult.data && !historyResult.error) notFound();
  if (historyResult.error || !historyResult.data) {
    throw new Error("Operator clinic history could not be loaded.");
  }

  const history = historyResult.data;
  const { clinic, subscription, usage } = history;
  const access = resolveSubscriptionAccess(subscription ?? null);
  const workingHours = workingHoursSummary(
    history.workingHours,
    clinic.working_hours_start,
    clinic.working_hours_end,
  );
  const aiTerms = history.aiTerms;
  const aiBudget = history.aiBudget;
  const microsToUsdInput = (value: number | null | undefined) =>
    value === null || value === undefined ? "" : String(value / 1_000_000);
  const monthTrend = (change: number | null) => trendFor(change, t("kpiVsPreviousMonth"));

  // Mutually exclusive by construction: pausing is offered only while access is
  // live, reactivating only while it is not. Both are the same reversible flow
  // (subscriptions.status ↔ past_due), so the pair can never render together.
  const canPause = subscription?.status === "active" || subscription?.status === "trialing";
  const canReactivate = Boolean(subscription) && !canPause;
  const canCancel = Boolean(subscription) && subscription?.status !== "cancelled";

  const renewalDate = subscription?.current_period_end
    ? formatDate(subscription.current_period_end)
    : subscription?.status === "active"
      ? t("unbounded")
      : "—";

  const timeline = [
    {
      id: `clinic-${clinic.id}`,
      createdAt: clinic.created_at,
      title: t("clinicRecordCreated"),
      detail: clinic.onboarding_completed_at ? t("onboardingLaterCompleted") : t("onboardingRemainsIncomplete"),
      source: t("recordedFact"),
    },
    ...(subscription
      ? [{
          id: `subscription-${subscription.id}`,
          createdAt: subscription.created_at,
          title: t("subscriptionRecordCreated"),
          detail: t("subscriptionTimelineDetail", {
            plan: subscription.plans?.name_en ?? subscription.plans?.slug ?? t("planUnavailable"),
            status: humanize(subscription.status),
            trial: subscription.trial_ends_at ? t("trialEnded", { date: formatDate(subscription.trial_ends_at) }) : "",
          }),
          source: t("recordedFact"),
        }]
      : []),
    ...history.invitations.flatMap((invitation) => [
      {
        id: `${invitation.id}-requested`,
        createdAt: invitation.created_at,
        title: t("clinicAccessRequested"),
        detail: t("currentStatusValue", { status: humanize(invitation.status) }),
        source: t("recordedFact"),
      },
      ...(invitation.email_sent_at ? [{
        id: `${invitation.id}-email`,
        createdAt: invitation.email_sent_at,
        title: t("invitationEmailRecordedSent"),
        detail: null,
        source: t("recordedFact"),
      }] : []),
      ...(invitation.accepted_at ? [{
        id: `${invitation.id}-accepted`,
        createdAt: invitation.accepted_at,
        title: t("invitationAccepted"),
        detail: null,
        source: t("recordedFact"),
      }] : []),
      ...(invitation.revoked_at ? [{
        id: `${invitation.id}-revoked`,
        createdAt: invitation.revoked_at,
        title: t("invitationRevoked"),
        detail: null,
        source: t("recordedFact"),
      }] : []),
    ]),
    ...history.redemptions.map((redemption) => ({
      id: `redemption-${redemption.id}`,
      createdAt: redemption.redeemed_at,
      title: t("couponRedemptionRecorded"),
      detail: redemption.coupons
        ? `${redemption.coupons.code} · ${couponBenefit(redemption.coupons)}`
        : t("couponRecordUnavailable"),
      source: t("recordedFact"),
    })),
    ...history.auditEvents.map((event) => ({
      id: `audit-${event.id}`,
      createdAt: event.createdAt,
      title: event.title,
      detail: event.detail,
      source: t("derivedFromAuditLog"),
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  function usageHref(page: number, metric = usage.metric, pageSize = usage.pageSize) {
    const href = new URLSearchParams();
    if (query.returnTo) href.set("returnTo", query.returnTo);
    href.set("tab", "ai-usage");
    href.set("usageMetric", metric);
    href.set("usagePageSize", String(pageSize));
    href.set("usagePage", String(page));
    return `/operator/clinics/${id}?${href.toString()}#usage-history`;
  }

  /**
   * Owner-facing names for the metered counters. The column names are what the
   * page used to show, humanised into "Ai Messages" and "Wa Messages" — an
   * internal identifier wearing title case. Literal `t()` calls, not a computed
   * key, so the i18n gate can see them.
   */
  function usageMetricLabel(metric: string) {
    if (metric === "ai_messages") return t("usageMetricAiMessages");
    if (metric === "wa_messages") return t("usageMetricWhatsappMessages");
    if (metric === "sms_messages") return t("usageMetricSmsMessages");
    if (metric === "emails") return t("usageMetricEmails");
    return humanize(metric);
  }

  const invitationColumns: readonly DataTableColumn<(typeof history.invitations)[number]>[] = [
    { key: "created_at", label: t("requested"), render: (row) => formatTimestamp(row.created_at) },
    { key: "status", label: t("currentStatus"), render: (row) => <StatusBadge value={row.status} /> },
    { key: "email_sent_at", label: t("emailSent"), render: (row) => formatTimestamp(row.email_sent_at) },
    { key: "accepted_at", label: t("accepted"), render: (row) => formatTimestamp(row.accepted_at) },
    { key: "expires_at", label: t("expiry"), render: (row) => formatTimestamp(row.expires_at) },
  ];
  const redemptionColumns: readonly DataTableColumn<(typeof history.redemptions)[number]>[] = [
    { key: "code", label: t("coupon"), render: (row) => row.coupons?.code ?? t("unavailable") },
    {
      key: "benefit",
      label: t("benefit"),
      render: (row) => row.coupons ? couponBenefit(row.coupons) : "—",
    },
    { key: "redeemed_at", label: t("redeemed"), render: (row) => formatTimestamp(row.redeemed_at) },
    {
      key: "is_active",
      label: t("couponState"),
      render: (row) => row.coupons ? (row.coupons.is_active ? t("active") : t("inactive")) : "—",
    },
  ];
  const usageColumns: readonly DataTableColumn<(typeof usage.rows)[number]>[] = [
    { key: "period_start", label: t("period"), render: (row) => formatDate(row.period_start) },
    { key: "metric", label: t("metric"), render: (row) => usageMetricLabel(row.metric) },
    { key: "used", label: t("used"), numeric: true },
    { key: "limit_snapshot", label: t("limitSnapshot"), numeric: true },
    {
      key: "remaining",
      label: t("remaining"),
      numeric: true,
      render: (row) => Math.max(0, row.limit_snapshot - row.used).toLocaleString("en"),
    },
  ];

  const overviewTab = (
    <>
      <Section id="clinic-profile" title={t("clinicProfile")} description={t("recordedTenantMetadataOnlyNoPatient")}>
        <dl className="grid gap-x-5 gap-y-3 text-sm sm:grid-cols-2">
          {[
            [t("country"), clinic.country],
            [t("timezone"), clinic.timezone],
            [t("locale"), clinic.locale],
            [t("canonicalCurrency"), clinic.currency],
            [t("created"), formatTimestamp(clinic.created_at)],
            [t("onboarding"), clinic.onboarding_completed_at ? t("completedAt", { date: formatTimestamp(clinic.onboarding_completed_at) }) : t("incomplete")],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="mt-0.5 font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-5 border-t pt-4">
          <h3 className="text-sm font-medium">{t("workingHoursSummary")}</h3>
          <ul className="mt-2 grid gap-1 text-sm text-muted-foreground sm:grid-cols-2">
            {workingHours.map((summary) => <li key={summary}>{summary}</li>)}
          </ul>
        </div>
      </Section>

      <Section
        id="operations-trend"
        title={t("operationsTrend")}
        description={t("operationsTrendDescription")}
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="border-b text-start">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-start [&>th]:font-medium">
                <th>{t("metric")}</th>
                <th>{t("periodThisMonth")}</th>
                <th>{t("periodPreviousMonth")}</th>
                <th>{t("periodChange")}</th>
              </tr>
            </thead>
            <tbody>
              {[
                {
                  key: "patients",
                  label: t("kpiPatients"),
                  current: metrics.trend.current.patients,
                  previous: metrics.trend.previous.patients,
                  change: metrics.trend.change.patients,
                },
                {
                  key: "appointments",
                  label: t("kpiAppointments"),
                  current: metrics.trend.current.appointments,
                  previous: metrics.trend.previous.appointments,
                  change: metrics.trend.change.appointments,
                },
                {
                  key: "documents",
                  label: t("kpiDocumentsIssued"),
                  current: metrics.trend.current.documentsIssued,
                  previous: metrics.trend.previous.documentsIssued,
                  change: metrics.trend.change.documentsIssued,
                },
                {
                  key: "invoices",
                  label: t("kpiInvoicesIssued"),
                  current: metrics.trend.current.invoicesIssued,
                  previous: metrics.trend.previous.invoicesIssued,
                  change: metrics.trend.change.invoicesIssued,
                },
              ].map((row) => (
                <tr key={row.key} className="border-b last:border-0 [&>td]:px-3 [&>td]:py-2">
                  <td>{row.label}</td>
                  <td className="tabular-nums">{formatClinicNumber(row.current, { locale })}</td>
                  <td className="tabular-nums">{formatClinicNumber(row.previous, { locale })}</td>
                  <td className="tabular-nums">
                    {row.change === null ? (
                      <span className="text-muted-foreground">{t("noBaseline")}</span>
                    ) : (
                      <span
                        dir="ltr"
                        className={row.change >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}
                      >
                        {row.change >= 0 ? "+" : ""}{row.change}%
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <section aria-labelledby="data-honesty-title" className="rounded-xl border border-dashed bg-muted/20 p-5">
        <h2 id="data-honesty-title" className="font-semibold">{t("howToReadThisRecord")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("clinicflowSeparatesStoredFactsFromReconstructed")}</p>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {[
            { icon: Database, title: t("recordedFact"), text: t("recordedFactDescription") },
            { icon: History, title: t("derivedFromAuditLog"), text: t("derivedAuditDescription") },
            { icon: PlugZap, title: t("futureIntegration"), text: t("futureIntegrationDescription") },
          ].map(({ icon: Icon, title, text }) => (
            <div key={title} className="rounded-lg border bg-card p-4">
              <Icon className="size-5 text-primary" aria-hidden="true" />
              <h3 className="mt-2 text-sm font-semibold">{title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{text}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );

  const subscriptionTab = (
    <>
      <Section id="current-subscription" title={t("currentSubscription")} description={t("theSubscriptionTableStoresOneMutable")}>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <dt className="text-muted-foreground">{t("plan")}</dt>
          <dd>{subscription?.plans?.name_en ?? subscription?.plans?.slug ?? "—"}</dd>
          <dt className="text-muted-foreground">{t("status")}</dt>
          <dd>{subscription ? <StatusBadge value={subscription.status} /> : t("missing")} <span className="text-muted-foreground">({access.reason.replaceAll("_", " ")})</span></dd>
          <dt className="text-muted-foreground">{t("subscriptionSource")}</dt>
          <dd>{subscription?.provider ?? "—"}</dd>
          <dt className="text-muted-foreground">{t("trialEnds")}</dt>
          <dd>{formatTimestamp(subscription?.trial_ends_at)}</dd>
          <dt className="text-muted-foreground">{t("periodStart")}</dt>
          <dd>{formatTimestamp(subscription?.current_period_start)}</dd>
          <dt className="text-muted-foreground">{t("periodEnd")}</dt>
          <dd>{subscription?.current_period_end ? formatTimestamp(subscription.current_period_end) : subscription?.status === "active" ? t("unbounded") : "—"}</dd>
          <dt className="text-muted-foreground">{t("renewsOn")}</dt>
          <dd>{renewalDate}</dd>
          <dt className="text-muted-foreground">{t("lastRowUpdate")}</dt>
          <dd>{formatTimestamp(subscription?.updated_at)}</dd>
        </dl>

        <div className="mt-5 border-t pt-4">
          <h3 className="mb-3 text-sm font-medium">{t("manualGrantExtendsALivePeriod")}</h3>
          <OperatorActionForm action={grantManualSubscription} submitLabel={t("grantSubscription")}>
            <input type="hidden" name="clinicId" value={id} />
            <div className="flex flex-wrap gap-3">
              <label className="text-sm">
                {t("plan2")}{" "}
                <select name="planSlug" className="rounded-md border bg-background px-2 py-1" defaultValue="basic">
                  {history.plans.map((plan) => <option key={plan.slug} value={plan.slug}>{plan.name_en}</option>)}
                </select>
              </label>
              <label className="text-sm">
                {t("duration")}{" "}
                <select name="months" className="rounded-md border bg-background px-2 py-1" defaultValue="1">
                  {[1, 3, 6, 12, 24].map((months) => <option key={months} value={months}>{t("monthCount", { count: months })}</option>)}
                  <option value="unbounded">{t("unbounded")}</option>
                </select>
              </label>
            </div>
          </OperatorActionForm>
        </div>

        <div className="mt-5 border-t pt-4">
          <h3 className="mb-3 text-sm font-medium">{t("addExtraDays")}</h3>
          <p className="mb-3 text-sm text-muted-foreground">{t("addExtraDaysDescription")}</p>
          <OperatorActionForm action={extendSubscriptionDays} submitLabel={t("extendSubscription")}>
            <input type="hidden" name="clinicId" value={id} />
            <div className="grid max-w-xs gap-1.5">
              <Label htmlFor="extendDays">{t("extraDays")}</Label>
              <Input id="extendDays" name="days" type="number" min="1" max="3650" step="1" defaultValue="30" required dir="ltr" />
            </div>
          </OperatorActionForm>
        </div>

        <div className="mt-5 border-t pt-4">
          <h3 className="mb-1 text-sm font-medium">{t("accessControl")}</h3>
          <p className="mb-3 text-sm text-muted-foreground">
            {canPause ? t("accessCurrentlyActive") : t("accessCurrentlyPaused")}
          </p>
          <p className="mb-3 text-sm text-muted-foreground">{t("accessControlDescription")}</p>
          {canPause ? (
            <OperatorActionForm action={pauseClinicAccess} submitLabel={t("pauseAccess")} submitVariant="secondary">
              <input type="hidden" name="clinicId" value={id} />
            </OperatorActionForm>
          ) : null}
          {canReactivate ? (
            <OperatorActionForm action={reactivateClinicAccess} submitLabel={t("reactivateAccess")}>
              <input type="hidden" name="clinicId" value={id} />
            </OperatorActionForm>
          ) : null}
          {!subscription ? (
            <p className="text-sm text-muted-foreground">{t("accessControlNoSubscription")}</p>
          ) : null}
        </div>

        {canCancel ? (
          <div className="mt-5 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
            <h3 className="text-sm font-medium text-destructive">{t("dangerZone")}</h3>
            <p className="mb-3 mt-1 text-sm text-muted-foreground">{t("dangerZoneDescription")}</p>
            <OperatorActionForm action={cancelManualSubscription} submitLabel={t("cancelSubscriptionNow")} submitVariant="destructive">
              <input type="hidden" name="clinicId" value={id} />
            </OperatorActionForm>
          </div>
        ) : null}
      </Section>

      <Section id="payments-contracts" title={t("billingAndInvoicing")} description={t("billingAndInvoicingDescription")}>
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <div className="rounded-lg border bg-muted/20 p-3">
            <dt className="text-muted-foreground">{t("kpiInvoicesIssued")}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">
              {formatClinicNumber(metrics.totals.invoicesIssued, { locale })}
            </dd>
            <dd className="mt-1 text-xs text-muted-foreground">
              {t("kpiThisMonthValue", { count: formatClinicNumber(metrics.trend.current.invoicesIssued, { locale }) })}
            </dd>
          </div>
          <div className="rounded-lg border bg-muted/20 p-3">
            <dt className="text-muted-foreground">{t("currentSubscriptionState")}</dt>
            <dd className="mt-1">{subscription ? <StatusBadge value={subscription.status} /> : t("missing")}</dd>
            <dd className="mt-1 text-xs text-muted-foreground">{humanize(access.reason)}</dd>
          </div>
          <div className="rounded-lg border bg-muted/20 p-3">
            <dt className="text-muted-foreground">{t("subscriptionSource")}</dt>
            <dd className="mt-1 font-medium">{subscription?.provider ?? "—"}</dd>
            <dd className="mt-1 text-xs text-muted-foreground">
              {t("renewalDateValue", { date: renewalDate })}
            </dd>
          </div>
        </dl>
        <p className="mt-4 rounded-lg border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">
          {t("billingHistoryScopeNote")}</p>
      </Section>
    </>
  );

  const aiUsageTab = (
    <>
      <Section
        id="ai-allowance"
        title={t("aiAllowanceSection")}
        description={t("aiAllowanceSectionDescription")}
      >
        {allowance ? (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Stat
                label={t("aiAllowanceIncluded")}
                value={usd(allowance.effective_included_micros)}
                hint={
                  allowance.override_included_micros === null
                    ? t("aiAllowanceSourceIsPlanDefault")
                    : t("aiAllowanceSourceIsClinicOverride")
                }
              />
              <Stat label={t("aiAllowanceUsed")} value={usd(allowance.managed_spent_micros)} />
              <Stat label={t("aiAllowanceReserved")} value={usd(allowance.managed_reserved_micros)} />
              <Stat label={t("aiAllowanceRemaining")} value={usd(allowance.remaining_micros)} />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="font-medium">{t("aiAllowancePercent")}</span>
                <span className="tabular-nums" dir="ltr">{allowance.used_percent}%</span>
              </div>
              <UsageBar percent={allowance.used_percent} label={t("aiAllowancePercent")} />
              <p className="text-sm text-muted-foreground">
                {t("kpiAiUsageSub", { date: formatDate(allowance.period_reset_at) })}
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Stat
                label={t("aiAllowanceSource")}
                value={
                  allowance.override_included_micros === null
                    ? t("aiAllowancePlanDefault")
                    : t("aiAllowanceClinicOverride")
                }
                hint={t("aiAllowancePlanDefaultIs", { amount: usd(allowance.plan_included_micros) })}
              />
              <Stat
                label={t("aiAllowanceByok")}
                value={allowance.byok_configured ? t("aiAllowanceByokConfigured") : t("aiAllowanceByokMissing")}
                hint={
                  allowance.auto_byok_fallback_enabled
                    ? t("aiAllowanceAutoFallbackOn")
                    : t("aiAllowanceAutoFallbackOff")
                }
              />
            </div>

            <div className="border-t pt-4">
              <h3 className="mb-3 text-sm font-medium">{t("aiAllowanceOverrideHeading")}</h3>
              <AllowanceOverrideControls
                clinicId={id}
                planDefaultUsd={allowance.plan_included_micros / 1_000_000}
                overrideUsd={
                  allowance.override_included_micros === null
                    ? null
                    : allowance.override_included_micros / 1_000_000
                }
              />
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("aiAllowanceRowUnavailable")}</p>
        )}
      </Section>

      <Section id="usage-history" title={t("usageHistory")} description={t("filterableServerPaginatedUsageCountersValues")}>
        <form method="get" action={`/operator/clinics/${id}`} className="mb-4 flex flex-wrap items-end gap-3">
          {query.returnTo ? <input type="hidden" name="returnTo" value={query.returnTo} /> : null}
          <input type="hidden" name="tab" value="ai-usage" />
          <label className="grid gap-1 text-sm">
            {t("metric")}<select name="usageMetric" defaultValue={usage.metric} className="min-h-9 rounded-md border bg-background px-3">
              <option value="all">{t("allMetrics")}</option>
              {OPERATOR_CLINIC_USAGE_METRICS.map((metric) => <option key={metric} value={metric}>{usageMetricLabel(metric)}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            {t("rowsPerPage")}<select name="usagePageSize" defaultValue={String(usage.pageSize)} className="min-h-9 rounded-md border bg-background px-3">
              {OPERATOR_CLINIC_USAGE_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
          <input type="hidden" name="usagePage" value="1" />
          <Button type="submit" size="lg">{t("apply")}</Button>
          {usage.metric !== "all" ? <Link href={usageHref(1, "all")} className={buttonVariants({ variant: "outline", size: "lg" })}>{t("clearFilter")}</Link> : null}
        </form>
        <DataTable
          columns={usageColumns}
          rows={usage.rows}
          rowKey={(row) => row.id}
          caption={t("usageCounterHistory")}
          stickyHeader
          empty={{
            compact: true,
            title: usage.metric === "all" ? t("noUsageRecorded") : t("noUsageMatchesMetric"),
            description: usage.metric === "all" ? t("usageCountersAppearLater") : t("clearMetricFilter"),
          }}
        />
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="text-muted-foreground">{t("usagePageSummary", {
            total: formatClinicNumber(usage.total, { locale }),
            page: usage.page,
            pageCount: usage.pageCount,
          })}</p>
          <nav aria-label={t("usageHistoryPagination")} className="flex gap-2">
            {usage.page > 1 ? <Link href={usageHref(usage.page - 1)} className={buttonVariants({ variant: "outline" })}>{t("previous")}</Link> : null}
            {usage.page < usage.pageCount ? <Link href={usageHref(usage.page + 1)} className={buttonVariants({ variant: "outline" })}>{t("next")}</Link> : null}
          </nav>
        </div>
      </Section>

      <details id="advanced-ai-controls" className="rounded-xl border bg-card">
        <summary className="cursor-pointer px-5 py-4 font-semibold">{t("advancedAiControls")}</summary>
        <div className="space-y-5 border-t p-5">
          <p className="text-sm text-muted-foreground">{t("advancedAiControlsDescription")}</p>
          {!history.effectiveAiAssistant ? (
            <p className="text-sm text-muted-foreground">{t("aiCommercialTermsNotEffective")}</p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <div className="space-y-1 text-sm">
              <p className="font-medium">{t("aiCommercialTermsAcceptance")}</p>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge value={aiTerms?.accepted_at ? "accepted" : "revoked"} />
                {aiTerms?.accepted_at ? (
                  <span className="text-muted-foreground">
                    {t("acceptedAt", { date: formatTimestamp(aiTerms.accepted_at) })}
                  </span>
                ) : null}
              </div>
            </div>
            {aiTerms ? (
              aiTerms.accepted_at ? (
                <OperatorActionForm
                  action={revokeAiCommercialTerms}
                  submitLabel={t("revokeAiCommercialTerms")}
                  submitVariant="destructive"
                >
                  <input type="hidden" name="clinicId" value={id} />
                </OperatorActionForm>
              ) : (
                <OperatorActionForm
                  action={acceptAiCommercialTerms}
                  submitLabel={t("acceptAiCommercialTerms")}
                >
                  <input type="hidden" name="clinicId" value={id} />
                </OperatorActionForm>
              )
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("saveAiCommercialTermsBeforeAcceptance")}
              </p>
            )}
          </div>

          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div className="rounded-lg border bg-muted/20 p-3">
              <dt className="text-muted-foreground">{t("currentManagedSpend")}</dt>
              <dd className="mt-1 font-semibold tabular-nums" dir="ltr">
                {usd(aiBudget?.spent_micros ?? 0)}
              </dd>
            </div>
            <div className="rounded-lg border bg-muted/20 p-3">
              <dt className="text-muted-foreground">{t("currentReservedSpend")}</dt>
              <dd className="mt-1 font-semibold tabular-nums" dir="ltr">
                {usd(aiBudget?.reserved_micros ?? 0)}
              </dd>
            </div>
            <div className="rounded-lg border bg-muted/20 p-3">
              <dt className="text-muted-foreground">{t("currentBudgetCeiling")}</dt>
              <dd className="mt-1 font-semibold tabular-nums" dir="ltr">
                {usd(aiBudget?.budget_limit_micros ?? 0)}
              </dd>
            </div>
          </dl>

          <OperatorActionForm action={updateAiCommercialTerms} submitLabel={t("saveAiCommercialTerms")}>
            <input type="hidden" name="clinicId" value={id} />
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor="includedBudgetUsd">{t("includedBudgetOverrideUsd")}</Label>
                <Input
                  id="includedBudgetUsd"
                  name="includedBudgetUsd"
                  type="number"
                  min="0.000001"
                  max="1000000"
                  step="0.000001"
                  defaultValue={microsToUsdInput(aiTerms?.included_budget_override_micros)}
                  placeholder={t("usePlanAllowance")}
                  dir="ltr"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="addonBudgetUsd">{t("prepaidAddonBudgetUsd")}</Label>
                <Input
                  id="addonBudgetUsd"
                  name="addonBudgetUsd"
                  type="number"
                  min="0"
                  max="1000000"
                  step="0.000001"
                  defaultValue={microsToUsdInput(aiTerms?.addon_budget_micros ?? 0)}
                  required
                  dir="ltr"
                />
              </div>
              <label className="grid gap-1.5 text-sm font-medium">
                {t("overageMode")}
                <select
                  name="overageMode"
                  defaultValue={aiTerms?.overage_mode ?? "hard_cap"}
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="hard_cap">{t("hardCap")}</option>
                  <option value="contracted">{t("contractedOverage")}</option>
                </select>
              </label>
              <div className="grid gap-1.5">
                <Label htmlFor="overageBudgetUsd">{t("contractedOverageBudgetUsd")}</Label>
                <Input
                  id="overageBudgetUsd"
                  name="overageBudgetUsd"
                  type="number"
                  min="0"
                  max="1000000"
                  step="0.000001"
                  defaultValue={microsToUsdInput(aiTerms?.overage_budget_micros ?? 0)}
                  required
                  dir="ltr"
                />
              </div>
              <label className="grid gap-1.5 text-sm font-medium">
                {t("changeReason")}
                <select
                  name="reason"
                  defaultValue={aiTerms?.change_reason ?? "pilot"}
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="pilot">{t("pilot")}</option>
                  <option value="prepaid_addon">{t("prepaidAddon")}</option>
                  <option value="contracted_overage">{t("contractedOverage")}</option>
                  <option value="support_adjustment">{t("supportAdjustment")}</option>
                </select>
              </label>
            </div>
            <p className="text-xs text-muted-foreground">{t("aiCommercialTermsAuditNote")}</p>
          </OperatorActionForm>

          {allowance ? (
            <details className="rounded-lg border p-4 text-sm">
              <summary className="cursor-pointer font-medium">{t("aiAllowanceTechnicalDetail")}</summary>
              <p className="mt-2 text-xs text-muted-foreground">{t("aiAllowanceTechnicalDetailNote")}</p>
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2" dir="ltr">
                <div className="flex justify-between gap-3"><dt>{t("aiAllowancePlanCreditsMicros")}</dt><dd className="tabular-nums">{allowance.plan_included_micros}</dd></div>
                <div className="flex justify-between gap-3"><dt>{t("aiAllowanceOverrideMicros")}</dt><dd className="tabular-nums">{allowance.override_included_micros ?? "—"}</dd></div>
                <div className="flex justify-between gap-3"><dt>{t("aiAllowanceAddonMicros")}</dt><dd className="tabular-nums">{allowance.addon_micros}</dd></div>
                <div className="flex justify-between gap-3"><dt>{t("aiAllowanceOverageMicros")}</dt><dd className="tabular-nums">{allowance.overage_micros}</dd></div>
                <div className="flex justify-between gap-3"><dt>{t("aiAllowanceSpentMicros")}</dt><dd className="tabular-nums">{allowance.managed_spent_micros}</dd></div>
                <div className="flex justify-between gap-3"><dt>{t("aiAllowanceReservedMicros")}</dt><dd className="tabular-nums">{allowance.managed_reserved_micros}</dd></div>
                <div className="flex justify-between gap-3"><dt>{t("aiAllowanceRequestCounter")}</dt><dd className="tabular-nums">{allowance.request_used} / {allowance.request_limit}</dd></div>
              </dl>
            </details>
          ) : null}
        </div>
      </details>
    </>
  );

  const featuresTab = (
    <Section id="feature-overrides" title={t("featureOverrides")} description={t("currentOverridesAreStoredFactsChanges")}>
      <ul className="space-y-2 text-sm">
        {history.overrides.length === 0 ? <li className="text-muted-foreground">{t("noOverridesPlanDefaultsApply")}</li> : null}
        {history.overrides.map((override) => (
          <li key={override.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
            <span><code>{override.feature_key}</code> → {override.enabled ? t("enabled") : t("disabled")}</span>
            <OperatorActionForm action={removeFeatureOverride} submitLabel={t("remove")} submitVariant="outline" className="space-y-1">
              <input type="hidden" name="clinicId" value={id} />
              <input type="hidden" name="featureKey" value={override.feature_key} />
            </OperatorActionForm>
          </li>
        ))}
      </ul>
      <div className="mt-5 border-t pt-4">
        <h3 className="mb-3 text-sm font-medium">{t("setOverride")}</h3>
        <OperatorActionForm action={upsertFeatureOverride} submitLabel={t("saveOverride")}>
          <input type="hidden" name="clinicId" value={id} />
          <div className="flex flex-wrap gap-3">
            <input name="featureKey" placeholder="ai_assistant" className="rounded-md border bg-background px-2 py-1 text-sm" required />
            <select name="enabled" className="rounded-md border bg-background px-2 py-1 text-sm" defaultValue="true">
              <option value="true">{t("enabled")}</option>
              <option value="false">{t("disabled")}</option>
            </select>
          </div>
        </OperatorActionForm>
      </div>
    </Section>
  );

  const historyTab = (
    <>
      <Section id="audit-timeline" title={t("auditTimeline")} description={t("aTimeOrderedMergeOfRecorded")}>
        {history.auditTruncated ? (
          <p className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            {t("theAuditSourceExceeded10000")}</p>
        ) : null}
        {timeline.length === 0 ? <p className="text-sm text-muted-foreground">{t("noRecordedHistoryIsAvailable")}</p> : (
          <ol className="space-y-4">
            {timeline.map((event) => (
              <li key={event.id} className="relative border-s-2 border-border ps-5">
                <span className="absolute -start-[5px] top-1.5 size-2 rounded-full bg-primary" aria-hidden="true" />
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{event.title}</p>
                    {event.detail ? <p className="mt-0.5 text-sm text-muted-foreground">{event.detail}</p> : null}
                  </div>
                  <div className="text-end">
                    <Badge variant="outline">{event.source}</Badge>
                    <p className="mt-1 text-xs tabular-nums text-muted-foreground">{formatTimestamp(event.createdAt)}</p>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section id="invitation-lineage" title={t("invitationLineage")} description={t("lifecycleTimestampsOnlyOwnerContactDetails")}>
        <DataTable
          columns={invitationColumns}
          rows={history.invitations}
          rowKey={(row) => row.id}
          caption={t("clinicInvitationLifecycle")}
          empty={{
            compact: true,
            title: t("noLinkedInvitation"),
            description: t("noLinkedInvitationDescription"),
          }}
        />
      </Section>

      <Section id="coupon-redemptions" title={t("couponRedemptions")} description={t("recordedPromotionApplicationsTiedToThis")}>
        <DataTable
          columns={redemptionColumns}
          rows={history.redemptions}
          rowKey={(row) => row.id}
          caption={t("couponRedemptionsForThisClinic")}
          empty={{
            compact: true,
            title: t("noCouponRedemptions"),
            description: t("noCouponRedemptionsDescription"),
          }}
        />
      </Section>
    </>
  );

  return (
    <>
      <PageHeader
        back={{ href: clinicsUrl, label: "clinics" }}
        breadcrumbs={[
          { label: t("operator"), href: "/operator" },
          { label: t("clinics"), href: clinicsUrl },
          { label: clinic.name },
        ]}
        title={clinic.name}
        description={t("commercialAndOperationalHistoryAssembledWithout")}
      />

      <section aria-labelledby="overview-kpis-title" className="space-y-4">
        <div>
          <h2 id="overview-kpis-title" className="font-semibold">{t("overviewKpis")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("overviewKpisDescription")}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            title={t("kpiPatients")}
            value={formatClinicNumber(metrics.totals.patients, { locale })}
            sub={t("kpiThisMonthValue", { count: formatClinicNumber(metrics.trend.current.patients, { locale }) })}
            icon={Users}
            variant="primary"
            trend={monthTrend(metrics.trend.change.patients)}
          />
          <KpiCard
            title={t("kpiAppointments")}
            value={formatClinicNumber(metrics.totals.appointments, { locale })}
            sub={t("kpiThisMonthValue", { count: formatClinicNumber(metrics.trend.current.appointments, { locale }) })}
            icon={CalendarCheck}
            trend={monthTrend(metrics.trend.change.appointments)}
          />
          <KpiCard
            title={t("kpiDocumentsIssued")}
            value={formatClinicNumber(metrics.totals.documentsIssued, { locale })}
            sub={t("kpiThisMonthValue", { count: formatClinicNumber(metrics.trend.current.documentsIssued, { locale }) })}
            icon={FileText}
            trend={monthTrend(metrics.trend.change.documentsIssued)}
          />
          <KpiCard
            title={t("kpiInvoicesIssued")}
            value={formatClinicNumber(metrics.totals.invoicesIssued, { locale })}
            sub={t("kpiThisMonthValue", { count: formatClinicNumber(metrics.trend.current.invoicesIssued, { locale }) })}
            icon={Receipt}
            trend={monthTrend(metrics.trend.change.invoicesIssued)}
          />
          <KpiCard
            title={t("kpiStaff")}
            value={formatClinicNumber(metrics.totals.activeStaff, { locale })}
            sub={t("kpiStaffSub")}
            icon={UsersRound}
          />
          <KpiCard
            title={t("kpiDepartments")}
            value={formatClinicNumber(metrics.totals.departments, { locale })}
            sub={t("kpiDepartmentsSub")}
            icon={Building2}
          />
          <KpiCard
            title={t("kpiInsuranceCompanies")}
            value={formatClinicNumber(metrics.totals.insuranceCompanies, { locale })}
            sub={t("kpiInsuranceSub")}
            icon={ShieldCheck}
          />
          <KpiCard
            title={t("kpiAiUsage")}
            value={allowance ? `${allowance.used_percent}%` : "—"}
            sub={
              allowance
                ? t("kpiAiUsageAmounts", {
                    used: usd(allowance.managed_spent_micros),
                    allowance: usd(allowance.total_allowance_micros),
                  })
                : t("kpiAiUsageUnavailable")
            }
            icon={Sparkles}
            variant={allowance && allowance.used_percent >= 90 ? "warning" : "default"}
            footer={
              allowance ? (
                <div className="space-y-1.5">
                  <UsageBar
                    percent={allowance.used_percent}
                    label={t("aiAllowancePercentFor", { clinic: clinic.name })}
                    className="h-1.5"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("kpiAiUsageSub", { date: formatDate(allowance.period_reset_at) })}
                  </p>
                </div>
              ) : null
            }
          />
        </div>
      </section>

      <ClinicDetailTabs
        defaultValue={activeTab}
        label={t("clinicDetailSections")}
        tabs={[
          { value: "overview", label: t("tabOverview"), content: overviewTab },
          { value: "subscription", label: t("tabSubscriptionBilling"), content: subscriptionTab },
          { value: "ai-usage", label: t("tabAiUsage"), content: aiUsageTab },
          { value: "features", label: t("tabFeatures"), content: featuresTab },
          { value: "history", label: t("tabHistory"), content: historyTab },
        ]}
      />
    </>
  );
}
