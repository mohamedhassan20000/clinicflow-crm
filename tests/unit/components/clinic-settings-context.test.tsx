import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClinicSettingsProvider, useClinicSettings } from "@/contexts/clinic-settings-context";
import type { ClinicLocale } from "@/lib/datetime";

const gulfArabicLocale: ClinicLocale = {
  timeZone: "Asia/Kuwait",
  locale: "ar",
  weekStart: 6,
  timeFormat: "24h",
  digits: "arabic",
  currency: "KWD",
  country: "KW",
};

function Probe() {
  const {
    formatCurrency,
    formatNumber,
    formatSlotTime,
    locale,
    weekStart,
  } = useClinicSettings();

  return (
    <dl>
      <dt>Currency</dt>
      <dd data-testid="currency">{formatCurrency(12.5)}</dd>
      <dt>Number</dt>
      <dd data-testid="number">{formatNumber(1234)}</dd>
      <dt>Slot</dt>
      <dd data-testid="slot">{formatSlotTime("09:05")}</dd>
      <dt>Week start</dt>
      <dd data-testid="week-start">{weekStart}</dd>
      <dt>Locale currency</dt>
      <dd data-testid="locale-currency">{locale.currency}</dd>
    </dl>
  );
}

describe("ClinicSettingsProvider locale config", () => {
  it("applies per-clinic currency, locale, week start, and digits", () => {
    render(
      <ClinicSettingsProvider timeFormat="24h" locale={gulfArabicLocale}>
        <Probe />
      </ClinicSettingsProvider>,
    );

    expect(screen.getByTestId("currency").textContent).toContain("د.ك");
    expect(screen.getByTestId("currency").textContent).toMatch(/[٠-٩]/);
    expect(screen.getByTestId("number").textContent).toBe("١٬٢٣٤");
    expect(screen.getByTestId("slot").textContent).toBe("٠٩:٠٥");
    expect(screen.getByTestId("week-start").textContent).toBe("6");
    expect(screen.getByTestId("locale-currency").textContent).toBe("KWD");
  });

  it("shows an approximate preferred value beside the untouched canonical value", () => {
    const fetchedAt = new Date().toISOString();
    render(<ClinicSettingsProvider timeFormat="24h" locale={gulfArabicLocale} displayCurrency="USD" fxRates={[
      { currencyCode: "USD", rate: 1, providerTimestamp: fetchedAt, fetchedAt },
      { currencyCode: "KWD", rate: 0.307, providerTimestamp: fetchedAt, fetchedAt },
    ]}><Probe /></ClinicSettingsProvider>);
    const text = screen.getByTestId("currency").textContent ?? "";
    expect(text).toContain("≈");
    expect(text).toContain("US$");
    expect(text).toContain("د.ك");
  });
});
