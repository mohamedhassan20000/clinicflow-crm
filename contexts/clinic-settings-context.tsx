"use client";

import { createContext, useContext, useState } from "react";
import type { TimeFormat } from "@/lib/format-time";
import { formatTime, formatSlotTime } from "@/lib/format-time";
import {
  DEFAULT_CLINIC_LOCALE,
  formatClinicCurrency,
  formatClinicCalendarDate,
  formatClinicDate,
  formatClinicDateTime,
  formatClinicNumber,
  formatClinicPercent,
  type ClinicLocale,
} from "@/lib/datetime";
import type { FxRate } from "@/lib/currency/conversion";
import { composeDisplayMoney } from "@/lib/currency/format";

interface ClinicSettingsContextValue {
  timeFormat: TimeFormat;
  locale: ClinicLocale;
  weekStart: ClinicLocale["weekStart"];
  setTimeFormat: (f: TimeFormat) => void;
  formatTime: (date: Date | string) => string;
  formatSlotTime: (slotTime: string) => string;
  formatNumber: (value: number | null | undefined) => string;
  formatPercent: (value: number | null | undefined) => string;
  formatCurrency: (
    value: number | null | undefined,
    options?: Intl.NumberFormatOptions,
  ) => string;
  formatDate: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  formatCalendarDate: (dateIso: string, options?: Intl.DateTimeFormatOptions) => string;
  formatDateTime: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
}

const ClinicSettingsContext = createContext<ClinicSettingsContextValue>({
  timeFormat: "24h",
  locale: DEFAULT_CLINIC_LOCALE,
  weekStart: DEFAULT_CLINIC_LOCALE.weekStart,
  setTimeFormat: () => {},
  formatTime: (d) => formatTime(d, "24h", DEFAULT_CLINIC_LOCALE),
  formatSlotTime: (s) => formatSlotTime(s, "24h", DEFAULT_CLINIC_LOCALE),
  formatNumber: (n) => formatClinicNumber(n, DEFAULT_CLINIC_LOCALE),
  formatPercent: (n) => formatClinicPercent(n, DEFAULT_CLINIC_LOCALE),
  formatCurrency: (n, options) =>
    formatClinicCurrency(n, DEFAULT_CLINIC_LOCALE, options),
  formatDate: (value, options) => formatClinicDate(value, DEFAULT_CLINIC_LOCALE, options),
  formatCalendarDate: (dateIso, options) =>
    formatClinicCalendarDate(dateIso, DEFAULT_CLINIC_LOCALE, options),
  formatDateTime: (value, options) => formatClinicDateTime(value, DEFAULT_CLINIC_LOCALE, options),
});

export function ClinicSettingsProvider({
  timeFormat: initialFormat,
  locale = DEFAULT_CLINIC_LOCALE,
  displayCurrency,
  fxRates = [],
  children,
}: {
  timeFormat: TimeFormat;
  locale?: ClinicLocale;
  displayCurrency?: string;
  fxRates?: readonly FxRate[];
  children: React.ReactNode;
}) {
  const [timeFormat, setTimeFormat] = useState<TimeFormat>(initialFormat);
  const resolvedLocale = { ...DEFAULT_CLINIC_LOCALE, ...locale, timeFormat };
  const preferredCurrency = displayCurrency ?? resolvedLocale.currency;

  return (
    <ClinicSettingsContext.Provider
      value={{
        timeFormat,
        locale: resolvedLocale,
        weekStart: resolvedLocale.weekStart,
        setTimeFormat,
        formatTime: (d) => formatTime(d, timeFormat, resolvedLocale),
        formatSlotTime: (s) => formatSlotTime(s, timeFormat, resolvedLocale),
        formatNumber: (n) => formatClinicNumber(n, resolvedLocale),
        formatPercent: (n) => formatClinicPercent(n, resolvedLocale),
        formatCurrency: (n, options) =>
          composeDisplayMoney(n, resolvedLocale, preferredCurrency, fxRates, options),
        formatDate: (value, options) => formatClinicDate(value, resolvedLocale, options),
        formatCalendarDate: (dateIso, options) =>
          formatClinicCalendarDate(dateIso, resolvedLocale, options),
        formatDateTime: (value, options) => formatClinicDateTime(value, resolvedLocale, options),
      }}
    >
      {children}
    </ClinicSettingsContext.Provider>
  );
}

export function useClinicSettings() {
  return useContext(ClinicSettingsContext);
}
