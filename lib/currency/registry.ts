export type CurrencyDefinition = {
  code: string;
  countryCode: string;
  countryName: string;
  flag: string;
  minorUnits: number;
};

export const CURRENCIES = [
  { code: "KWD", countryCode: "KW", countryName: "Kuwait", flag: "🇰🇼", minorUnits: 3 },
  { code: "SAR", countryCode: "SA", countryName: "Saudi Arabia", flag: "🇸🇦", minorUnits: 2 },
  { code: "AED", countryCode: "AE", countryName: "United Arab Emirates", flag: "🇦🇪", minorUnits: 2 },
  { code: "QAR", countryCode: "QA", countryName: "Qatar", flag: "🇶🇦", minorUnits: 2 },
  { code: "BHD", countryCode: "BH", countryName: "Bahrain", flag: "🇧🇭", minorUnits: 3 },
  { code: "OMR", countryCode: "OM", countryName: "Oman", flag: "🇴🇲", minorUnits: 3 },
  { code: "EGP", countryCode: "EG", countryName: "Egypt", flag: "🇪🇬", minorUnits: 2 },
  { code: "TRY", countryCode: "TR", countryName: "Türkiye", flag: "🇹🇷", minorUnits: 2 },
  { code: "USD", countryCode: "US", countryName: "United States", flag: "🇺🇸", minorUnits: 2 },
  { code: "EUR", countryCode: "EU", countryName: "Eurozone", flag: "🇪🇺", minorUnits: 2 },
  { code: "GBP", countryCode: "GB", countryName: "United Kingdom", flag: "🇬🇧", minorUnits: 2 },
  { code: "JPY", countryCode: "JP", countryName: "Japan", flag: "🇯🇵", minorUnits: 0 },
] as const satisfies readonly CurrencyDefinition[];

export type SupportedCurrency = (typeof CURRENCIES)[number]["code"];

export function getCurrency(code: string) {
  return CURRENCIES.find((currency) => currency.code === code);
}

export function isSupportedCurrency(code: string): code is SupportedCurrency {
  return Boolean(getCurrency(code));
}

