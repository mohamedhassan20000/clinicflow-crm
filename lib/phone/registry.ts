import { AsYouType, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export type PhoneCountry = { code: CountryCode; name: string; flag: string; dialCode: string };
export const PHONE_COUNTRIES = [
  { code: "KW", name: "Kuwait", flag: "🇰🇼", dialCode: "+965" },
  { code: "SA", name: "Saudi Arabia", flag: "🇸🇦", dialCode: "+966" },
  { code: "AE", name: "United Arab Emirates", flag: "🇦🇪", dialCode: "+971" },
  { code: "QA", name: "Qatar", flag: "🇶🇦", dialCode: "+974" },
  { code: "BH", name: "Bahrain", flag: "🇧🇭", dialCode: "+973" },
  { code: "OM", name: "Oman", flag: "🇴🇲", dialCode: "+968" },
  { code: "EG", name: "Egypt", flag: "🇪🇬", dialCode: "+20" },
  { code: "TR", name: "Türkiye", flag: "🇹🇷", dialCode: "+90" },
  { code: "US", name: "United States", flag: "🇺🇸", dialCode: "+1" },
] as const satisfies readonly PhoneCountry[];

export function isPhoneCountry(value: string): value is CountryCode {
  return PHONE_COUNTRIES.some(({ code }) => code === value);
}

export function inferPhoneCountry(value?: string | null, fallback: CountryCode = "KW"): CountryCode {
  const parsed = value ? parsePhoneNumberFromString(value) : undefined;
  return parsed?.country && isPhoneCountry(parsed.country) ? parsed.country : fallback;
}

export function normalizePhone(value: string, country: string = "KW"): string | null {
  if (!isPhoneCountry(country)) return null;
  const parsed = parsePhoneNumberFromString(value.trim(), country);
  return parsed?.isValid() ? parsed.number : null;
}

export function localPhoneValue(value: string, country: CountryCode): string {
  const parsed = parsePhoneNumberFromString(value, country);
  if (parsed?.country === country) return parsed.formatNational();
  const dialCode = getCountryCallingCode(country);
  return value.replace(new RegExp(`^\\+${dialCode}`), "").trim();
}

export function formatLocalPhone(value: string, country: CountryCode) {
  const digits = value.replace(/\D/g, "");
  return new AsYouType(country).input(digits);
}
