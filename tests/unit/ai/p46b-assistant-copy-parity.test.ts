import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "@/messages/ar.json";
import en from "@/messages/en.json";
import { ASSISTANT_TOOL_PRESENTATION } from "@/lib/ai/tool-presentation";

// P4.6B ships the phase's user-facing copy, and Arabic is a first-class locale
// here rather than a translation afterthought. The two things that actually
// break are asserted: a key that exists in one catalog and not the other, and
// an ICU message whose placeholders or plural categories do not resolve.
//
// Arabic plurals are the real hazard — the language has six categories where
// English has two, and a missing `few`/`many` arm throws only at render time,
// in production, for Arabic users only.

const NEW_ASSISTANT_KEYS = [
  ...Object.values(ASSISTANT_TOOL_PRESENTATION).map((entry) => entry.labelKey),
  "groupFinancial",
  "openFullReport",
  "noticeRangeClamped",
  "noticeTruncated",
  "noticeSuppressed",
  "noticeDistributionWithheld",
  "noticeAllTimeScope",
  "noticeNeedsClarification",
  "errorPermissionNotGranted",
  "errorSubscriptionInactive",
  "financialNotEntitled",
  "financialNotGranted",
  "suggestClinicSummary",
  "suggestTodaysAppointments",
  "suggestNewPatients",
  "suggestNoShowRate",
  "suggestPendingFollowups",
  "suggestRevenue",
  "suggestOutstanding",
  "suggestRunReport",
];

const NEW_SETTINGS_KEYS = [
  "aiFinancialPermissionsTitle",
  "aiFinancialPermissionsDescription",
  "aiFinancialPermissionsNotEntitled",
  "aiFinancialPermissionImplicit",
  "aiFinancialPermissionSaved",
  "aiFinancialPermissionsEmpty",
];

const CATALOGS = { en, ar } as const;

describe("P4.6B copy parity", () => {
  it.each(["en", "ar"] as const)("defines every new assistant key in %s", (locale) => {
    const messages = CATALOGS[locale].assistant as Record<string, string>;
    for (const key of NEW_ASSISTANT_KEYS) {
      expect(messages[key], `assistant.${key} missing from ${locale}`).toBeTruthy();
    }
  });

  it.each(["en", "ar"] as const)("defines every new settings key in %s", (locale) => {
    const messages = CATALOGS[locale].settings as Record<string, string>;
    for (const key of NEW_SETTINGS_KEYS) {
      expect(messages[key], `settings.${key} missing from ${locale}`).toBeTruthy();
    }
  });

  it.each(["en", "ar"] as const)("resolves the parameterized notices in %s", (locale) => {
    const t = createTranslator({
      locale,
      messages: CATALOGS[locale],
      namespace: "assistant",
    });

    expect(t("noticeRangeClamped", { from: "2026-07-01", to: "2026-07-31" })).toContain(
      "2026-07-01",
    );
    expect(t("noticeTruncated", { count: 50 })).toContain("50");
  });

  it.each(["en", "ar"] as const)(
    "resolves the suppression plural across every count in %s",
    (locale) => {
      const t = createTranslator({
        locale,
        messages: CATALOGS[locale],
        namespace: "assistant",
      });

      // Arabic selects a different plural arm at 0, 1, 2, 3–10, and 11+; a
      // missing arm throws rather than degrading, so every category is driven.
      for (const count of [0, 1, 2, 3, 11, 100]) {
        const args = { count, patients: 7, floor: 5 };
        expect(() => t("noticeSuppressed", args)).not.toThrow();
        // Both exact figures must survive every plural arm: how many groups
        // were combined is meaningless without how many patients they cover.
        expect(t("noticeSuppressed", args)).toContain("5");
        expect(t("noticeSuppressed", args)).toContain("7");
      }
    },
  );
});
