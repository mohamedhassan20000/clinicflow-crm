import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import { format as formatDate, startOfWeek } from "date-fns";

export type ClinicLocale = {
  timeZone: string;
  locale: string;
  weekStart: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  timeFormat: "12h" | "24h";
  digits: "latin" | "arabic";
  currency: string;
  country: string;
};

export const DEFAULT_CLINIC_LOCALE: ClinicLocale = {
  timeZone: "Europe/Istanbul",
  locale: "en",
  weekStart: 1,
  timeFormat: "24h",
  digits: "latin",
  currency: "TRY",
  country: "TR",
};

export const DEFAULT_TIME_ZONE = DEFAULT_CLINIC_LOCALE.timeZone;

function resolveLocale(locale?: Partial<ClinicLocale>): ClinicLocale {
  return { ...DEFAULT_CLINIC_LOCALE, ...locale };
}

export type ClinicLocaleRow = {
  timezone?: string | null;
  locale?: string | null;
  week_start?: number | null;
  time_format?: string | null;
  digits?: string | null;
  currency?: string | null;
  country?: string | null;
};

export function clinicLocaleFromRow(row?: ClinicLocaleRow | null): ClinicLocale {
  const weekStart = Number(row?.week_start);
  return {
    timeZone:
      typeof row?.timezone === "string" && row.timezone
        ? row.timezone
        : DEFAULT_CLINIC_LOCALE.timeZone,
    locale:
      typeof row?.locale === "string" && row.locale
        ? row.locale
        : DEFAULT_CLINIC_LOCALE.locale,
    weekStart:
      Number.isInteger(weekStart) && weekStart >= 0 && weekStart <= 6
        ? (weekStart as ClinicLocale["weekStart"])
        : DEFAULT_CLINIC_LOCALE.weekStart,
    timeFormat: row?.time_format === "12h" ? "12h" : "24h",
    digits: row?.digits === "arabic" ? "arabic" : "latin",
    currency:
      typeof row?.currency === "string" && row.currency
        ? row.currency
        : DEFAULT_CLINIC_LOCALE.currency,
    country:
      typeof row?.country === "string" && row.country
        ? row.country
        : DEFAULT_CLINIC_LOCALE.country,
  };
}

export function toNumberingLocale(locale?: Partial<ClinicLocale>): string {
  const resolved = resolveLocale(locale);
  const numberingSystem = resolved.digits === "arabic" ? "arab" : "latn";

  try {
    return new Intl.Locale(resolved.locale, { numberingSystem }).toString();
  } catch {
    return new Intl.Locale(DEFAULT_CLINIC_LOCALE.locale, {
      numberingSystem,
    }).toString();
  }
}

export function formatClinicNumber(
  value: number | null | undefined,
  locale?: Partial<ClinicLocale>,
  options: Intl.NumberFormatOptions = {},
): string {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat(toNumberingLocale(locale), options).format(
    Number.isFinite(n) ? n : 0,
  );
}

export function formatClinicCurrency(
  value: number | null | undefined,
  locale?: Partial<ClinicLocale>,
  options: Intl.NumberFormatOptions = {},
): string {
  const resolved = resolveLocale(locale);
  return formatClinicNumber(value, resolved, {
    style: "currency",
    currency: resolved.currency,
    ...options,
  });
}

export function formatClinicPercent(
  value: number | null | undefined,
  locale?: Partial<ClinicLocale>,
  options: Intl.NumberFormatOptions = {},
): string {
  return `${formatClinicNumber(value, locale, {
    maximumFractionDigits: 1,
    ...options,
  })}%`;
}

export function toClinicTime(
  date: Date | string | number,
  locale?: Partial<ClinicLocale>,
): Date {
  return toZonedTime(date, resolveLocale(locale).timeZone);
}

export function toIstanbul(
  date: Date | string | number,
  locale?: Partial<ClinicLocale>,
): Date {
  return toClinicTime(date, locale);
}

export function formatSlot(
  date: Date | string | number,
  locale?: Partial<ClinicLocale>,
): string {
  return formatInTimeZone(
    date,
    resolveLocale(locale).timeZone,
    "EEE d MMM · HH:mm",
  );
}

export function formatDay(
  date: Date | string | number,
  locale?: Partial<ClinicLocale>,
): string {
  return formatInTimeZone(
    date,
    resolveLocale(locale).timeZone,
    "EEEE, d MMMM yyyy",
  );
}

export function formatTime(
  date: Date | string | number,
  locale?: Partial<ClinicLocale>,
): string {
  return formatInTimeZone(date, resolveLocale(locale).timeZone, "HH:mm");
}

export function startOfClinicWeek(
  date: Date,
  locale?: Partial<ClinicLocale>,
): Date {
  const resolved = resolveLocale(locale);
  return startOfWeek(toClinicTime(date, resolved), {
    weekStartsOn: resolved.weekStart,
  });
}

export function startOfWeekTR(
  date: Date,
  locale?: Partial<ClinicLocale>,
): Date {
  return startOfClinicWeek(date, locale);
}

export function isoDay(
  date: Date | string | number,
  locale?: Partial<ClinicLocale>,
): string {
  return formatInTimeZone(date, resolveLocale(locale).timeZone, "yyyy-MM-dd");
}

// Rough re-export for consistency when no TZ formatting is needed.
export { formatDate };
