/**
 * P13 — EN/AR coverage for the owner console and the clinic-admin overview.
 *
 * The bug that started this work was a sidebar rendering the literal string
 * `nav.operator.aiAllowance`, because the item existed in the navigation model
 * and nowhere in either catalog. The first block below is that regression; the
 * rest holds every new key on this feature to real, distinct, non-placeholder
 * copy in both languages.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ar from "@/messages/ar.json";
import en from "@/messages/en.json";
import actionErrorsAr from "@/messages/action-errors/ar.json";
import actionErrorsEn from "@/messages/action-errors/en.json";
import { UsageBar } from "@/components/shared/usage-bar";
import { OPERATOR_SHELL_NAVIGATION } from "@/lib/dashboard-navigation";

const catalogs = { en, ar } as const;
const actionErrorCatalogs = { en: actionErrorsEn, ar: actionErrorsAr } as const;

function lookup(catalog: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (!node || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[key];
  }, catalog);
}

describe("sidebar navigation labels", () => {
  it.each(["en", "ar"] as const)("resolves every operator nav item in %s", (locale) => {
    for (const item of OPERATOR_SHELL_NAVIGATION) {
      const value = lookup(catalogs[locale].nav, item.labelKey);
      expect(typeof value, `nav.${item.labelKey} missing in ${locale}`).toBe("string");
      expect(value).not.toBe("");
      // The regression: a missing key renders the raw dotted key.
      expect(value).not.toContain(item.labelKey);
    }
  });

  it("gives the AI allowance item a short human label in both languages", () => {
    expect(en.nav.operator.aiAllowance).toBe("AI Allowance");
    expect(ar.nav.operator.aiAllowance).toBe("مخصص الذكاء الاصطناعي");
    expect(ar.nav.operator.aiAllowance).not.toBe(en.nav.operator.aiAllowance);
  });
});

const OPERATOR_KEYS = [
  "aiAllowanceDegraded",
  "aiAllowanceDegradedHelp",
  "aiAllowanceUnavailable",
  "aiAllowanceUnavailableHelp",
  "aiAllowancePortfolio",
  "aiAllowanceTotalCommitted",
  "aiAllowanceTotalUsed",
  "aiAllowanceClinicsOnOverride",
  "aiAllowanceClinicsAtRisk",
  "aiAllowanceSource",
  "aiAllowancePlanDefault",
  "aiAllowanceClinicOverride",
  "aiAllowanceActions",
  "aiAllowanceTechnicalDetail",
  "aiAllowanceTechnicalDetailNote",
  "aiAllowanceSetOverride",
  "aiAllowanceUpdateOverride",
  "aiAllowanceRemoveOverride",
  "aiAllowanceOverrideUsd",
  "aiAllowanceSection",
  "aiAllowanceSectionDescription",
  "aiAllowanceOverrideHeading",
  "aiAllowanceRowUnavailable",
  "overviewKpis",
  "overviewKpisDescription",
  "kpiPatients",
  "kpiAppointments",
  "kpiDocumentsIssued",
  "kpiInvoicesIssued",
  "kpiStaff",
  "kpiDepartments",
  "kpiInsuranceCompanies",
  "kpiAiUsage",
  "kpiAiUsageUnavailable",
  "kpiVsPreviousMonth",
  "addExtraDays",
  "addExtraDaysDescription",
  "extendSubscription",
  "extraDays",
  "accessControl",
  "accessControlDescription",
  "pauseAccess",
  "reactivateAccess",
  "operationsTrend",
  "operationsTrendDescription",
  "periodThisMonth",
  "periodPreviousMonth",
  "periodChange",
  "noBaseline",
  "billingAndInvoicing",
  "billingAndInvoicingDescription",
  "currentSubscriptionState",
  "subscriptionSource",
  "billingHistoryScopeNote",
  // P13b — the tabbed clinic record, friendlier metric names, and the split-out
  // allowance figures.
  "tabOverview",
  "tabSubscriptionBilling",
  "tabAiUsage",
  "tabFeatures",
  "tabHistory",
  "clinicDetailSections",
  "aiAllowanceIncluded",
  "aiAllowanceReserved",
  "aiAllowanceSourceIsPlanDefault",
  "aiAllowanceSourceIsClinicOverride",
  "aiAllowanceAutoFallbackOn",
  "advancedAiControls",
  "advancedAiControlsDescription",
  "accessCurrentlyActive",
  "accessCurrentlyPaused",
  "accessControlNoSubscription",
  "dangerZone",
  "dangerZoneDescription",
  "renewsOn",
  "usageMetricAiMessages",
  "usageMetricWhatsappMessages",
  "usageMetricSmsMessages",
  "usageMetricEmails",
];

const DASHBOARD_KEYS = [
  "clinicOverview",
  "clinicOverviewDescription",
  "vsPreviousMonth",
  "kpiPatients",
  "kpiAppointments",
  "kpiDocumentsIssued",
  "kpiInvoicesIssued",
  "kpiStaff",
  "kpiStaffSub",
  "kpiDepartments",
  "kpiDepartmentsSub",
  "kpiInsuranceCompanies",
  "kpiInsuranceSub",
  "kpiAiUsage",
  "kpiAiUsageUnavailable",
];

const ACTION_ERROR_KEYS = [
  "aiAllowanceOverrideCouldNotBeSaved",
  "aiAllowanceOverrideCouldNotBeRemoved",
  "subscriptionIsAlreadyUnbounded",
  "subscriptionCouldNotBeExtended",
  "clinicAccessCouldNotBeChanged",
];

describe.each([
  ["operator", OPERATOR_KEYS],
  ["dashboard", DASHBOARD_KEYS],
] as const)("%s namespace", (namespace, keys) => {
  it.each(keys)(`%s is translated in both languages`, (key) => {
    const english = lookup(catalogs.en[namespace], key);
    const arabic = lookup(catalogs.ar[namespace], key);
    expect(typeof english, `${namespace}.${key} missing in en`).toBe("string");
    expect(typeof arabic, `${namespace}.${key} missing in ar`).toBe("string");
    expect((english as string).trim().length).toBeGreaterThan(0);
    expect((arabic as string).trim().length).toBeGreaterThan(0);
    // Arabic that is byte-identical to English is an untranslated placeholder.
    expect(arabic).not.toBe(english);
    expect(arabic).toMatch(/[؀-ۿ]/);
  });
});

describe("operator action errors", () => {
  it.each(ACTION_ERROR_KEYS)("%s is translated in both languages", (key) => {
    const english = lookup(actionErrorCatalogs.en.operator, key);
    const arabic = lookup(actionErrorCatalogs.ar.operator, key);
    expect(typeof english).toBe("string");
    expect(typeof arabic).toBe("string");
    expect(arabic).not.toBe(english);
    expect(arabic).toMatch(/[؀-ۿ]/);
  });
});

describe("ICU placeholders match across locales", () => {
  const placeholderKeys = [
    ["operator", "aiAllowancePercentFor"],
    ["operator", "aiAllowancePlanDefaultIs"],
    ["operator", "kpiThisMonthValue"],
    ["operator", "kpiAiUsageSub"],
    ["operator", "kpiAiUsageAmounts"],
    ["operator", "renewalDateValue"],
    ["dashboard", "kpiThisMonthValue"],
    ["dashboard", "kpiAiUsageResets"],
  ] as const;

  it.each(placeholderKeys)("%s.%s keeps the same placeholders", (namespace, key) => {
    const names = (value: unknown) =>
      new Set([...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]));
    expect(names(lookup(catalogs.ar[namespace], key))).toEqual(
      names(lookup(catalogs.en[namespace], key)),
    );
  });
});

describe("usage bar", () => {
  it("is an accessible progressbar with a clamped value", () => {
    render(<UsageBar percent={137} label="AI allowance used" />);
    const bar = screen.getByRole("progressbar", { name: "AI allowance used" });
    expect(bar).toHaveAttribute("aria-valuenow", "100");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });

  it("floors a negative percentage at zero rather than rendering a reversed bar", () => {
    render(<UsageBar percent={-20} label="Negative" />);
    expect(screen.getByRole("progressbar", { name: "Negative" })).toHaveAttribute("aria-valuenow", "0");
  });

  it("uses logical direction utilities only, so RTL mirrors correctly", () => {
    const { container } = render(<UsageBar percent={50} label="Half" />);
    expect(container.innerHTML).not.toMatch(/\b(ml-|mr-|pl-|pr-|left-|right-)/);
  });
});

/**
 * P13b — the owner-facing wording, asserted on the copy itself rather than on
 * the key names, because the defect was the copy: "Staff", "Insurance
 * companies", and a billing heading that implied a payment ledger the platform
 * has never had.
 */
