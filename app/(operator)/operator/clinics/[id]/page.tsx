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
      title: "Clinic record created",
      detail: clinic.onboarding_completed_at ? "Onboarding later completed" : "Onboarding remains incomplete",
      source: "Recorded fact",
    },
    ...(subscription
      ? [{
          id: `subscription-${subscription.id}`,
          createdAt: subscription.created_at,
          title: "Subscription record created",
          detail: `${subscription.plans?.name_en ?? subscription.plans?.slug ?? "Plan unavailable"} · ${humanize(subscription.status)}${subscription.trial_ends_at ? ` · trial ended ${formatDate(subscription.trial_ends_at)}` : ""}`,
          source: "Recorded fact",
        }]
      : []),
    ...history.invitations.flatMap((invitation) => [
      {
        id: `${invitation.id}-requested`,
        createdAt: invitation.created_at,
        title: "Clinic access requested or invitation record created",
        detail: `Current status: ${humanize(invitation.status)}`,
        source: "Recorded fact",
      },
      ...(invitation.email_sent_at ? [{
        id: `${invitation.id}-email`,
        createdAt: invitation.email_sent_at,
        title: "Invitation email recorded as sent",
        detail: null,
        source: "Recorded fact",
      }] : []),
      ...(invitation.accepted_at ? [{
        id: `${invitation.id}-accepted`,
        createdAt: invitation.accepted_at,
        title: "Invitation accepted",
        detail: null,
        source: "Recorded fact",
      }] : []),
      ...(invitation.revoked_at ? [{
        id: `${invitation.id}-revoked`,
        createdAt: invitation.revoked_at,
        title: "Invitation revoked",
        detail: null,
        source: "Recorded fact",
      }] : []),
    ]),
    ...history.redemptions.map((redemption) => ({
      id: `redemption-${redemption.id}`,
      createdAt: redemption.redeemed_at,
      title: "Coupon redemption recorded",
      detail: redemption.coupons
        ? `${redemption.coupons.code} · ${couponBenefit(redemption.coupons)}`
        : "Coupon record unavailable",
      source: "Recorded fact",
    })),
    ...history.auditEvents.map((event) => ({
      id: `audit-${event.id}`,
      createdAt: event.createdAt,
      title: event.title,
      detail: event.detail,
      source: "Derived from audit log",
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
    { key: "created_at", label: "Requested", render: (row) => formatTimestamp(row.created_at) },
    { key: "status", label: "Current status", render: (row) => <StatusBadge value={row.status} /> },
    { key: "email_sent_at", label: "Email sent", render: (row) => formatTimestamp(row.email_sent_at) },
    { key: "accepted_at", label: "Accepted", render: (row) => formatTimestamp(row.accepted_at) },
    { key: "expires_at", label: "Expiry", render: (row) => formatTimestamp(row.expires_at) },
  ];
  const redemptionColumns: readonly DataTableColumn<(typeof history.redemptions)[number]>[] = [
    { key: "code", label: "Coupon", render: (row) => row.coupons?.code ?? "Unavailable" },
    {
      key: "benefit",
      label: "Benefit",
      render: (row) => row.coupons ? couponBenefit(row.coupons) : "—",
    },
    { key: "redeemed_at", label: "Redeemed", render: (row) => formatTimestamp(row.redeemed_at) },
    {
      key: "is_active",
      label: "Coupon state",
      render: (row) => row.coupons ? (row.coupons.is_active ? "Active" : "Inactive") : "—",
    },
  ];
  const usageColumns: readonly DataTableColumn<(typeof usage.rows)[number]>[] = [
    { key: "period_start", label: "Period", render: (row) => formatDate(row.period_start) },
    { key: "metric", label: "Metric", render: (row) => humanize(row.metric) },
    { key: "used", label: "Used", numeric: true },
    { key: "limit_snapshot", label: "Limit snapshot", numeric: true },
    {
      key: "remaining",
      label: "Remaining",
      numeric: true,
      render: (row) => Math.max(0, row.limit_snapshot - row.used).toLocaleString("en"),
    },
  ];

  return (
    <>
      <PageHeader
        back={{ href: clinicsUrl, label: "clinics" }}
        breadcrumbs={[
          { label: "Operator", href: "/operator" },
          { label: "Clinics", href: clinicsUrl },
          { label: clinic.name },
        ]}
        title={clinic.name}
        description="Commercial and operational history assembled without patient or clinical data."
      />

      <section aria-labelledby="data-honesty-title" className="rounded-xl border border-dashed bg-muted/20 p-5">
        <h2 id="data-honesty-title" className="font-semibold">How to read this record</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          ClinicFlow separates stored facts from reconstructed history and unavailable billing data.
        </p>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {[
            { icon: Database, title: "Recorded fact", text: "Read directly from current platform records and immutable timestamps." },
            { icon: History, title: "Derived from audit log", text: "Reconstructed from recorded operator actions; it is not a complete immutable event ledger." },
            { icon: PlugZap, title: "Future integration", text: "No transaction or contract data is invented where a billing provider is not connected." },
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
        <Section id="clinic-profile" title="Clinic profile" description="Recorded tenant metadata only; no patient or staff records are queried.">
          <dl className="grid gap-x-5 gap-y-3 text-sm sm:grid-cols-2">
            {[
              ["Country", clinic.country],
              ["Timezone", clinic.timezone],
              ["Locale", clinic.locale],
              ["Canonical currency", clinic.currency],
              ["Created", formatTimestamp(clinic.created_at)],
              ["Onboarding", clinic.onboarding_completed_at ? `Completed ${formatTimestamp(clinic.onboarding_completed_at)}` : "Incomplete"],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="mt-0.5 font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-5 border-t pt-4">
            <h3 className="text-sm font-medium">Working-hours summary</h3>
            <ul className="mt-2 grid gap-1 text-sm text-muted-foreground sm:grid-cols-2">
              {workingHours.map((summary) => <li key={summary}>{summary}</li>)}
            </ul>
          </div>
        </Section>

        <Section id="current-subscription" title="Current subscription" description="The subscription table stores one mutable current row, not immutable plan history.">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <dt className="text-muted-foreground">Plan</dt>
            <dd>{subscription?.plans?.name_en ?? subscription?.plans?.slug ?? "—"}</dd>
            <dt className="text-muted-foreground">Status</dt>
            <dd>{subscription ? <StatusBadge value={subscription.status} /> : "Missing"} <span className="text-muted-foreground">({access.reason.replaceAll("_", " ")})</span></dd>
            <dt className="text-muted-foreground">Provider</dt>
            <dd>{subscription?.provider ?? "—"}</dd>
            <dt className="text-muted-foreground">Trial ends</dt>
            <dd>{formatTimestamp(subscription?.trial_ends_at)}</dd>
            <dt className="text-muted-foreground">Period start</dt>
            <dd>{formatTimestamp(subscription?.current_period_start)}</dd>
            <dt className="text-muted-foreground">Period end</dt>
            <dd>{subscription?.current_period_end ? formatTimestamp(subscription.current_period_end) : subscription?.status === "active" ? "Unbounded" : "—"}</dd>
            <dt className="text-muted-foreground">Last row update</dt>
            <dd>{formatTimestamp(subscription?.updated_at)}</dd>
          </dl>

          <div className="mt-5 border-t pt-4">
            <h3 className="mb-3 text-sm font-medium">Manual grant (extends a live period)</h3>
            <OperatorActionForm action={grantManualSubscription} submitLabel="Grant subscription">
              <input type="hidden" name="clinicId" value={id} />
              <div className="flex flex-wrap gap-3">
                <label className="text-sm">
                  Plan{" "}
                  <select name="planSlug" className="rounded-md border bg-background px-2 py-1" defaultValue="basic">
                    {history.plans.map((plan) => <option key={plan.slug} value={plan.slug}>{plan.name_en}</option>)}
                  </select>
                </label>
                <label className="text-sm">
                  Duration{" "}
                  <select name="months" className="rounded-md border bg-background px-2 py-1" defaultValue="1">
                    {[1, 3, 6, 12, 24].map((months) => <option key={months} value={months}>{months} months</option>)}
                    <option value="unbounded">unbounded</option>
                  </select>
                </label>
              </div>
            </OperatorActionForm>
            <div className="mt-4">
              <OperatorActionForm action={cancelManualSubscription} submitLabel="Cancel subscription now" submitVariant="destructive">
                <input type="hidden" name="clinicId" value={id} />
              </OperatorActionForm>
            </div>
          </div>
        </Section>
      </div>

      <Section id="invitation-lineage" title="Invitation lineage" description="Lifecycle timestamps only; owner contact details are intentionally excluded.">
        <DataTable
          columns={invitationColumns}
          rows={history.invitations}
          rowKey={(row) => row.id}
          caption="Clinic invitation lifecycle"
          empty={{ title: "No linked clinic invitation", description: "This clinic may have been created through open registration or an older provisioning flow." }}
        />
      </Section>

      <Section id="coupon-redemptions" title="Coupon redemptions" description="Recorded promotion applications tied to this clinic's subscription.">
        <DataTable
          columns={redemptionColumns}
          rows={history.redemptions}
          rowKey={(row) => row.id}
          caption="Coupon redemptions for this clinic"
          empty={{ title: "No coupon redemptions", description: "No promotion has been recorded against this clinic." }}
        />
      </Section>

      <Section id="feature-overrides" title="Feature overrides" description="Current overrides are stored facts; changes appear in the audit-derived timeline when recorded.">
        <ul className="space-y-2 text-sm">
          {history.overrides.length === 0 ? <li className="text-muted-foreground">No overrides — plan defaults apply.</li> : null}
          {history.overrides.map((override) => (
            <li key={override.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
              <span><code>{override.feature_key}</code> → {override.enabled ? "enabled" : "disabled"}</span>
              <OperatorActionForm action={removeFeatureOverride} submitLabel="Remove" submitVariant="outline" className="space-y-1">
                <input type="hidden" name="clinicId" value={id} />
                <input type="hidden" name="featureKey" value={override.feature_key} />
              </OperatorActionForm>
            </li>
          ))}
        </ul>
        <div className="mt-5 border-t pt-4">
          <h3 className="mb-3 text-sm font-medium">Set override</h3>
          <OperatorActionForm action={upsertFeatureOverride} submitLabel="Save override">
            <input type="hidden" name="clinicId" value={id} />
            <div className="flex flex-wrap gap-3">
              <input name="featureKey" placeholder="ai_assistant" className="rounded-md border bg-background px-2 py-1 text-sm" required />
              <select name="enabled" className="rounded-md border bg-background px-2 py-1 text-sm" defaultValue="true">
                <option value="true">enabled</option>
                <option value="false">disabled</option>
              </select>
            </div>
          </OperatorActionForm>
        </div>
      </Section>

      <Section id="usage-history" title="Usage history" description="Filterable, server-paginated usage counters. Values are limits and counts only.">
        <form method="get" action={`/operator/clinics/${id}`} className="mb-4 flex flex-wrap items-end gap-3">
          {query.returnTo ? <input type="hidden" name="returnTo" value={query.returnTo} /> : null}
          <label className="grid gap-1 text-sm">
            Metric
            <select name="usageMetric" defaultValue={usage.metric} className="min-h-9 rounded-md border bg-background px-3">
              <option value="all">All metrics</option>
              {OPERATOR_CLINIC_USAGE_METRICS.map((metric) => <option key={metric} value={metric}>{humanize(metric)}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Rows per page
            <select name="usagePageSize" defaultValue={String(usage.pageSize)} className="min-h-9 rounded-md border bg-background px-3">
              {OPERATOR_CLINIC_USAGE_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
          <input type="hidden" name="usagePage" value="1" />
          <Button type="submit" size="lg">Apply</Button>
          {usage.metric !== "all" ? <Link href={usageHref(1, "all")} className={buttonVariants({ variant: "outline", size: "lg" })}>Clear filter</Link> : null}
        </form>
        <DataTable
          columns={usageColumns}
          rows={usage.rows}
          rowKey={(row) => row.id}
          caption="Usage counter history"
          stickyHeader
          empty={{
            title: usage.metric === "all" ? "No usage recorded" : "No usage matches this metric",
            description: usage.metric === "all" ? "Counters will appear after metered features are used." : "Clear the metric filter to see all counters.",
          }}
        />
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="text-muted-foreground">{usage.total.toLocaleString("en")} rows · page {usage.page} of {usage.pageCount}</p>
          <nav aria-label="Usage history pagination" className="flex gap-2">
            {usage.page > 1 ? <Link href={usageHref(usage.page - 1)} className={buttonVariants({ variant: "outline" })}>Previous</Link> : null}
            {usage.page < usage.pageCount ? <Link href={usageHref(usage.page + 1)} className={buttonVariants({ variant: "outline" })}>Next</Link> : null}
          </nav>
        </div>
      </Section>

      <Section id="audit-timeline" title="Audit timeline" description="A time-ordered merge of recorded facts and safe operator-action summaries.">
        {history.auditTruncated ? (
          <p className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            The audit source exceeded 10,000 rows. The newest available events are shown; the timeline is not complete.
          </p>
        ) : null}
        {timeline.length === 0 ? <p className="text-sm text-muted-foreground">No recorded history is available.</p> : (
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

      <Section id="payments-contracts" title="Payments & contracts" description="Available after billing integration.">
        <div className="rounded-lg border border-dashed bg-muted/20 p-5 text-sm text-muted-foreground">
          Historical payments, invoices, renewals as transactions, and contract references are not stored by the current manual billing provider. No records are synthesized here.
        </div>
      </Section>
    </>
  );
}
