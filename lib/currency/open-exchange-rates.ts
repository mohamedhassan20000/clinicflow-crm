import "server-only";
import { CURRENCIES } from "@/lib/currency/registry";
import type { FxProvider, FxSnapshot } from "@/lib/currency/provider";

export class OpenExchangeRatesProvider implements FxProvider {
  constructor(private readonly appId = process.env.OPEN_EXCHANGE_RATES_APP_ID, private readonly fetcher: typeof fetch = fetch) {}
  async fetchLatest(): Promise<FxSnapshot> {
    if (!this.appId) throw new Error("FX provider is not configured");
    const symbols = CURRENCIES.map(({ code }) => code).join(",");
    const response = await this.fetcher(`https://openexchangerates.org/api/latest.json?app_id=${encodeURIComponent(this.appId)}&symbols=${symbols}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`FX provider request failed (${response.status})`);
    const payload = await response.json() as { base?: string; timestamp?: number; rates?: Record<string, number> };
    if (payload.base !== "USD" || !payload.timestamp || !payload.rates) throw new Error("FX provider returned an invalid snapshot");
    const rates = Object.fromEntries(CURRENCIES.map(({ code }) => [code, Number(payload.rates?.[code])]).filter(([, rate]) => Number.isFinite(rate) && Number(rate) > 0));
    if (rates.USD !== 1) rates.USD = 1;
    if (Object.keys(rates).length < CURRENCIES.length) throw new Error("FX provider snapshot is incomplete");
    return { baseCurrency: "USD", provider: "open_exchange_rates", providerTimestamp: new Date(payload.timestamp * 1000).toISOString(), fetchedAt: new Date().toISOString(), rates };
  }
}

