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

const REPORT_CARDS = [
  {
    title: "Cancellation Report",
    description: "Cancelled appointments by doctor and reason.",
    href: "/reports/cancellations",
    icon: Ban,
    performance: false,
  },
  {
    title: "No-show Report",
    description: "No-show appointment rates by doctor.",
    href: "/reports/no-shows",
    icon: CalendarX2,
    performance: false,
  },
  {
    title: "Revenue / Sales Report",
    description: "Collected payments, settlements, and balances.",
    href: "/reports/revenue",
    icon: Wallet,
    performance: false,
  },
  {
    title: "Follow-ups Report",
    description: "Completed follow-up outcomes.",
    href: "/reports/follow-ups",
    icon: PhoneCall,
    performance: false,
  },
  {
    title: "Doctor Performance Report",
    description: "Doctor sessions, outcomes, revenue, and share.",
    href: "/reports/doctors",
    icon: Stethoscope,
    performance: true,
  },
  {
    title: "Receptionist Performance Report",
    description: "Bookings and follow-ups handled by receptionist.",
    href: "/reports/receptionists",
    icon: UserRoundCog,
    performance: true,
  },
];

export function ReportsIndex({ canSeePerformanceReports }: { canSeePerformanceReports: boolean }) {
  const cards = REPORT_CARDS.filter((card) => canSeePerformanceReports || !card.performance);

  return (
    <div className="space-y-6 print:hidden">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose a report to open its dedicated filters, print layout, and summary.
        </p>
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
                    <CardTitle className="text-base">{card.title}</CardTitle>
                    <CardDescription className="mt-1">{card.description}</CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="text-sm font-medium text-primary">
                  Open report
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
