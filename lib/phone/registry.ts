import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js";

export type PhoneCountry = { code: CountryCode; name: string; flag: string; dialCode: string };

// Target-market countries pinned to the top of the list (Pre-P2 WS3). Order is
// deliberate; everything else follows alphabetically by English name.
export const PRIORITY_PHONE_COUNTRIES: readonly CountryCode[] = [
  "KW", "SA", "AE", "QA", "BH", "OM", "EG", "TR",
];

// English region names via Intl.DisplayNames — no bundled metadata beyond what
// libphonenumber-js already ships. Localized names are P2 (the component API
// takes a locale but ships English-only now).
const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/** Regional-indicator flag emoji from an ISO 3166-1 alpha-2 code (no assets). */
function flagEmoji(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return "🏳️";
  const A = 0x1f1e6;
  return String.fromCodePoint(
    A + (code.charCodeAt(0) - 65),
    A + (code.charCodeAt(1) - 65),
  );
}

function buildCountry(code: CountryCode): PhoneCountry {
  let dialCode = "";
  try {
    dialCode = `+${getCountryCallingCode(code)}`;
  } catch {
    dialCode = "";
  }
  return {
    code,
    name: regionNames.of(code) ?? code,
    flag: flagEmoji(code),
    dialCode,
  };
}

// Single source of truth: every libphonenumber-supported country, priority group
// first, then the rest alphabetically. Adding/removing a country is a one-line
// change to PRIORITY_PHONE_COUNTRIES — the offerable list itself is derived.
export const PHONE_COUNTRIES: readonly PhoneCountry[] = (() => {
  const all = getCountries();
  const prioritySet = new Set(PRIORITY_PHONE_COUNTRIES);
  const priority = PRIORITY_PHONE_COUNTRIES.filter((code) => all.includes(code)).map(buildCountry);
  const rest = all
    .filter((code) => !prioritySet.has(code))
    .map(buildCountry)
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  return [...priority, ...rest];
})();

const SUPPORTED_CODES = new Set<string>(getCountries());

export function isPhoneCountry(value: string): value is CountryCode {
  return SUPPORTED_CODES.has(value);
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
  // Any valid stored E.164 renders read-normally in its own country — legacy
  // GB/DE/FR… values now round-trip instead of degrading (closes P15D-P4).
  if (parsed?.country === country) return parsed.formatNational();
  if (parsed?.isValid()) return parsed.formatNational();
  try {
    const dialCode = getCountryCallingCode(country);
    return value.replace(new RegExp(`^\\+${dialCode}`), "").trim();
  } catch {
    return value;
  }
}

export function formatLocalPhone(value: string, country: CountryCode) {
  const digits = value.replace(/\D/g, "");
  return new AsYouType(country).input(digits);
}
