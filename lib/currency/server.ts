import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { FxRate } from "@/lib/currency/conversion";
import { composeDisplayMoney } from "@/lib/currency/format";
import type { ClinicLocale } from "@/lib/datetime";

/**
 * Per-request memoized load of the viewer's display currency + FX rows (Pre-P2
 * WS4, closes P15-P3). `cache()` dedupes the two queries across the layout and
 * every converted server page in the same render, so patient-detail / services /
 * packages no longer each add their own pair of queries.
 */
export const loadDisplayContext = cache(async (userId: string) => {
  const supabase = await createClient();
  const [{ data: profile }, { data: rows }] = await Promise.all([
    supabase.from("profiles").select("display_currency").eq("id", userId).single(),
    supabase.from("fx_rates").select("currency_code, rate, provider_timestamp, fetched_at"),
  ]);
  const rates: FxRate[] = (rows ?? []).map((row) => ({
    currencyCode: row.currency_code,
    rate: Number(row.rate),
    providerTimestamp: row.provider_timestamp,
    fetchedAt: row.fetched_at,
  }));
  return { displayCurrency: profile?.display_currency ?? null, rates };
});

export async function getServerMoneyFormatter(userId: string, clinicLocale: ClinicLocale) {
  const { displayCurrency, rates } = await loadDisplayContext(userId);
  const preferred = displayCurrency ?? clinicLocale.currency;
  return (value: number) => composeDisplayMoney(value, clinicLocale, preferred, rates);
}
