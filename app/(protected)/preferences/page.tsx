import type { Metadata } from "next";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { clinicLocaleFromRow } from "@/lib/datetime";
import { getCurrency } from "@/lib/currency/registry";
import { CurrencyCombobox } from "@/components/settings/currency-combobox";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { LanguageSwitcher } from "@/components/i18n/language-switcher";
import { resolveLocale, resolveTheme } from "@/lib/preferences/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataPreferences") };
}

export default async function PreferencesPage() {
  const t = await getTranslations("protected");
  // Personal, per-user preferences — reachable by every authenticated staff role
  // (Pre-P2 WS4). No admin-only clinic data is read or exposed here.
  const user = await requireUser();
  const supabase = await createClient();
  const [theme, locale, languageT] = await Promise.all([
    resolveTheme(),
    resolveLocale(),
    getTranslations("language"),
  ]);

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
        <h1 className="text-2xl font-semibold tracking-tight">{t("preferences")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("personalSettingsThatAffectOnlyYour")}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("displayCurrency")}</CardTitle>
          <CardDescription>
            {t.rich("displayCurrencyDescription", {
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CurrencyCombobox value={displayCurrency} />
          <p className="text-sm text-muted-foreground">
            {t.rich("clinicOperatingCurrency", {
              currency: canonical
                ? `${canonical.currencyName} (${canonical.code})`
                : clinicLocale.currency,
              strong: (chunks) => <span className="font-medium text-foreground">{chunks}</span>,
            })}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("appearance")}</CardTitle>
          <CardDescription>
            {t("switchBetweenLightAndDarkThemes")}</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <ThemeToggle currentTheme={theme} />
          <span className="text-sm text-muted-foreground">
            {t("currentlyUsingTheme", { theme })}
          </span>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{languageT("label")}</CardTitle>
          <CardDescription>{languageT("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {/*
            P2A: the real per-user language control (§6.A). Scope "account" writes this user's own
            `user_ui_preferences` row — a Doctor on Arabic, a Receptionist on English, and the Owner
            on Arabic can all use the same clinic at once. There is no clinic language.
          */}
          <LanguageSwitcher
            locale={locale}
            scope="account"
            className="w-56"
            labels={{
              selectLabel: languageT("selectLabel"),
              updated: languageT("updated"),
              updateFailed: languageT("updateFailed"),
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
