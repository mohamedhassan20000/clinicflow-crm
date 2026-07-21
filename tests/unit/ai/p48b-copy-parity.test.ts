import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const KEYS = [
  "revenueSheetTitle",
  "revenueSheetDescription",
  "reportsSheetTitle",
  "reportsSheetDescription",
  "invoicesSheetTitle",
  "invoicesSheetDescription",
  "staffSheetTitle",
  "staffSheetDescription",
  "departmentsSheetTitle",
  "departmentsSheetDescription",
  "doctorScheduleSheetTitle",
  "doctorScheduleSheetDescription",
  "suggestVisibleAppointments",
  "suggestVisibleAppointmentStats",
  "suggestVisibleAvailability",
  "suggestVisibleRevenue",
  "suggestCompareVisibleRevenue",
  "suggestVisibleOutstanding",
  "suggestCurrentReport",
  "suggestExplainCurrentReport",
  "suggestInvoiceOutstanding",
  "suggestInvoiceHelp",
  "suggestStaffOverview",
  "suggestStaffHelp",
  "suggestDepartmentOverview",
  "suggestDepartmentHelp",
  "suggestScheduleHelp",
  "currentReportUnavailable",
] as const;

function messages(locale: "ar" | "en") {
  return JSON.parse(
    readFileSync(join(process.cwd(), `messages/${locale}.json`), "utf8"),
  ).assistant as Record<string, string>;
}

describe("P4.8B Arabic and English copy parity", () => {
  it("ships every contextual launcher and suggestion key in both locales", () => {
    const en = messages("en");
    const ar = messages("ar");

    for (const key of KEYS) {
      expect(en[key], `missing English assistant.${key}`).toBeTruthy();
      expect(ar[key], `missing Arabic assistant.${key}`).toBeTruthy();
      expect(ar[key]).not.toBe(en[key]);
    }
  });

  it("keeps interpolation variables identical across locales", () => {
    const en = messages("en");
    const ar = messages("ar");
    for (const key of KEYS) {
      const variables = (value: string) =>
        [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)]
          .map((match) => match[1])
          .sort();
      expect(variables(ar[key])).toEqual(variables(en[key]));
    }
  });
});
