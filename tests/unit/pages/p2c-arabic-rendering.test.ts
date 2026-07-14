import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import ar from "@/messages/ar.json";

function translator(locale: "en" | "ar", messages: unknown, namespace: string) {
  return createTranslator({ locale, messages: messages as never, namespace: namespace as never }) as (
    key: string,
    values?: Record<string, number | string>,
  ) => string;
}

describe("P2C representative English and Arabic rendering", () => {
  it("renders the shell, dashboard, patient, appointment, and operator surfaces in both locales", () => {
    const cases = [
      ["shell", "preferences"],
      ["dashboard", "bookAppointment"],
      ["patients", "newPatient"],
      ["appointments", "newAppointment"],
      ["operator", "missionControl"],
      ["protected", "staffMembers"],
      ["followups", "patientFollowUps"],
      ["reports", "reports"],
      ["revenue", "revenueStatement"],
      ["shared", "close"],
    ] as const;

    const rendered = cases.map(([namespace, key]) => ({
      namespace,
      en: translator("en", en, namespace)(key),
      ar: translator("ar", ar, namespace)(key),
    }));

    expect(rendered).toHaveLength(10);
    for (const item of rendered) {
      expect(item.en).toMatch(/[A-Za-z]/);
      expect(item.ar).toMatch(/[\u0600-\u06ff]/);
      expect(item.ar).not.toBe(item.en);
      expect(item.ar).not.toContain(item.namespace);
    }
  });

  it("preserves ICU variables while localizing runtime values", () => {
    const english = translator("en", en, "operator")("pageOf", { page: 2, totalPages: 5 });
    const arabic = translator("ar", ar, "operator")("pageOf", { page: 2, totalPages: 5 });
    expect(english).toBe("Page 2 of 5");
    expect(arabic).toBe("الصفحة 2 من 5");
  });
});
