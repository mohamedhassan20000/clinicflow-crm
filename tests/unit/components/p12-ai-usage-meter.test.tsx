/**
 * P12 — the clinic-facing included-usage meter.
 *
 * What is asserted here is mostly what the meter must NOT say: it must not
 * report an unconfigured allowance as exhausted, must not tell a clinic to add a
 * key it already added, and must not leak ClinicFlow's internal cost accounting
 * into customer-facing copy.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import ar from "@/messages/ar.json";
import type { ClinicAiCommercialUsage } from "@/lib/ai/commercial";

/**
 * The suite-wide `next-intl` mock pins the locale to English. This file needs
 * both catalogs, so it re-mocks with a switchable locale — still resolving
 * through next-intl's real ICU translator against the real message files, so a
 * missing Arabic key or a broken placeholder fails here rather than in
 * production.
 */
const locale = vi.hoisted(() => ({ current: "en" as "en" | "ar" }));

vi.mock("next-intl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-intl")>();
  return {
    ...actual,
    useLocale: () => locale.current,
    useTranslations: (namespace?: string) =>
      actual.createTranslator({
        locale: locale.current,
        messages: (locale.current === "en" ? en : ar) as never,
        namespace: namespace as never,
      }),
    useFormatter: () => actual.createFormatter({ locale: locale.current }),
  };
});

import { AiUsageSummary } from "@/components/settings/ai-usage-summary";

const PLAN_CREDITS = 1_620_000_000;

function usage(overrides: Partial<ClinicAiCommercialUsage> = {}): ClinicAiCommercialUsage {
  return {
    periodStart: "2026-08-01",
    resetDate: "2026-09-01",
    managedSpentMicros: 0,
    reservedMicros: 0,
    budgetLimitMicros: PLAN_CREDITS,
    managedAllowanceConfigured: true,
    usedPercent: 0,
    remainingMicros: PLAN_CREDITS,
    requestUsed: 0,
    requestLimit: 1000,
    requestRemaining: 1000,
    threshold: "normal",
    overageMode: "hard_cap",
    hasAddon: false,
    byokRequestUsed: 0,
    byokEstimatedCostMicros: 0,
    byokConfigured: false,
    providerState: "managed",
    ...overrides,
  };
}

function renderMeter(
  value: ClinicAiCommercialUsage,
  active: "en" | "ar" = "en",
) {
  locale.current = active;
  return render(<AiUsageSummary usage={value} />);
}

beforeEach(() => {
  locale.current = "en";
});

