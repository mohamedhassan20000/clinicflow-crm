import type { ClinicLocale } from "@/lib/datetime";

/** Documents are bilingual, but their numeric glyphs are always Latin. */
export type DocumentFormatLocale = Pick<
  ClinicLocale,
  "locale" | "timeZone" | "currency" | "timeFormat"
>;

const DEFAULT_DOCUMENT_LOCALE: DocumentFormatLocale = {
  locale: "en",
  timeZone: "Europe/Istanbul",
  currency: "TRY",
  timeFormat: "24h",
};

const ARABIC_INDIC_ZERO = "٠".charCodeAt(0);
const EASTERN_ARABIC_INDIC_ZERO = "۰".charCodeAt(0);

function resolveLocale(
  locale?: Partial<DocumentFormatLocale>,
): DocumentFormatLocale {
  return { ...DEFAULT_DOCUMENT_LOCALE, ...locale };
}

/** Converts Arabic-Indic digits in identifiers/phones supplied as text. */
export function toLatinDigits(value: string | number | bigint): string {
  return String(value).replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    const numeric = code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9
      ? code - ARABIC_INDIC_ZERO
      : code - EASTERN_ARABIC_INDIC_ZERO;
    return String(numeric);
  });
}

/** Locale tag with `nu-latn`, regardless of the clinic digit preference. */
export function documentNumberingLocale(locale = "en"): string {
  try {
    return new Intl.Locale(locale, { numberingSystem: "latn" }).toString();
  } catch {
    return new Intl.Locale("en", { numberingSystem: "latn" }).toString();
  }
}

export function formatDocNumber(
  value: number | bigint | null | undefined,
  locale?: Partial<DocumentFormatLocale>,
  options: Intl.NumberFormatOptions = {},
): string {
  const resolved = resolveLocale(locale);
  const numeric = typeof value === "bigint" ? value : Number(value ?? 0);
  const safe = typeof numeric === "bigint" || Number.isFinite(numeric) ? numeric : 0;
  return toLatinDigits(
    new Intl.NumberFormat(documentNumberingLocale(resolved.locale), {
      numberingSystem: "latn",
      ...options,
    }).format(safe),
  );
}

export function formatDocMoney(
  value: number | null | undefined,
  locale?: Partial<DocumentFormatLocale>,
  options: Intl.NumberFormatOptions = {},
): string {
  const resolved = resolveLocale(locale);
  return formatDocNumber(value, resolved, {
    style: "currency",
    currency: resolved.currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
    ...options,
  });
}

export function formatDocPercent(
  value: number | null | undefined,
  locale?: Partial<DocumentFormatLocale>,
  options: Intl.NumberFormatOptions = {},
): string {
  return formatDocNumber(value, locale, {
    style: "percent",
    maximumFractionDigits: 1,
    ...options,
  });
}

export function formatDocDate(
  value: Date | string | number,
  locale?: Partial<DocumentFormatLocale>,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
): string {
  const resolved = resolveLocale(locale);
  return toLatinDigits(
    new Intl.DateTimeFormat(documentNumberingLocale(resolved.locale), {
      numberingSystem: "latn",
      timeZone: resolved.timeZone,
      ...options,
    }).format(new Date(value)),
  );
}

export function formatDocTime(
  value: Date | string | number,
  locale?: Partial<DocumentFormatLocale>,
  options: Intl.DateTimeFormatOptions = {},
): string {
  const resolved = resolveLocale(locale);
  return formatDocDate(value, resolved, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: resolved.timeFormat === "12h",
    ...options,
  });
}

/** Text identifiers never pass through Intl, but still require Latin digits. */
export function formatDocIdentifier(value: string | number | bigint): string {
  return toLatinDigits(value).trim();
}

export function formatDocumentNumber(input: {
  prefix: string;
  sequence: number | bigint;
  periodKey?: string | null;
  padding?: number;
}): string {
  const padding = Math.min(12, Math.max(1, Math.trunc(input.padding ?? 4)));
  const sequence = toLatinDigits(input.sequence).padStart(padding, "0");
  const period = input.periodKey ? `-${toLatinDigits(input.periodKey)}` : "";
  return `${input.prefix}${period}-${sequence}`;
}
