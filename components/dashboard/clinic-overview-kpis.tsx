import {
  Building2,
  CalendarCheck,
  FileText,
  Receipt,
  ShieldCheck,
  Sparkles,
  Users,
  UsersRound,
} from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { UsageBar } from "@/components/shared/usage-bar";
import { getClinicMetrics } from "@/lib/analytics/clinic-metrics";
import { getClinicAiCommercialUsage } from "@/lib/ai/commercial";
import { formatClinicNumber } from "@/lib/datetime";
import { createClient } from "@/lib/supabase/server";

/**
 * Clinic-local overview for the clinic administrator's own dashboard.
 *
 * It shares `getClinicMetrics` with the platform-owner clinic page so the two
 * screens can never disagree about what "documents issued" means — but it reads
 * through the **RLS client**, so the database enforces the clinic boundary in
 * addition to the explicit `clinic_id` filter. Nothing on this card is a
 * platform commercial control: the clinic sees its own activity and its own
 * included-AI position, and never allowances, overrides, plans-as-levers, or
 * anything about another clinic.
 */
export async function ClinicOverviewKpis({ clinicId }: { clinicId: string }) {
  const [t, locale, supabase] = await Promise.all([
    getTranslations("dashboard"),
    getLocale(),
    createClient(),
  ]);

  const metrics = await getClinicMetrics(supabase, clinicId);
  // The AI position is a nice-to-have on this card; a clinic on a plan without
  // the assistant, or an environment where the commercial tables are not yet
  // provisioned, must still get the six activity numbers.
  const aiUsage = await getClinicAiCommercialUsage(clinicId).catch(() => null);

  const number = (value: number) => formatClinicNumber(value, { locale });
  const trend = (change: number | null) =>
    change === null ? undefined : { value: change, label: t("vsPreviousMonth") };

  return (
    <section aria-labelledby="clinic-overview-title" className="space-y-4">
      <div>
        <h2 id="clinic-overview-title" className="text-sm font-semibold">{t("clinicOverview")}</h2>
        <p className="text-sm text-muted-foreground">{t("clinicOverviewDescription")}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          title={t("kpiPatients")}
          value={number(metrics.totals.patients)}
          sub={t("kpiThisMonthValue", { count: number(metrics.trend.current.patients) })}
          icon={Users}
          variant="primary"
          trend={trend(metrics.trend.change.patients)}
        />
        <KpiCard
          title={t("kpiAppointments")}
          value={number(metrics.totals.appointments)}
          sub={t("kpiThisMonthValue", { count: number(metrics.trend.current.appointments) })}
          icon={CalendarCheck}
          trend={trend(metrics.trend.change.appointments)}
        />
        <KpiCard
          title={t("kpiDocumentsIssued")}
          value={number(metrics.totals.documentsIssued)}
          sub={t("kpiThisMonthValue", { count: number(metrics.trend.current.documentsIssued) })}
          icon={FileText}
          trend={trend(metrics.trend.change.documentsIssued)}
        />
        <KpiCard
          title={t("kpiInvoicesIssued")}
          value={number(metrics.totals.invoicesIssued)}
          sub={t("kpiThisMonthValue", { count: number(metrics.trend.current.invoicesIssued) })}
          icon={Receipt}
          trend={trend(metrics.trend.change.invoicesIssued)}
        />
        <KpiCard
          title={t("kpiStaff")}
          value={number(metrics.totals.activeStaff)}
          sub={t("kpiStaffSub")}
          icon={UsersRound}
        />
        <KpiCard
          title={t("kpiDepartments")}
          value={number(metrics.totals.departments)}
          sub={t("kpiDepartmentsSub")}
          icon={Building2}
        />
        <KpiCard
          title={t("kpiInsuranceCompanies")}
          value={number(metrics.totals.insuranceCompanies)}
          sub={t("kpiInsuranceSub")}
          icon={ShieldCheck}
        />
        <div className="space-y-3 rounded-xl border border-border/50 bg-card p-5">
          <div className="flex items-start justify-between">
            <p className="text-sm font-medium text-muted-foreground">{t("kpiAiUsage")}</p>
            <div className="rounded-lg bg-muted p-2 text-muted-foreground">
              <Sparkles className="h-4 w-4" />
            </div>
          </div>
          {aiUsage?.managedAllowanceConfigured ? (
            <>
              <p className="text-3xl font-bold tracking-tight tabular-nums" dir="ltr">
                {aiUsage.usedPercent}%
              </p>
              <UsageBar percent={aiUsage.usedPercent} label={t("kpiAiUsage")} />
              <p className="text-xs text-muted-foreground">
                {t("kpiAiUsageResets", { date: aiUsage.resetDate })}
              </p>
            </>
          ) : (
            <>
              <p className="text-3xl font-bold tracking-tight">—</p>
              <p className="text-xs text-muted-foreground">{t("kpiAiUsageUnavailable")}</p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
