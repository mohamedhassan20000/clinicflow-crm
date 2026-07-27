import Link from "next/link";
import {
  Ban,
  CalendarX2,
  GaugeCircle,
  PhoneCall,
  Stethoscope,
  UserRoundCog,
  Wallet,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslations } from "next-intl";
import type { ClinicReportId } from "@/lib/ai/clinic-reports";
import { REPORT_CATALOG_LIST } from "@/lib/reports/catalog";

/** Icons live here (client) so the catalog stays a plain, import-safe module. */
const REPORT_ICONS: Record<ClinicReportId, LucideIcon> = {
  cancellations: Ban,
  no_shows: CalendarX2,
  revenue: Wallet,
  my_revenue: WalletCards,
  my_performance: GaugeCircle,
  followups: PhoneCall,
  doctor_performance: Stethoscope,
  receptionist_performance: UserRoundCog,
};

/**
 * Fully catalog-driven: cards come from REPORT_CATALOG filtered to the report
 * ids the server resolved this user may open AND see. A new report added to the
 * catalog appears here automatically with no change to this component.
 */
export function ReportsIndex({ visibleReportIds }: { visibleReportIds: ClinicReportId[] }) {
  const t = useTranslations("reports");
  const visible = new Set(visibleReportIds);
  const cards = REPORT_CATALOG_LIST.filter((entry) => visible.has(entry.id));

  return (
    <div className="space-y-6 print:hidden">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("reports")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("chooseAReportToOpenIts")}</p>
      </div>

      {cards.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          {t("noReportsAvailable")}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((card) => {
            const Icon = REPORT_ICONS[card.id];
            return (
              <Link key={card.href} href={card.href} className="group block">
                <Card className="h-full rounded-xl border-border/50 transition-colors hover:border-primary/40 hover:bg-accent/5">
                  <CardHeader className="flex-row items-start gap-3 space-y-0">
                    <span className="rounded-lg border border-border/50 bg-background p-2 text-muted-foreground transition-colors group-hover:text-primary">
                      <Icon className="h-5 w-5" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <CardTitle className="text-base">{t(card.titleKey as never)}</CardTitle>
                      <CardDescription className="mt-1">{t(card.descriptionKey as never)}</CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent className="text-sm font-medium text-primary">
                    {t("openReport")}</CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
