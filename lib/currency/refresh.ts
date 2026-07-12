import "server-only";
import { OpenExchangeRatesProvider } from "@/lib/currency/open-exchange-rates";
import type { FxProvider } from "@/lib/currency/provider";
import { storeFxSnapshot } from "@/lib/supabase/admin";

export async function refreshFxRates(provider: FxProvider = new OpenExchangeRatesProvider()) {
  const snapshot = await provider.fetchLatest();
  const { error } = await storeFxSnapshot(snapshot);
  if (error) throw new Error("Unable to store FX snapshot");
  return { provider: snapshot.provider, providerTimestamp: snapshot.providerTimestamp, fetchedAt: snapshot.fetchedAt, currencies: Object.keys(snapshot.rates).length };
}

