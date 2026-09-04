import Link from "next/link";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { UsageBar } from "@/components/shared/usage-bar";
import { AllowanceOverrideControls } from "@/components/operator/allowance-override-controls";
import {
  loadOperatorAllowanceReport,
  monthStartUtc,
  nextMonthStartUtc,
  type OperatorAllowanceRow,
} from "@/lib/ai/operator-allowance";
import { requirePlatformAdmin } from "@/lib/rbac";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("operator");
  return { title: t("aiAllowance") };
}

/** Micros are the internal cost unit; the owner console is the one place they belong. */
function usd(micros: number | null | undefined): string {
  const value = (micros ?? 0) / 1_000_000;
  return `$${value.toFixed(2)}`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" })
    .format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}

/**
 * Literal keys, not a template. The i18n gate scans call sites lexically, so a
 * computed `t(\`...${status}\`)` is invisible to it — and an untranslated status
 * badge on the owner console would be found by a human, not by CI.
 */
const STATUS_LABEL_KEYS = {
  healthy: "aiAllowanceStatus_healthy",
  warning: "aiAllowanceStatus_warning",
  critical: "aiAllowanceStatus_critical",
  exhausted: "aiAllowanceStatus_exhausted",
  byok: "aiAllowanceStatus_byok",
  unconfigured: "aiAllowanceStatus_unconfigured",
} as const;

const STATUS_TONE: Record<string, string> = {
  healthy: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
  warning: "border-amber-500/40 text-amber-700 dark:text-amber-400",
  critical: "border-orange-500/50 text-orange-700 dark:text-orange-400",
  exhausted: "border-destructive/50 text-destructive",
  byok: "border-violet-500/40 text-violet-700 dark:text-violet-300",
  unconfigured: "border-border text-muted-foreground",
};

const BAR_TONE: Record<string, "neutral" | "warning" | "critical" | "exhausted"> = {
  healthy: "neutral",
  warning: "warning",
  critical: "critical",
  exhausted: "exhausted",
  byok: "neutral",
  unconfigured: "neutral",
};

function portfolioTotals(rows: readonly OperatorAllowanceRow[]) {
  return rows.reduce(
    (totals, row) => ({
      allowance: totals.allowance + row.total_allowance_micros,
      committed: totals.committed + row.managed_spent_micros + row.managed_reserved_micros,
      overrides: totals.overrides + (row.override_included_micros === null ? 0 : 1),
      atRisk: totals.atRisk + (row.status === "critical" || row.status === "exhausted" ? 1 : 0),
    }),
    { allowance: 0, committed: 0, overrides: 0, atRisk: 0 },
  );
}

/**
 * Platform-owner AI allowance console.
 *
 * The allowance model shown here is deliberately "plan default + optional
 * per-clinic override": the owner sets the number once on the plan, and only
 * touches an individual clinic when that clinic genuinely differs. There is no
 * per-clinic configuration step required to onboard, and no second source of
 * truth — the effective figure in this table is computed by the same SQL the
 * reservation transaction enforces (`operator_ai_allowance_report` and
 * `resolve_ai_commercial_limits_v2` both read the plan limit and the same
 * `ai_commercial_terms` override).
 *
 * No GA price is hardcoded anywhere. `ai_credits_month` on the plan is the knob.
 *
 * When the report cannot be produced, the real database code and message are
 * rendered rather than a generic sentence. The generic sentence is why the cause
 * went unexamined for as long as it did; this screen is seen only by the
 * platform owner, and a diagnostic they can act on beats a reassuring blank.
 */
