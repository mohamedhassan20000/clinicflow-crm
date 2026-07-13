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

  // BUG-1 (Pre-P2 WS0): dashboards call formatCurrency({ maximumFractionDigits: 0 })
  // for compact figures; the registry's minimumFractionDigits default must never
  // conflict with a caller override (Intl throws RangeError when min > max).
  it("honors caller fraction-digit overrides without an Intl RangeError", () => {
    const kwd = convertForDisplay(1234.567, "KWD", "KWD", [], now);
    expect(() => formatMoney(kwd, "en", { maximumFractionDigits: 0 })).not.toThrow();
    expect(formatMoney(kwd, "en", { maximumFractionDigits: 0 })).not.toContain(".");
    // Converted path (approximate) with the same override
    const converted = convertForDisplay(10, "KWD", "USD", rates(0), now);
    expect(formatMoney(converted, "en", { maximumFractionDigits: 0 })).toMatch(/^≈ /);
    // Integer/decimal report style: max 1 digit on a 3-minor-unit currency
    expect(() => formatMoney(kwd, "en", { maximumFractionDigits: 1 })).not.toThrow();
    // Caller raising only the minimum must also stay consistent (JPY min 0 default)
    const jpy = convertForDisplay(5, "JPY", "JPY", [], now);
    expect(() => formatMoney(jpy, "en", { minimumFractionDigits: 2 })).not.toThrow();
    // No overrides: registry minor units still apply
    expect(formatMoney(kwd)).toContain("1,234.567");
  });

  it("keeps registry metadata in one extensible definition with derived names/flags", () => {
    expect(CURRENCIES.map(({ code }) => code)).toEqual(expect.arrayContaining(["USD", "KWD", "SAR", "AED", "EGP", "TRY", "EUR", "GBP", "JPY"]));
    expect(getCurrency("KWD")?.minorUnits).toBe(3);
    // WS4: registry expanded well beyond the original 12, still FX-covered
    expect(CURRENCIES.length).toBeGreaterThanOrEqual(30);
    // Every entry has a derived country name, currency name, and flag
    for (const c of CURRENCIES) {
      expect(c.countryName.length).toBeGreaterThan(0);
      expect(c.currencyName.length).toBeGreaterThan(0);
      expect(c.flag.length).toBeGreaterThan(0);
      expect([0, 2, 3]).toContain(c.minorUnits);
    }
    // Money-critical minor units are correct for zero- and three-decimal cases
    expect(getCurrency("JPY")?.minorUnits).toBe(0);
    expect(getCurrency("KRW")?.minorUnits).toBe(0);
    expect(getCurrency("BHD")?.minorUnits).toBe(3);
    expect(getCurrency("OMR")?.minorUnits).toBe(3);
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

