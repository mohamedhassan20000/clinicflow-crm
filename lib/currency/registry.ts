export type CurrencyDefinition = {
  code: string;
  countryCode: string;
  countryName: string;
  currencyName: string;
  flag: string;
  symbol: string;
  minorUnits: number;
};

/**
 * Curated seed: currency code → primary country + ISO 4217 minor units. Each
 * entry is hand-verified and covered by the configured live FX provider
 * (Open Exchange Rates) AND the tested formatting/conversion path (Pre-P2 WS4,
 * resolves former Q5). `countryName`, `currencyName`, `flag`, and `symbol` are DERIVED
 * from `Intl`/regional-indicator arithmetic so only the money-critical fields
 * (code, country, minorUnits) are maintained by hand. Adding a currency is one
 * validated line here — the conversion path is never touched.
 *
 * Minor units follow ISO 4217: 0 for JPY/KRW/…; 3 for the GCC dinars; 2 default.
 */
const CURRENCY_SEED = [
  // Target market (GCC + Egypt + Türkiye), hand-verified since P1.5D
  { code: "KWD", countryCode: "KW", minorUnits: 3 },
  { code: "SAR", countryCode: "SA", minorUnits: 2 },
  { code: "AED", countryCode: "AE", minorUnits: 2 },
  { code: "QAR", countryCode: "QA", minorUnits: 2 },
  { code: "BHD", countryCode: "BH", minorUnits: 3 },
  { code: "OMR", countryCode: "OM", minorUnits: 3 },
  { code: "EGP", countryCode: "EG", minorUnits: 2 },
  { code: "TRY", countryCode: "TR", minorUnits: 2 },
  { code: "JOD", countryCode: "JO", minorUnits: 3 },
  { code: "LBP", countryCode: "LB", minorUnits: 2 },
  { code: "IQD", countryCode: "IQ", minorUnits: 3 },
  { code: "TND", countryCode: "TN", minorUnits: 3 },
  { code: "MAD", countryCode: "MA", minorUnits: 2 },
  // Global majors (all OER-covered, Intl-formattable)
  { code: "USD", countryCode: "US", minorUnits: 2 },
  { code: "EUR", countryCode: "EU", minorUnits: 2 },
  { code: "GBP", countryCode: "GB", minorUnits: 2 },
  { code: "CHF", countryCode: "CH", minorUnits: 2 },
  { code: "CAD", countryCode: "CA", minorUnits: 2 },
  { code: "AUD", countryCode: "AU", minorUnits: 2 },
  { code: "NZD", countryCode: "NZ", minorUnits: 2 },
  { code: "JPY", countryCode: "JP", minorUnits: 0 },
  { code: "CNY", countryCode: "CN", minorUnits: 2 },
  { code: "HKD", countryCode: "HK", minorUnits: 2 },
  { code: "SGD", countryCode: "SG", minorUnits: 2 },
  { code: "INR", countryCode: "IN", minorUnits: 2 },
  { code: "PKR", countryCode: "PK", minorUnits: 2 },
  { code: "BDT", countryCode: "BD", minorUnits: 2 },
  { code: "PHP", countryCode: "PH", minorUnits: 2 },
  { code: "MYR", countryCode: "MY", minorUnits: 2 },
  { code: "IDR", countryCode: "ID", minorUnits: 2 },
  { code: "THB", countryCode: "TH", minorUnits: 2 },
  { code: "KRW", countryCode: "KR", minorUnits: 0 },
  { code: "ZAR", countryCode: "ZA", minorUnits: 2 },
  { code: "NGN", countryCode: "NG", minorUnits: 2 },
  { code: "KES", countryCode: "KE", minorUnits: 2 },
  { code: "BRL", countryCode: "BR", minorUnits: 2 },
  { code: "MXN", countryCode: "MX", minorUnits: 2 },
  { code: "SEK", countryCode: "SE", minorUnits: 2 },
  { code: "NOK", countryCode: "NO", minorUnits: 2 },
  { code: "DKK", countryCode: "DK", minorUnits: 2 },
  { code: "PLN", countryCode: "PL", minorUnits: 2 },
] as const;

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
const currencyNames = new Intl.DisplayNames(["en"], { type: "currency" });

function flagEmoji(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return "🏳️";
  const A = 0x1f1e6;
  return String.fromCodePoint(A + (code.charCodeAt(0) - 65), A + (code.charCodeAt(1) - 65));
}

function currencySymbol(code: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: code,
    currencyDisplay: "narrowSymbol",
  }).formatToParts(0).find((part) => part.type === "currency")?.value ?? code;
}

export const CURRENCIES: readonly CurrencyDefinition[] = CURRENCY_SEED.map((entry) => ({
  code: entry.code,
  countryCode: entry.countryCode,
  minorUnits: entry.minorUnits,
  countryName: regionNames.of(entry.countryCode) ?? entry.countryCode,
  currencyName: currencyNames.of(entry.code) ?? entry.code,
  flag: flagEmoji(entry.countryCode),
  symbol: currencySymbol(entry.code),
}));

/** Symbols requested from the FX provider — the registry IS the coverage list. */
export const CURRENCY_CODES: readonly string[] = CURRENCIES.map((c) => c.code);

export type SupportedCurrency = (typeof CURRENCY_SEED)[number]["code"];

export function getCurrency(code: string) {
  return CURRENCIES.find((currency) => currency.code === code);
}

export function isSupportedCurrency(code: string): code is SupportedCurrency {
  return Boolean(getCurrency(code));
}