export default async function OperatorAiAllowancePage() {
  await requirePlatformAdmin();
  const t = await getTranslations("operator");
  const now = new Date();
  const periodStart = monthStartUtc(now);
  const report = await loadOperatorAllowanceReport({
    periodStart,
    periodReset: nextMonthStartUtc(now),
  });
  const rows = report.rows;
  const totals = portfolioTotals(rows);
  const portfolioPercent =
    totals.allowance <= 0 ? 0 : Math.min(100, Math.floor((totals.committed / totals.allowance) * 100));

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-medium text-primary">{t("platformIntelligence")}</p>
        <h1 className="text-3xl font-bold tracking-tight">{t("aiAllowance")}</h1>
        <p className="mt-1 text-muted-foreground">
          {t("aiAllowanceDescription", { period: formatDate(periodStart) })}
        </p>
      </header>

      {report.diagnostic ? (
        <div
          role="alert"
          className={
            report.failed
              ? "space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
              : "space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm"
          }
        >
          <p className="font-medium">
            {report.failed ? t("aiAllowanceUnavailable") : t("aiAllowanceDegraded")}
          </p>
          <p className="text-muted-foreground">
            {report.failed ? t("aiAllowanceUnavailableHelp") : t("aiAllowanceDegradedHelp")}
          </p>
          <p className="font-mono text-xs break-words" dir="ltr">
            {report.diagnostic.code}: {report.diagnostic.message}
            {report.diagnostic.hint ? ` — ${report.diagnostic.hint}` : ""}
          </p>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <section aria-labelledby="allowance-portfolio" className="rounded-xl border bg-card p-5">
          <h2 id="allowance-portfolio" className="text-sm font-medium text-muted-foreground">
            {t("aiAllowancePortfolio")}
          </h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-2xl font-bold tabular-nums" dir="ltr">{usd(totals.allowance)}</p>
              <p className="text-xs text-muted-foreground">{t("aiAllowanceTotalCommitted")}</p>
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums" dir="ltr">{usd(totals.committed)}</p>
              <p className="text-xs text-muted-foreground">{t("aiAllowanceTotalUsed")}</p>
              <UsageBar className="mt-2" percent={portfolioPercent} label={t("aiAllowanceTotalUsed")} />
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums">{totals.overrides}</p>
              <p className="text-xs text-muted-foreground">{t("aiAllowanceClinicsOnOverride")}</p>
            </div>
            <div>
              <p className="text-2xl font-bold tabular-nums">{totals.atRisk}</p>
              <p className="text-xs text-muted-foreground">{t("aiAllowanceClinicsAtRisk")}</p>
            </div>
          </div>
        </section>
      ) : null}

      {rows.length === 0 && !report.failed ? (
        <p className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          {t("aiAllowanceEmpty")}
        </p>
      ) : null}

      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full min-w-[72rem] text-sm">
            <thead className="border-b bg-muted/40 text-start">
              <tr className="[&>th]:px-4 [&>th]:py-3 [&>th]:text-start [&>th]:font-medium">
                <th>{t("aiAllowanceClinic")}</th>
                <th>{t("aiAllowancePlan")}</th>
                <th>{t("aiAllowanceEffective")}</th>
                <th>{t("aiAllowanceSource")}</th>
                <th>{t("aiAllowanceUsed")}</th>
                <th>{t("aiAllowanceRemaining")}</th>
                <th className="min-w-[12rem]">{t("aiAllowancePercent")}</th>
                <th>{t("aiAllowanceByok")}</th>
                <th>{t("aiAllowanceResets")}</th>
                <th>{t("aiAllowanceStatus")}</th>
                <th>{t("aiAllowanceActions")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.clinic_id} className="border-b last:border-0 [&>td]:px-4 [&>td]:py-3 [&>td]:align-top">
                  <td className="font-medium">
                    <Link
                      href={`/operator/clinics/${row.clinic_id}#ai-allowance`}
                      className="underline-offset-2 hover:underline"
                    >
                      {row.clinic_name}
                    </Link>
                  </td>
                  <td className="text-muted-foreground">{row.plan_slug}</td>
                  <td className="tabular-nums" dir="ltr">{usd(row.effective_included_micros)}</td>
                  <td>
                    {row.override_included_micros === null ? (
                      <Badge variant="outline" className="text-muted-foreground">
                        {t("aiAllowancePlanDefault")}
                      </Badge>
                    ) : (
                      <Badge variant="secondary">{t("aiAllowanceClinicOverride")}</Badge>
                    )}
                  </td>
                  <td className="tabular-nums" dir="ltr">
                    {usd(row.managed_spent_micros)}
                    {row.managed_reserved_micros > 0 ? (
                      <span className="ms-1 text-xs text-muted-foreground">
                        (+{usd(row.managed_reserved_micros)})
                      </span>
                    ) : null}
                  </td>
                  <td className="tabular-nums" dir="ltr">{usd(row.remaining_micros)}</td>
                  <td>
                    <div className="flex items-center gap-2">
                      <UsageBar
                        percent={row.used_percent}
                        tone={BAR_TONE[row.status] ?? "neutral"}
                        label={t("aiAllowancePercentFor", { clinic: row.clinic_name })}
                        className="min-w-24"
                      />
                      <span className="tabular-nums text-xs" dir="ltr">{row.used_percent}%</span>
                    </div>
                  </td>
                  <td className="text-xs">
                    <div className="flex flex-col gap-0.5">
                      <span>
                        {row.byok_configured ? t("aiAllowanceByokConfigured") : t("aiAllowanceByokMissing")}
                      </span>
                      <span className="text-muted-foreground" dir="ltr">
                        {row.credential_mode} · {usd(row.byok_spent_micros)}
                      </span>
                      {!row.auto_byok_fallback_enabled ? (
                        <span className="text-amber-700 dark:text-amber-400">
                          {t("aiAllowanceAutoFallbackOff")}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="text-muted-foreground">{formatDate(row.period_reset_at)}</td>
                  <td>
                    <Badge variant="outline" className={STATUS_TONE[row.status] ?? STATUS_TONE.unconfigured}>
                      {t(
                        STATUS_LABEL_KEYS[row.status as keyof typeof STATUS_LABEL_KEYS] ??
                          STATUS_LABEL_KEYS.unconfigured,
                      )}
                    </Badge>
                  </td>
                  <td className="min-w-[16rem]">
                    <AllowanceOverrideControls
                      clinicId={row.clinic_id}
                      planDefaultUsd={row.plan_included_micros / 1_000_000}
                      overrideUsd={
                        row.override_included_micros === null ? null : row.override_included_micros / 1_000_000
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <details className="rounded-xl border bg-card p-5 text-sm">
          <summary className="cursor-pointer font-medium">{t("aiAllowanceTechnicalDetail")}</summary>
          <p className="mt-2 text-xs text-muted-foreground">{t("aiAllowanceTechnicalDetailNote")}</p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[56rem] text-xs">
              <thead className="border-b text-start">
                <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-start [&>th]:font-medium">
                  <th>{t("aiAllowanceClinic")}</th>
                  <th>{t("aiAllowancePlanCreditsMicros")}</th>
                  <th>{t("aiAllowanceOverrideMicros")}</th>
                  <th>{t("aiAllowanceAddonMicros")}</th>
                  <th>{t("aiAllowanceOverageMicros")}</th>
                  <th>{t("aiAllowanceSpentMicros")}</th>
                  <th>{t("aiAllowanceReservedMicros")}</th>
                  <th>{t("aiAllowanceRequestCounter")}</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {rows.map((row) => (
                  <tr key={row.clinic_id} className="border-b last:border-0 [&>td]:px-3 [&>td]:py-2">
                    <td>{row.clinic_name}</td>
                    <td dir="ltr">{row.plan_included_micros}</td>
                    <td dir="ltr">{row.override_included_micros ?? "—"}</td>
                    <td dir="ltr">{row.addon_micros}</td>
                    <td dir="ltr">{row.overage_micros}</td>
                    <td dir="ltr">{row.managed_spent_micros}</td>
                    <td dir="ltr">{row.managed_reserved_micros}</td>
                    <td dir="ltr">{row.request_used} / {row.request_limit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      <p className="text-xs text-muted-foreground">{t("aiAllowanceFootnote")}</p>
    </div>
  );
}
