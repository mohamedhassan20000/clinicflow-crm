import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Database, History, PlugZap } from "lucide-react";
import {
  cancelManualSubscription,
  grantManualSubscription,
  removeFeatureOverride,
  upsertFeatureOverride,
} from "@/actions/operator";
import { OperatorActionForm } from "@/components/operator/operator-action-form";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { resolveSubscriptionAccess } from "@/lib/billing/access";
import { resolveReturnTo } from "@/lib/navigation/return-url";
import {
  getOperatorClinicHistory,
  OPERATOR_CLINIC_USAGE_METRICS,
  OPERATOR_CLINIC_USAGE_PAGE_SIZES,
  parseOperatorClinicUsageParams,
} from "@/lib/supabase/admin";
import { cn } from "@/lib/utils";
import { getLocale, getTranslations } from "next-intl/server";
import { formatClinicNumber } from "@/lib/datetime";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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
  const historyResult = await getOperatorClinicHistory(id, usageParams);
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
    href.set("usageMetric", metric);
    href.set("usagePageSize", String(pageSize));
    href.set("usagePage", String(page));
    return `/operator/clinics/${id}?${href.toString()}#usage-history`;
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
    { key: "metric", label: t("metric"), render: (row) => humanize(row.metric) },
    { key: "used", label: t("used"), numeric: true },
    { key: "limit_snapshot", label: t("limitSnapshot"), numeric: true },
    {
      key: "remaining",
      label: t("remaining"),
      numeric: true,
      render: (row) => Math.max(0, row.limit_snapshot - row.used).toLocaleString("en"),
    },
  ];

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

      <div className="grid gap-6 lg:grid-cols-2">
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

        <Section id="current-subscription" title={t("currentSubscription")} description={t("theSubscriptionTableStoresOneMutable")}>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <dt className="text-muted-foreground">{t("plan")}</dt>
            <dd>{subscription?.plans?.name_en ?? subscription?.plans?.slug ?? "—"}</dd>
            <dt className="text-muted-foreground">{t("status")}</dt>
            <dd>{subscription ? <StatusBadge value={subscription.status} /> : t("missing")} <span className="text-muted-foreground">({access.reason.replaceAll("_", " ")})</span></dd>
            <dt className="text-muted-foreground">{t("provider")}</dt>
            <dd>{subscription?.provider ?? "—"}</dd>
            <dt className="text-muted-foreground">{t("trialEnds")}</dt>
            <dd>{formatTimestamp(subscription?.trial_ends_at)}</dd>
            <dt className="text-muted-foreground">{t("periodStart")}</dt>
            <dd>{formatTimestamp(subscription?.current_period_start)}</dd>
            <dt className="text-muted-foreground">{t("periodEnd")}</dt>
            <dd>{subscription?.current_period_end ? formatTimestamp(subscription.current_period_end) : subscription?.status === "active" ? t("unbounded") : "—"}</dd>
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
            <div className="mt-4">
              <OperatorActionForm action={cancelManualSubscription} submitLabel={t("cancelSubscriptionNow")} submitVariant="destructive">
                <input type="hidden" name="clinicId" value={id} />
              </OperatorActionForm>
            </div>
          </div>
        </Section>
      </div>

      <Section id="invitation-lineage" title={t("invitationLineage")} description={t("lifecycleTimestampsOnlyOwnerContactDetails")}>
        <DataTable
          columns={invitationColumns}
          rows={history.invitations}
          rowKey={(row) => row.id}
          caption={t("clinicInvitationLifecycle")}
          empty={{ title: t("noLinkedInvitation"), description: t("noLinkedInvitationDescription") }}
        />
      </Section>

      <Section id="coupon-redemptions" title={t("couponRedemptions")} description={t("recordedPromotionApplicationsTiedToThis")}>
        <DataTable
          columns={redemptionColumns}
          rows={history.redemptions}
          rowKey={(row) => row.id}
          caption={t("couponRedemptionsForThisClinic")}
          empty={{ title: t("noCouponRedemptions"), description: t("noCouponRedemptionsDescription") }}
        />
      </Section>

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

      <Section id="usage-history" title={t("usageHistory")} description={t("filterableServerPaginatedUsageCountersValues")}>
        <form method="get" action={`/operator/clinics/${id}`} className="mb-4 flex flex-wrap items-end gap-3">
          {query.returnTo ? <input type="hidden" name="returnTo" value={query.returnTo} /> : null}
          <label className="grid gap-1 text-sm">
            {t("metric")}<select name="usageMetric" defaultValue={usage.metric} className="min-h-9 rounded-md border bg-background px-3">
              <option value="all">{t("allMetrics")}</option>
              {OPERATOR_CLINIC_USAGE_METRICS.map((metric) => <option key={metric} value={metric}>{humanize(metric)}</option>)}
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

      <Section id="payments-contracts" title={t("paymentsContracts")} description={t("availableAfterBillingIntegration")}>
        <div className="rounded-lg border border-dashed bg-muted/20 p-5 text-sm text-muted-foreground">
          {t("historicalPaymentsInvoicesRenewalsAsTransactions")}</div>
      </Section>
    </>
  );
}