describe("owner-facing terminology", () => {
  it("names staff and insurers the way the owner talks about them", () => {
    expect(en.operator.kpiStaff).toBe("Active staff");
    expect(en.operator.kpiInsuranceCompanies).toBe("Configured insurers");
    expect(ar.operator.kpiStaff).not.toBe(en.operator.kpiStaff);
    expect(ar.operator.kpiInsuranceCompanies).not.toBe(en.operator.kpiInsuranceCompanies);
  });

  it("gives every metered counter a readable name in both languages", () => {
    expect(en.operator.usageMetricAiMessages).toBe("AI messages");
    expect(en.operator.usageMetricWhatsappMessages).toBe("WhatsApp messages");
    expect(en.operator.usageMetricEmails).toBe("Emails");
    // The old rendering was the column name in title case.
    for (const value of Object.values(en.operator)) {
      expect(value).not.toBe("Ai Messages");
      expect(value).not.toBe("Wa Messages");
    }
  });

  it("does not claim a payment ledger the platform does not have", () => {
    expect(en.operator.billingAndInvoicing).toBe("Billing summary");
    expect(en.operator.billingAndInvoicingDescription).toMatch(/no payment provider is connected/i);
    expect(en.operator.billingHistoryScopeNote).toMatch(/not a payment ledger/i);
    expect(ar.operator.billingHistoryScopeNote).toMatch(/[؀-ۿ]/);
  });

  it("states the two access states plainly, so only one action needs to be offered", () => {
    expect(en.operator.accessCurrentlyActive).toMatch(/active/i);
    expect(en.operator.accessCurrentlyPaused).toMatch(/paused/i);
  });
});
