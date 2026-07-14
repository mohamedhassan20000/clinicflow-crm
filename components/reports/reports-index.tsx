import Link from "next/link";
import {
  Ban,
  CalendarX2,
  PhoneCall,
  Stethoscope,
  UserRoundCog,
  Wallet,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useTranslations } from "next-intl";

const REPORT_CARDS = [
  {
    titleKey: "cancellationReport",
    descriptionKey: "cancelledAppointmentsByDoctorAndReason",
    href: "/reports/cancellations",
    icon: Ban,
    performance: false,
  },
  {
    titleKey: "noShowReport",
    descriptionKey: "noShowAppointmentRatesByDoctor",
    href: "/reports/no-shows",
    icon: CalendarX2,
    performance: false,
  },
  {
    titleKey: "revenueSalesReport",
    descriptionKey: "collectedPaymentsSettlementsAndBalances",
    href: "/reports/revenue",
    icon: Wallet,
    performance: false,
  },
  {
    titleKey: "followUpsReport",
    descriptionKey: "completedFollowUpOutcomes",
    href: "/reports/follow-ups",
    icon: PhoneCall,
    performance: false,
  },
  {
    titleKey: "doctorPerformanceReport",
    descriptionKey: "doctorSessionsOutcomesRevenueAndShare",
    href: "/reports/doctors",
    icon: Stethoscope,
    performance: true,
  },
  {
    titleKey: "receptionistPerformanceReport",
    descriptionKey: "bookingsAndFollowUpsHandledByReceptionist",
    href: "/reports/receptionists",
    icon: UserRoundCog,
    performance: true,
  },
];

export function ReportsIndex({ canSeePerformanceReports }: { canSeePerformanceReports: boolean }) {
  const t = useTranslations("reports");
  const cards = REPORT_CARDS.filter((card) => canSeePerformanceReports || !card.performance);

  return (
    <div className="space-y-6 print:hidden">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("reports")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("chooseAReportToOpenIts")}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <Link key={card.href} href={card.href} className="group block">
              <Card className="h-full rounded-xl border-border/50 transition-colors hover:border-primary/40 hover:bg-accent/5">
                <CardHeader className="flex-row items-start gap-3 space-y-0">
                  <span className="rounded-lg border border-border/50 bg-background p-2 text-muted-foreground transition-colors group-hover:text-primary">
                    <Icon className="h-5 w-5" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <CardTitle className="text-base">{t(card.titleKey)}</CardTitle>
                    <CardDescription className="mt-1">{t(card.descriptionKey)}</CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="text-sm font-medium text-primary">
                  {t("openReport")}</CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
