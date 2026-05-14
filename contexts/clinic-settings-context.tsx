"use client";

import { createContext, useContext, useState } from "react";
import type { TimeFormat } from "@/lib/format-time";
import { formatTime, formatSlotTime } from "@/lib/format-time";

interface ClinicSettingsContextValue {
  timeFormat: TimeFormat;
  setTimeFormat: (f: TimeFormat) => void;
  formatTime: (date: Date | string) => string;
  formatSlotTime: (slotTime: string) => string;
}

const ClinicSettingsContext = createContext<ClinicSettingsContextValue>({
  timeFormat: "24h",
  setTimeFormat: () => {},
  formatTime: (d) => formatTime(d, "24h"),
  formatSlotTime: (s) => s,
});

export function ClinicSettingsProvider({
  timeFormat: initialFormat,
  children,
}: {
  timeFormat: TimeFormat;
  children: React.ReactNode;
}) {
  const [timeFormat, setTimeFormat] = useState<TimeFormat>(initialFormat);

  return (
    <ClinicSettingsContext.Provider
      value={{
        timeFormat,
        setTimeFormat,
        formatTime: (d) => formatTime(d, timeFormat),
        formatSlotTime: (s) => formatSlotTime(s, timeFormat),
      }}
    >
      {children}
    </ClinicSettingsContext.Provider>
  );
}

export function useClinicSettings() {
  return useContext(ClinicSettingsContext);
}
