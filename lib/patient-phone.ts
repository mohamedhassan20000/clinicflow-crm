import type { CountryCode } from "libphonenumber-js";
import { PHONE_COUNTRIES, formatLocalPhone, inferPhoneCountry, localPhoneValue, normalizePhone } from "@/lib/phone/registry";

export { PHONE_COUNTRIES, inferPhoneCountry };
export function normalizePatientPhone(value: string, countryCode = "TR") { return normalizePhone(value, countryCode as CountryCode); }
export function formatPatientPhoneForInput(value: string | null | undefined, countryCode = inferPhoneCountry(value, "TR")) {
  if (!value) return "";
  const normalized = normalizePhone(value, countryCode);
  if (countryCode === "TR" && normalized?.startsWith("+90")) return formatTurkishPhone(normalized.slice(3));
  return localPhoneValue(value, countryCode);
}
export function formatPhoneInputValue(value: string, countryCode: string) { return formatLocalPhone(value, countryCode as CountryCode); }
export function formatTurkishPhone(value: string) {
  const local = value.replace(/\D/g, "").replace(/^0/, "").slice(0, 10);
  const parts = [local.slice(0, 3), local.slice(3, 6), local.slice(6, 8), local.slice(8, 10)];
  return `+90${parts[0] ? ` (${parts[0]}${parts[0].length === 3 ? ")" : ""}` : ""}${parts[1] ? ` ${parts[1]}` : ""}${parts[2] ? ` ${parts[2]}` : ""}${parts[3] ? ` ${parts[3]}` : ""}`;
}
