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
  const [{ data: profile }, { data: fxRows }] = await Promise.all([
    supabase.from("profiles").select("display_currency").eq("id", user.id).single(),
    supabase.from("fx_rates").select("currency_code, rate, provider_timestamp, fetched_at"),
  ]);

  const timeFormat: TimeFormat =
    clinic?.time_format === "12h" ? "12h" : "24h";
  const clinicLocale = clinicLocaleFromRow(clinic);
  const navItems = getTenantShellNavigation(visiblePages);

  return (
    <ClinicSettingsProvider timeFormat={timeFormat} locale={clinicLocale} displayCurrency={profile?.display_currency ?? clinicLocale.currency} fxRates={(fxRows ?? []).map((row) => ({ currencyCode: row.currency_code, rate: Number(row.rate), providerTimestamp: row.provider_timestamp, fetchedAt: row.fetched_at }))}>
      <DashboardShell navItems={navItems} user={{ fullName: user.fullName, email: user.email, roleLabel: user.role, avatarUrl: user.avatarUrl, profileHref: "/profile" }} theme={theme} displayCurrency={profile?.display_currency ?? clinicLocale.currency}>
        {children}
      </DashboardShell>
    </ClinicSettingsProvider>
  );
}
