import { describe, expect, it } from "vitest";
import {
  clinicLocaleFromRow,
  formatClinicCurrency,
  startOfClinicWeek,
} from "@/lib/datetime";

describe("clinic locale config", () => {
  it("keeps legacy defaults when clinic config is absent", () => {
    const locale = clinicLocaleFromRow(null);

    expect(locale.currency).toBe("TRY");
    expect(locale.locale).toBe("en");
    expect(locale.weekStart).toBe(1);
    expect(locale.digits).toBe("latin");
    expect(formatClinicCurrency(10, locale)).toContain("TRY");
  });

  it("reads currency, locale, week_start, and digits from the clinic row", () => {
    const locale = clinicLocaleFromRow({
      timezone: "Asia/Riyadh",
      locale: "ar",
      week_start: 6,
      time_format: "24h",
      digits: "arabic",
      currency: "SAR",
      country: "SA",
    });

    expect(locale.currency).toBe("SAR");
    expect(locale.locale).toBe("ar");
    expect(locale.weekStart).toBe(6);
    expect(locale.digits).toBe("arabic");
    expect(formatClinicCurrency(123, locale)).toMatch(/[٠-٩]/);
    expect(startOfClinicWeek(new Date("2026-07-13T12:00:00Z"), locale).getDay()).toBe(6);
  });
});
