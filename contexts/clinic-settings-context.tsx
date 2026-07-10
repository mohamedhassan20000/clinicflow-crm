"use client";

import { createContext, useContext, useState } from "react";
import type { TimeFormat } from "@/lib/format-time";
import { formatTime, formatSlotTime } from "@/lib/format-time";
import {
  DEFAULT_CLINIC_LOCALE,
  formatClinicCurrency,
  formatClinicNumber,
  formatClinicPercent,
  type ClinicLocale,
} from "@/lib/datetime";

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
});

export function ClinicSettingsProvider({
  timeFormat: initialFormat,
  locale = DEFAULT_CLINIC_LOCALE,
  children,
}: {
  timeFormat: TimeFormat;
  locale?: ClinicLocale;
  children: React.ReactNode;
}) {
  const [timeFormat, setTimeFormat] = useState<TimeFormat>(initialFormat);
  const resolvedLocale = { ...DEFAULT_CLINIC_LOCALE, ...locale, timeFormat };

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
          formatClinicCurrency(n, resolvedLocale, options),
      }}
    >
      {children}
    </ClinicSettingsContext.Provider>
  );
}

export function useClinicSettings() {
  return useContext(ClinicSettingsContext);
}
