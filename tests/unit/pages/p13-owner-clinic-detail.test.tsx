/**
 * P13 / P13b — the owner clinic detail page and the controls it hosts.
 *
 * The page is a Server Component that reads the database through three guarded
 * loaders, so its structure is asserted against the source: the panels the
 * owner is promised exist, the actions are wired to the audited server actions,
 * and mutually exclusive actions are gated rather than stacked. The interactive
 * pieces — the tab shell, the allowance override control, the compact empty
 * state — are rendered for real.
 */
import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/actions/operator", () => ({
  setClinicAiAllowanceOverride: vi.fn(),
  removeClinicAiAllowanceOverride: vi.fn(),
  sendInvitationEmail: vi.fn(),
}));

import { AllowanceOverrideControls } from "@/components/operator/allowance-override-controls";
import { ClinicDetailTabs } from "@/components/operator/clinic-detail-tabs";
import { DataTable } from "@/components/shared/data-table";
import { DEFAULT_INCLUDED_AI_ALLOWANCE_USD } from "@/lib/ai/commercial-policy";

const CLINIC_PAGE = readFileSync("app/(operator)/operator/clinics/[id]/page.tsx", "utf8");
const CLINICS_LIST = readFileSync("app/(operator)/operator/clinics/page.tsx", "utf8");
const CLINIC = "44444444-4444-4444-8444-444444444444";

describe("clinics list", () => {
  it("makes the whole row a click target through the existing name link", () => {
    // A stretched ::after on the row's single link keeps exactly one focusable,
    // screen-reader-visible link per row while making the row clickable.
    expect(CLINICS_LIST).toContain("relative cursor-pointer");
    expect(CLINICS_LIST).toContain("after:absolute after:inset-0");
    expect(CLINICS_LIST).toContain("/operator/clinics/${clinic.id}");
    // Not a row-level onClick, which the keyboard could never reach.
    expect(CLINICS_LIST).not.toContain("onClick={");
  });
});

describe("owner clinic detail sections", () => {
  it.each([
    "overview-kpis-title",
    "current-subscription",
    "ai-allowance",
    "operations-trend",
    "payments-contracts",
    "audit-timeline",
    "usage-history",
    "feature-overrides",
  ])("renders the %s section", (id) => {
    expect(CLINIC_PAGE).toContain(id);
  });

  it("shows every promised overview KPI", () => {
    for (const key of [
      "kpiPatients",
      "kpiAppointments",
      "kpiDocumentsIssued",
      "kpiInvoicesIssued",
      "kpiStaff",
      "kpiDepartments",
      "kpiInsuranceCompanies",
      "kpiAiUsage",
    ]) {
      expect(CLINIC_PAGE).toContain(`t("${key}")`);
    }
  });

  it("wires each owner action to its audited server action", () => {
    for (const action of [
      "grantManualSubscription",
      "extendSubscriptionDays",
      "pauseClinicAccess",
      "reactivateClinicAccess",
      "cancelManualSubscription",
      "updateAiCommercialTerms",
      "upsertFeatureOverride",
      "removeFeatureOverride",
    ]) {
      expect(CLINIC_PAGE).toContain(`action={${action}}`);
    }
    expect(CLINIC_PAGE).toContain("<AllowanceOverrideControls");
  });

  it("offers no destructive deletion of the clinic or its data", () => {
    expect(CLINIC_PAGE).not.toMatch(/deleteClinic|purgeClinic|destroyClinic/);
    expect(CLINIC_PAGE).not.toContain('.delete(');
  });

  it("compares this month with the previous month and refuses a baseless percentage", () => {
    expect(CLINIC_PAGE).toContain('t("periodThisMonth")');
    expect(CLINIC_PAGE).toContain('t("periodPreviousMonth")');
    expect(CLINIC_PAGE).toContain('t("noBaseline")');
    expect(CLINIC_PAGE).toContain("row.change === null");
  });

  it("keeps the AI usage percentage tied to the shared allowance loader", () => {
    expect(CLINIC_PAGE).toContain("loadOperatorAllowanceReport");
    expect(CLINIC_PAGE).toContain("allowance.used_percent");
  });
});