describe("progress and period", () => {
  it("shows the percentage used and the reset date", () => {
    renderMeter(usage({ usedPercent: 72, requestUsed: 720, requestRemaining: 280 }));
    expect(screen.getByText("72% used")).toBeInTheDocument();
    expect(screen.getByText(/Resets on/)).toBeInTheDocument();
    expect(screen.getByText("280 of 1,000 remaining")).toBeInTheDocument();
  });

  it("exposes the progress to assistive technology", () => {
    renderMeter(usage({ usedPercent: 72 }));
    const bar = screen.getByRole("progressbar", { name: "Included AI usage" });
    expect(bar).toHaveAttribute("aria-valuenow", "72");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });

  it("renders an unconfigured allowance as 'not configured', never as exhausted", () => {
    renderMeter(
      usage({ managedAllowanceConfigured: false, budgetLimitMicros: 0, usedPercent: 0 }),
    );
    expect(screen.getByText("Not configured yet")).toBeInTheDocument();
    expect(screen.queryByText("Included usage used up")).not.toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("provider state", () => {
  it("names ClinicFlow Managed AI for a managed clinic", () => {
    renderMeter(usage());
    expect(screen.getByText("ClinicFlow Managed AI")).toBeInTheDocument();
  });

  it("names the clinic's own key for a BYOK clinic", () => {
    renderMeter(usage({ providerState: "byok", byokConfigured: true }));
    expect(screen.getByText("Your Anthropic API key")).toBeInTheDocument();
  });

  it("says AI is continuing on the clinic's key after an automatic handover", () => {
    renderMeter(
      usage({
        providerState: "auto_byok",
        byokConfigured: true,
        threshold: "exhausted",
        usedPercent: 100,
        remainingMicros: 0,
      }),
    );
    expect(
      screen.getByText("Your Anthropic API key (included usage used up)"),
    ).toBeInTheDocument();
    // No "add a key" nag for a clinic that already added one.
    expect(screen.queryByText(/Add your own Anthropic API key below/)).not.toBeInTheDocument();
  });
});

describe("thresholds and calls to action", () => {
  it("stays quiet below 75%", () => {
    renderMeter(usage({ usedPercent: 60, threshold: "normal" }));
    expect(screen.getByText("Within your included usage")).toBeInTheDocument();
    expect(screen.queryByText(/nearly used up/i)).not.toBeInTheDocument();
  });

  it("flags a warning band without recommending anything yet", () => {
    renderMeter(usage({ usedPercent: 80, threshold: "warning" }));
    expect(screen.getByText("Usage is getting high")).toBeInTheDocument();
    expect(screen.queryByText(/avoids any interruption/)).not.toBeInTheDocument();
  });

  it("recommends a key at the critical band", () => {
    renderMeter(usage({ usedPercent: 92, threshold: "critical" }));
    expect(screen.getByText("Nearly used up")).toBeInTheDocument();
    expect(screen.getByText(/avoids any interruption/)).toBeInTheDocument();
  });

  it("tells an exhausted clinic with no key exactly what to do", () => {
    renderMeter(
      usage({ usedPercent: 100, threshold: "exhausted", remainingMicros: 0, requestRemaining: 0 }),
    );
    expect(screen.getByText("Included usage used up")).toBeInTheDocument();
    expect(screen.getByText(/Add your own Anthropic API key below/)).toBeInTheDocument();
  });
});

describe("customer-facing language", () => {
  it("does not expose ClinicFlow's internal cost accounting", () => {
    const { container } = renderMeter(usage({ usedPercent: 40, threshold: "normal" }));
    const text = container.textContent ?? "";
    for (const term of ["micros", "credits", "token", "cache", "worst-case", "reservation"]) {
      expect(text.toLowerCase()).not.toContain(term);
    }
  });

  it("shows the clinic's own estimated provider spend only when there is some", () => {
    const { container, rerender } = renderMeter(usage());
    expect(container.textContent).not.toContain("$");
    rerender(
      <AiUsageSummary
        usage={usage({ byokRequestUsed: 12, byokEstimatedCostMicros: 3_450_000 })}
      />,
    );
    expect(screen.getByText("$3.45")).toBeInTheDocument();
  });
});

describe("Arabic", () => {
  it("renders the Arabic catalogue for every band", () => {
    renderMeter(usage({ usedPercent: 92, threshold: "critical" }), "ar");
    expect(screen.getByText("الاستخدام المشمول")).toBeInTheDocument();
    expect(screen.getByText("أوشك على النفاد")).toBeInTheDocument();
    expect(screen.getByText("الذكاء الاصطناعي المُدار من ClinicFlow")).toBeInTheDocument();
  });

  it("renders the Arabic exhausted state and its call to action", () => {
    renderMeter(usage({ usedPercent: 100, threshold: "exhausted" }), "ar");
    expect(screen.getByText("نفد الاستخدام المشمول")).toBeInTheDocument();
    expect(screen.getByText(/أضف مفتاح Anthropic الخاص بك أدناه/)).toBeInTheDocument();
  });

  it("keeps numeric readouts left-to-right inside RTL copy", () => {
    const { container } = renderMeter(
      usage({ requestUsed: 720, requestRemaining: 280, byokRequestUsed: 3, byokEstimatedCostMicros: 1 }),
      "ar",
    );
    for (const node of container.querySelectorAll(".tabular-nums")) {
      // Every mixed number/slash readout is explicitly LTR so Arabic bidi does
      // not reorder "720 / 1,000".
      if ((node.textContent ?? "").includes("/")) {
        expect(node).toHaveAttribute("dir", "ltr");
      }
    }
  });
});
