import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { getVisiblePageSlugs } from "@/lib/server-page-permissions";
import { getTenantShellNavigation } from "@/lib/dashboard-navigation";
import { ClinicSettingsProvider } from "@/contexts/clinic-settings-context";
import type { TimeFormat } from "@/lib/format-time";
import { clinicLocaleFromRow } from "@/lib/datetime";
import { loadDisplayContext } from "@/lib/currency/server";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  if (user.mustChangePassword) {
    redirect("/change-password");
  }

  const cookieStore = await cookies();
  const theme = (cookieStore.get("theme")?.value ?? "light") as "light" | "dark";
  const visiblePages = await getVisiblePageSlugs(user);

  const supabase = await createClient();
  const { data: clinic } = await supabase
    .from("clinics")
    .select("time_format, timezone, currency, locale, country, week_start, digits")
    .eq("id", user.clinicId)
    .single();

  const timeFormat: TimeFormat =
    clinic?.time_format === "12h" ? "12h" : "24h";
  const clinicLocale = clinicLocaleFromRow(clinic);
  const navItems = getTenantShellNavigation(visiblePages);

  // Shared, request-memoized load (P15-P3): the same cache() the server money
  // formatter uses, so converted pages add no duplicate queries.
  const { displayCurrency: preferred, rates } = await loadDisplayContext(user.id);
  const displayCurrency = preferred ?? clinicLocale.currency;

  return (
    <ClinicSettingsProvider timeFormat={timeFormat} locale={clinicLocale} displayCurrency={displayCurrency} fxRates={rates}>
      <DashboardShell navItems={navItems} user={{ fullName: user.fullName, email: user.email, roleLabel: user.role, avatarUrl: user.avatarUrl, profileHref: "/profile" }} theme={theme}>
        {children}
      </DashboardShell>
    </ClinicSettingsProvider>
  );
}