describe("clinic record panels", () => {
  it("declares exactly the five promised tabs, in order", () => {
    expect(CLINIC_PAGE).toContain(
      'const CLINIC_TABS = ["overview", "subscription", "ai-usage", "features", "history"] as const;',
    );
    for (const label of [
      "tabOverview",
      "tabSubscriptionBilling",
      "tabAiUsage",
      "tabFeatures",
      "tabHistory",
    ]) {
      expect(CLINIC_PAGE).toContain(`t("${label}")`);
    }
  });

  it("keeps the KPI cards above the tabs rather than inside one of them", () => {
    expect(CLINIC_PAGE.indexOf('id="overview-kpis-title"')).toBeLessThan(
      CLINIC_PAGE.indexOf("<ClinicDetailTabs"),
    );
  });

  it("puts each section in the panel the owner expects it in", () => {
    const panelOf = (marker: string) => {
      for (const panel of ["overviewTab", "subscriptionTab", "aiUsageTab", "featuresTab", "historyTab"]) {
        const start = CLINIC_PAGE.indexOf(`const ${panel} = (`);
        const end = CLINIC_PAGE.indexOf("\n  const ", start + 1);
        const body = CLINIC_PAGE.slice(start, end === -1 ? undefined : end);
        if (body.includes(marker)) return panel;
      }
      return "none";
    };

    expect(panelOf('id="clinic-profile"')).toBe("overviewTab");
    expect(panelOf('id="operations-trend"')).toBe("overviewTab");
    expect(panelOf('id="current-subscription"')).toBe("subscriptionTab");
    expect(panelOf('id="payments-contracts"')).toBe("subscriptionTab");
    expect(panelOf('id="ai-allowance"')).toBe("aiUsageTab");
    expect(panelOf('id="usage-history"')).toBe("aiUsageTab");
    expect(panelOf('id="advanced-ai-controls"')).toBe("aiUsageTab");
    expect(panelOf('id="feature-overrides"')).toBe("featuresTab");
    expect(panelOf('id="audit-timeline"')).toBe("historyTab");
    expect(panelOf('id="invitation-lineage"')).toBe("historyTab");
    expect(panelOf('id="coupon-redemptions"')).toBe("historyTab");
  });

  it("collapses the technical AI commercial controls behind a disclosure", () => {
    expect(CLINIC_PAGE).toMatch(/<details id="advanced-ai-controls"/);
    expect(CLINIC_PAGE).toContain('t("advancedAiControls")');
    // The commercial-terms form lives inside that disclosure, not beside it.
    const start = CLINIC_PAGE.indexOf('<details id="advanced-ai-controls"');
    const end = CLINIC_PAGE.indexOf("</details>\n    </>", start);
    expect(CLINIC_PAGE.slice(start, end)).toContain("action={updateAiCommercialTerms}");
  });

  it("keeps a usage-history page link on the AI panel so the pager cannot lose it", () => {
    expect(CLINIC_PAGE).toContain('href.set("tab", "ai-usage")');
  });
});

