import { describe, expect, it, vi } from "vitest";
import { convertForDisplay, formatMoney, FX_STALE_AFTER_MS, FX_SUPPRESS_AFTER_MS } from "@/lib/currency/conversion";
import { CURRENCIES, getCurrency } from "@/lib/currency/registry";
import { OpenExchangeRatesProvider } from "@/lib/currency/open-exchange-rates";

const now = Date.parse("2026-07-12T12:00:00Z");
const rates = (age: number) => [
  { currencyCode: "USD", rate: 1, providerTimestamp: new Date(now - age).toISOString(), fetchedAt: new Date(now - age).toISOString() },
  { currencyCode: "KWD", rate: 0.307, providerTimestamp: new Date(now - age).toISOString(), fetchedAt: new Date(now - age).toISOString() },
  { currencyCode: "JPY", rate: 160, providerTimestamp: new Date(now - age).toISOString(), fetchedAt: new Date(now - age).toISOString() },
];

describe("P1.5D currency conversion", () => {
  it("keeps canonical values and marks presentational conversions approximate", () => {
    const result = convertForDisplay(10, "KWD", "USD", rates(0), now);
    expect(result.canonical).toBe(10);
    expect(result.canonicalCurrency).toBe("KWD");
    expect(result.display).toBeCloseTo(32.5733);
    expect(result.approximate).toBe(true);
    expect(formatMoney(result)).toMatch(/^≈ /);
  });

  it("marks snapshots stale after 48h and suppresses them after 72h", () => {
    expect(convertForDisplay(10, "KWD", "USD", rates(FX_STALE_AFTER_MS + 1), now).stale).toBe(true);
    expect(convertForDisplay(10, "KWD", "USD", rates(FX_SUPPRESS_AFTER_MS + 1), now)).toMatchObject({ display: 10, displayCurrency: "KWD", approximate: false });
  });

  it("preserves KWD and JPY minor units", () => {
    expect(formatMoney(convertForDisplay(1.2345, "KWD", "KWD", [], now))).toContain("1.235");
    expect(formatMoney(convertForDisplay(123.4, "JPY", "JPY", [], now))).not.toContain(".4");
  });

  it("keeps registry metadata in one extensible definition", () => {
    expect(CURRENCIES.map(({ code }) => code)).toEqual(expect.arrayContaining(["USD", "KWD", "SAR", "AED", "EGP", "TRY", "EUR", "GBP", "JPY"]));
    expect(getCurrency("KWD")?.minorUnits).toBe(3);
  });
});

describe("Open Exchange Rates provider", () => {
  it("maps a deterministic USD snapshot without exposing the credential in output", async () => {
    const payloadRates = Object.fromEntries(CURRENCIES.map(({ code }, index) => [code, code === "USD" ? 1 : index + 0.5]));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ base: "USD", timestamp: 1_700_000_000, rates: payloadRates }), { status: 200 }));
    const result = await new OpenExchangeRatesProvider("super-secret", fetcher as typeof fetch).fetchLatest();
    expect(result.baseCurrency).toBe("USD");
    expect(result.provider).toBe("open_exchange_rates");
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  it("fails closed on provider errors so the caller can retain the last snapshot", async () => {
    const fetcher = vi.fn(async () => new Response("no", { status: 503 }));
    await expect(new OpenExchangeRatesProvider("secret", fetcher as typeof fetch).fetchLatest()).rejects.toThrow("FX provider request failed (503)");
  });
});

