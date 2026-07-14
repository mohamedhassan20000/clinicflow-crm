import type { Metadata } from "next";
import { cookies } from "next/headers";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { clinicLocaleFromRow } from "@/lib/datetime";
import { getCurrency } from "@/lib/currency/registry";
import { CurrencyCombobox } from "@/components/settings/currency-combobox";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata: Metadata = { title: "Preferences" };

export default async function PreferencesPage() {
  // Personal, per-user preferences — reachable by every authenticated staff role
  // (Pre-P2 WS4). No admin-only clinic data is read or exposed here.
  const user = await requireUser();
  const supabase = await createClient();
  const cookieStore = await cookies();
  const theme = (cookieStore.get("theme")?.value ?? "light") as "light" | "dark";

  const [{ data: clinic }, { data: profile }] = await Promise.all([
    supabase.from("clinics").select("currency, locale, country, timezone, week_start, digits, time_format").eq("id", user.clinicId).single(),
    supabase.from("profiles").select("display_currency").eq("id", user.id).single(),
  ]);
  const clinicLocale = clinicLocaleFromRow(clinic);
  const canonical = getCurrency(clinicLocale.currency);
  const displayCurrency = profile?.display_currency ?? clinicLocale.currency;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Preferences</h1>
        <p className="text-sm text-muted-foreground">
          Personal settings that affect only your account on ClinicFlow.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Display currency</CardTitle>
          <CardDescription>
            Choose the currency amounts are shown in <strong>to you</strong>, as
            approximate conversions (marked with ≈). This is a personal preference —
            your clinic&rsquo;s records are never changed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CurrencyCombobox value={displayCurrency} />
          <p className="text-sm text-muted-foreground">
            Your clinic&rsquo;s operating currency is{" "}
            <span className="font-medium text-foreground">
              {canonical ? `${canonical.currencyName} (${canonical.code})` : clinicLocale.currency}
            </span>
            . All invoices, payments, and financial records stay in this currency.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>
            Switch between light and dark themes. Your choice is remembered on this
            device.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <ThemeToggle currentTheme={theme} />
          <span className="text-sm text-muted-foreground">
            Currently using {theme === "dark" ? "dark" : "light"} mode
          </span>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Language</CardTitle>
          <CardDescription>
            English is the only language available today. Additional languages are
            coming in a future update.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="inline-flex items-center rounded-md border bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground">
            English (US)
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
