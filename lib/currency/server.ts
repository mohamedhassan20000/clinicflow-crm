import "server-only";
import { createClient } from "@/lib/supabase/server";
import { convertForDisplay, formatMoney } from "@/lib/currency/conversion";
import { formatClinicCurrency, toNumberingLocale, type ClinicLocale } from "@/lib/datetime";

export async function getServerMoneyFormatter(userId: string, clinicLocale: ClinicLocale) {
  const supabase = await createClient();
  const [{ data: profile }, { data: rows }] = await Promise.all([
    supabase.from("profiles").select("display_currency").eq("id", userId).single(),
    supabase.from("fx_rates").select("currency_code, rate, provider_timestamp, fetched_at"),
  ]);
  const preferred = profile?.display_currency ?? clinicLocale.currency;
  const rates = (rows ?? []).map((row) => ({
    currencyCode: row.currency_code,
    rate: Number(row.rate),
    providerTimestamp: row.provider_timestamp,
    fetchedAt: row.fetched_at,
  }));

  return (value: number) => {
    const money = convertForDisplay(value, clinicLocale.currency, preferred, rates);
    const display = formatMoney(money, toNumberingLocale(clinicLocale));
    return money.approximate
      ? `${display} (${formatClinicCurrency(value, clinicLocale)})`
      : display;
  };
}