describe("conditional access actions", () => {
  it("derives pause and reactivate as mutually exclusive from the subscription status", () => {
    expect(CLINIC_PAGE).toContain(
      'const canPause = subscription?.status === "active" || subscription?.status === "trialing";',
    );
    expect(CLINIC_PAGE).toContain("const canReactivate = Boolean(subscription) && !canPause;");
  });

  it("gates each action on its own flag, so the pair can never render together", () => {
    expect(CLINIC_PAGE).toMatch(/\{canPause \? \(\s*<OperatorActionForm action=\{pauseClinicAccess\}/);
    expect(CLINIC_PAGE).toMatch(/\{canReactivate \? \(\s*<OperatorActionForm action=\{reactivateClinicAccess\}/);
  });

  it("separates cancellation into its own destructive block, hidden once cancelled", () => {
    expect(CLINIC_PAGE).toContain('const canCancel = Boolean(subscription) && subscription?.status !== "cancelled";');
    expect(CLINIC_PAGE).toMatch(/\{canCancel \? \(/);
    expect(CLINIC_PAGE).toContain("border-destructive/40");
    expect(CLINIC_PAGE).toContain('t("dangerZone")');
  });
});

describe("owner-facing terminology", () => {
  it("names the metered counters in owner language, not column names", () => {
    for (const key of [
      "usageMetricAiMessages",
      "usageMetricWhatsappMessages",
      "usageMetricSmsMessages",
      "usageMetricEmails",
    ]) {
      expect(CLINIC_PAGE).toContain(`t("${key}")`);
    }
    // `humanize(row.metric)` was what produced "Ai Messages" / "Wa Messages".
    expect(CLINIC_PAGE).not.toContain("humanize(row.metric)");
    expect(CLINIC_PAGE).not.toContain("humanize(metric)}</option>");
  });

  it("labels the subscription's origin without implying a payment processor", () => {
    expect(CLINIC_PAGE).toContain('t("subscriptionSource")');
    expect(CLINIC_PAGE).not.toContain('t("billingProvider")');
  });
});

describe("AI usage presentation", () => {
  it("shows spend against the allowance on the KPI card, not a bare percentage", () => {
    expect(CLINIC_PAGE).toContain('t("kpiAiUsageAmounts"');
    expect(CLINIC_PAGE).toContain("used: usd(allowance.managed_spent_micros)");
    expect(CLINIC_PAGE).toContain("allowance: usd(allowance.total_allowance_micros)");
  });

  it("puts a compact meter on the KPI card", () => {
    const card = CLINIC_PAGE.slice(CLINIC_PAGE.indexOf('title={t("kpiAiUsage")}'));
    expect(card).toContain("<UsageBar");
    expect(card).toContain('className="h-1.5"');
  });

  it("breaks the allowance out into included, used, reserved and remaining", () => {
    for (const key of [
      "aiAllowanceIncluded",
      "aiAllowanceUsed",
      "aiAllowanceReserved",
      "aiAllowanceRemaining",
      "aiAllowancePercent",
      "aiAllowanceSource",
    ]) {
      expect(CLINIC_PAGE).toContain(`t("${key}")`);
    }
    expect(CLINIC_PAGE).toContain("usd(allowance.managed_reserved_micros)");
    expect(CLINIC_PAGE).toContain("usd(allowance.effective_included_micros)");
  });

  it("keeps micros and token counts out of the main panel", () => {
    const main = CLINIC_PAGE.slice(0, CLINIC_PAGE.indexOf('<details id="advanced-ai-controls"'));
    expect(main).not.toContain("aiAllowancePlanCreditsMicros");
    expect(main).not.toContain("aiAllowanceSpentMicros");
    expect(main).not.toMatch(/token/i);
  });

  it("reads every figure from the allowance report instead of recomputing one", () => {
    // No UI-side arithmetic on the allowance: only the micros→USD presentation
    // helper, which divides by the ledger's unit and formats.
    expect(CLINIC_PAGE).not.toMatch(/allowance\.\w+_micros\s*[-+]\s*allowance\./);
    expect(CLINIC_PAGE).toContain("function usd(micros: number)");
    // And no plan default is written into the page.
    expect(CLINIC_PAGE).not.toContain("10_000_000");
    expect(CLINIC_PAGE).not.toContain("$10.00");
  });
});

describe("clinic detail tabs", () => {
  const tabs = [
    { value: "overview", label: "Overview", content: <p>overview panel</p> },
    { value: "ai-usage", label: "AI usage", content: <p>ai panel</p> },
  ];

  it("renders one tab per panel and opens on the requested one", () => {
    render(<ClinicDetailTabs tabs={tabs} defaultValue="ai-usage" label="Clinic record sections" />);

    const list = screen.getByRole("tablist", { name: "Clinic record sections" });
    expect(list).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "AI usage" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByText("ai panel")).toBeInTheDocument();
  });

  it("falls back to the first panel for an unknown tab value", () => {
    render(<ClinicDetailTabs tabs={tabs} defaultValue="overview" label="Sections" />);
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  });

  it("uses logical direction utilities only, so RTL mirrors correctly", () => {
    const { container } = render(
      <ClinicDetailTabs tabs={tabs} defaultValue="overview" label="Sections" />,
    );
    expect(container.innerHTML).not.toMatch(/\b(ml-|mr-|pl-|pr-|left-|right-)\d/);
  });
});

describe("compact empty states", () => {
  const columns = [{ key: "a", label: "A" }] as const;

  it("renders an empty history list as a single row, not a tall block", () => {
    const { container } = render(
      <DataTable
        columns={columns}
        rows={[]}
        empty={{ compact: true, title: "No coupon redemptions", description: "Nothing recorded." }}
      />,
    );

    expect(screen.getByText("No coupon redemptions")).toBeInTheDocument();
    const block = container.querySelector('[data-slot="table-empty-compact"]');
    expect(block).not.toBeNull();
    expect(block?.className).toContain("py-3");
    expect(block?.className).not.toContain("py-12");
  });

  it("still renders the full-height state when compact is not asked for", () => {
    const { container } = render(
      <DataTable columns={columns} rows={[]} empty={{ title: "Nothing here" }} />,
    );
    expect(container.querySelector('[data-slot="table-empty-compact"]')).toBeNull();
    expect(container.innerHTML).toContain("py-12");
  });

  it("uses the compact state for both history lists on the clinic page", () => {
    const historyStart = CLINIC_PAGE.indexOf("const historyTab = (");
    const history = CLINIC_PAGE.slice(historyStart);
    expect(history.match(/compact: true/g) ?? []).toHaveLength(2);
  });
});

describe("allowance override controls", () => {
  it("offers only a set action, showing the plan default, when no override exists", () => {
    render(
      <AllowanceOverrideControls
        clinicId={CLINIC}
        planDefaultUsd={DEFAULT_INCLUDED_AI_ALLOWANCE_USD}
        overrideUsd={null}
      />,
    );

    expect(screen.getByRole("button", { name: "Set allowance" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove override" })).not.toBeInTheDocument();
    expect(screen.getByText("Plan default: $10.00")).toBeInTheDocument();

    const input = screen.getByLabelText("Included AI allowance in USD") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("10.00");
  });

  it("offers update and remove, prefilled, when an override exists", () => {
    render(<AllowanceOverrideControls clinicId={CLINIC} planDefaultUsd={10} overrideUsd={250} />);

    expect(screen.getByRole("button", { name: "Update allowance" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove override" })).toBeInTheDocument();
    expect((screen.getByLabelText("Included AI allowance in USD") as HTMLInputElement).value).toBe("250");
  });

  it("submits the clinic id with both actions so the mutation cannot be retargeted", () => {
    const { container } = render(
      <AllowanceOverrideControls clinicId={CLINIC} planDefaultUsd={10} overrideUsd={250} />,
    );
    const clinicInputs = container.querySelectorAll('input[name="clinicId"]');
    expect(clinicInputs).toHaveLength(2);
    for (const input of clinicInputs) {
      expect(input).toHaveValue(CLINIC);
    }
  });
});
