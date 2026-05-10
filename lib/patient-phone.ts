export type PhoneCountry = {
  code: string;
  label: string;
  dialCode: string;
};

export const PHONE_COUNTRIES: PhoneCountry[] = [
  { code: "TR", label: "Turkey", dialCode: "+90" },
  { code: "US", label: "United States", dialCode: "+1" },
  { code: "GB", label: "United Kingdom", dialCode: "+44" },
  { code: "DE", label: "Germany", dialCode: "+49" },
  { code: "FR", label: "France", dialCode: "+33" },
  { code: "AE", label: "United Arab Emirates", dialCode: "+971" },
  { code: "SA", label: "Saudi Arabia", dialCode: "+966" },
  { code: "EG", label: "Egypt", dialCode: "+20" },
  { code: "INTL", label: "International", dialCode: "+" },
];

const E164_REGEX = /^\+[1-9]\d{7,14}$/;

export function normalizePatientPhone(
  value: string,
  countryCode = "TR",
): string | null {
  const raw = value.trim();
  if (!raw) return null;

  if (raw.startsWith("+") || raw.startsWith("00")) {
    const digits = raw.replace(/\D/g, "");
    const internationalDigits = raw.startsWith("00") ? digits.slice(2) : digits;
    const normalized = `+${internationalDigits}`;
    return E164_REGEX.test(normalized) ? normalized : null;
  }

  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  if (countryCode === "TR") {
    if (digits.length === 12 && digits.startsWith("90")) return `+${digits}`;
    if (digits.length === 11 && digits.startsWith("0")) {
      return `+90${digits.slice(1)}`;
    }
    if (digits.length === 10) return `+90${digits}`;
    return null;
  }

  const country = PHONE_COUNTRIES.find((item) => item.code === countryCode);
  if (!country || country.dialCode === "+") return null;

  const normalized = `${country.dialCode}${digits}`;
  return E164_REGEX.test(normalized) ? normalized : null;
}

export function inferPhoneCountry(value: string | null | undefined): string {
  const raw = value?.trim() ?? "";
  if (!raw) return "TR";

  if (!raw.startsWith("+") && !raw.startsWith("00")) return "TR";

  const digits = raw.replace(/\D/g, "");
  const internationalDigits = raw.startsWith("00") ? digits.slice(2) : digits;
  const country = PHONE_COUNTRIES
    .filter((item) => item.code !== "INTL")
    .sort((a, b) => b.dialCode.length - a.dialCode.length)
    .find((item) => internationalDigits.startsWith(item.dialCode.slice(1)));

  return country?.code ?? "INTL";
}

export function formatPatientPhoneForInput(
  value: string | null | undefined,
  countryCode = inferPhoneCountry(value),
): string {
  const raw = value?.trim() ?? "";
  if (!raw) return countryCode === "TR" ? "+90 " : countryPrefix(countryCode);

  if (countryCode === "TR") {
    const normalized = normalizePatientPhone(raw, "TR");
    if (!normalized?.startsWith("+90")) return raw;
    return formatTurkishPhone(normalized.slice(3));
  }

  if (raw.startsWith("+")) return raw;
  if (raw.startsWith("00")) return `+${raw.replace(/\D/g, "").slice(2)}`;
  return `${countryPrefix(countryCode)}${raw}`;
}

export function formatTurkishPhone(digits: string): string {
  const local = digits.replace(/\D/g, "").replace(/^0/, "").slice(0, 10);
  const p1 = local.slice(0, 3);
  const p2 = local.slice(3, 6);
  const p3 = local.slice(6, 8);
  const p4 = local.slice(8, 10);

  let formatted = "+90";
  if (p1) formatted += ` (${p1}`;
  if (p1.length === 3) formatted += ")";
  if (p2) formatted += ` ${p2}`;
  if (p3) formatted += ` ${p3}`;
  if (p4) formatted += ` ${p4}`;
  return formatted;
}

export function formatPhoneInputValue(value: string, countryCode: string): string {
  if (countryCode !== "TR") return value;

  const digits = value.replace(/\D/g, "");
  let local = digits;
  if (local.startsWith("90")) local = local.slice(2);
  if (local.startsWith("0")) local = local.slice(1);
  return formatTurkishPhone(local);
}

function countryPrefix(countryCode: string) {
  const country = PHONE_COUNTRIES.find((item) => item.code === countryCode);
  return country?.dialCode === "+" ? "+" : `${country?.dialCode ?? "+"} `;
}
