"use client";

import {
  DEFAULT_CLINIC_LOCALE,
  formatClinicCurrency,
  formatClinicNumber,
  formatClinicPercent,
  toNumberingLocale,
  type ClinicLocale,
} from "@/lib/datetime";

export function formatNumber(
  value: number | null | undefined,
  locale?: Partial<ClinicLocale>,
) {
  const n = Number(value ?? 0);
  return formatClinicNumber(n, locale, {
    maximumFractionDigits: Number.isInteger(n) ? 0 : 1,
  });
}

export function formatPercent(
  value: number | null | undefined,
  locale?: Partial<ClinicLocale>,
) {
  return formatClinicPercent(value, locale);
}

export function formatCurrency(
  value: number | null | undefined,
  locale?: Partial<ClinicLocale>,
) {
  return formatClinicCurrency(value, locale);
}

export function formatDateRangeLabel(
  from: string,
  to: string,
  locale?: Partial<ClinicLocale>,
) {
  const format = new Intl.DateTimeFormat(toNumberingLocale(locale), {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: locale?.timeZone ?? DEFAULT_CLINIC_LOCALE.timeZone,
  });

  return `${format.format(new Date(`${from}T00:00:00`))} - ${format.format(
    new Date(`${to}T00:00:00`),
  )}`;
}

export function humanizeKey(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
