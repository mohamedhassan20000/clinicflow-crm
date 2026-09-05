import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

async function loadAdapter(locale: "en" | "ar") {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  vi.doMock("next-intl/server", () => ({
    getTranslations: async (namespace: string) => (key: string, values?: Record<string, unknown>) => {
      if (namespace === "validation") return `${locale}:validation:${key}`;
      if (namespace === "shared") {
        const weekdays = locale === "ar"
          ? ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"]
          : ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        return weekdays[Number(key.replace("weekday", ""))] ?? key;
      }
      return `${locale}:translated:${String(values?.day ?? "")}`;
    },
  }));
  return import("@/actions/_domain");
}

describe("Phase 5 domain failure adapter", () => {
  it("always supplies a top-level error for validation failures in every converted family", async () => {
    const { domainFailureToActionResult } = await loadAdapter("en");
    const validationError = z.object({ name: z.string().min(2) }).safeParse({
      name: "",
    });
    if (validationError.success) throw new Error("negative control must fail");

    for (const code of [
      "appointments.failedToCreateAppointment",
      "followups.missingFollowUp",
      "patients.failedToCreatePatientPleaseTryAgain",
      "clinical.validationError",
      "billing.validationError",
      "settings.validationError",
    ]) {
      const result = await domainFailureToActionResult({
        ok: false,
        code,
        validationError: validationError.error,
      });
      expect(result.error, code).toBeTruthy();
      expect(result.fieldErrors?.name?.[0], code).toBeTruthy();
    }
  });

  it("localizes coded field errors and never exposes dotted action-error keys", async () => {
    const { domainFailureToActionResult } = await loadAdapter("en");
    const result = await domainFailureToActionResult({
      ok: false,
      code: "settings.invoiceFollowupSecondAfterFirst",
      fieldErrorCodes: {
        second_days: ["settings.invoiceFollowupSecondAfterFirst"],
      },
    });
    expect(result.error).toBe("en:translated:");
    expect(JSON.stringify(result.fieldErrors)).not.toMatch(
      /settings\.invoiceFollowupSecondAfterFirst/,
    );
  });

  it.each([
    ["en" as const, "Wednesday"],
    ["ar" as const, "الأربعاء"],
  ])("renders a weekday name rather than a digit in %s", async (locale, day) => {
    const { domainFailureToActionResult } = await loadAdapter(locale);
    const result = await domainFailureToActionResult({
      ok: false,
      code: "appointments.clinicClosedOnDay",
      values: { day: 3 },
    });
    expect(result.error).toContain(day);
    expect(result.error).not.toContain(":3");
  });
});
