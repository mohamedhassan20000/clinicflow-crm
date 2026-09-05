import { describe, expect, it } from "vitest";
import {
  NAMESPACED_AI_FEATURES,
  aiModeFeatures,
  isAiFeatureKey,
  isKnownAiFeature,
} from "@/lib/ai/commercial-policy";
import { aiUsageThreshold, computeClinicAiCommercialUsage } from "@/lib/ai/commercial";
import {
  AI_USAGE_THRESHOLD_PERCENTS,
  crossedAiUsageThresholds,
} from "@/lib/ai/allowance";

const PERIOD = "2026-07-01";
const PLAN_CREDITS = 1_620_000_000;

function baseInput() {
  return {
    periodStart: PERIOD,
    resetDate: "2026-08-01",
    planBudgetMicros: PLAN_CREDITS,
    requestPlanLimit: 1000,
    period: null,
    requestCounter: null,
    terms: null,
    byokRequestUsed: 0,
    byokEstimatedCostMicros: 0,
    byokConfigured: false,
    credentialMode: "managed",
  } as const;
}

describe("P4.5C commercial policy", () => {
  it("keeps a closed namespaced feature vocabulary", () => {
    expect(NAMESPACED_AI_FEATURES).toEqual([
      "ai.staff_assistant",
      "ai.patient_suggest",
      "ai.patient_auto",
      "ai.managed",
      "ai.byok",
      "ai.hybrid_fallback",
      "ai.staff_analytics",
      "ai.financial_insights",
      "ai.assistant_customization",
      "ai.workflows",
      "ai.followup_generation",
      "ai.scheduling",
      "ai.read_operational",
      "ai.read_clinical",
      "ai.read_financial",
      "ai.write_scheduling",
      "ai.write_records",
      "ai.write_administration",
      "ai.write_privileged",
      "ai.documents",
      "ai.bulk_export",
    ]);
    expect(new Set(NAMESPACED_AI_FEATURES).size).toBe(NAMESPACED_AI_FEATURES.length);
    for (const feature of NAMESPACED_AI_FEATURES) {
      expect(isKnownAiFeature(feature)).toBe(true);
    }
    expect(isKnownAiFeature("ai.tenant_selected_model")).toBe(false);
    expect(isAiFeatureKey("ai.tenant_selected_model")).toBe(true);
  });

  it("requires both BYOK and explicit fallback entitlement for hybrid", () => {
    expect(aiModeFeatures("managed")).toEqual(["ai.managed"]);
    expect(aiModeFeatures("byok_strict")).toEqual(["ai.byok"]);
    expect(aiModeFeatures("hybrid")).toEqual(["ai.byok", "ai.hybrid_fallback"]);
  });

  it("uses the 75/90/100 notification thresholds from the shared constants", () => {
    expect(aiUsageThreshold(74)).toBe("normal");
    expect(aiUsageThreshold(AI_USAGE_THRESHOLD_PERCENTS.warning)).toBe("warning");
    expect(aiUsageThreshold(AI_USAGE_THRESHOLD_PERCENTS.critical)).toBe("critical");
    expect(aiUsageThreshold(AI_USAGE_THRESHOLD_PERCENTS.exhausted)).toBe("exhausted");
    // The bands are read from one source, so the meter, the notifier and the
    // owner console cannot drift apart.
    expect(AI_USAGE_THRESHOLD_PERCENTS).toEqual({ warning: 75, critical: 90, exhausted: 100 });
  });

  it("reports every threshold a percentage has crossed, most severe first", () => {
    expect(crossedAiUsageThresholds(50)).toEqual([]);
    expect(crossedAiUsageThresholds(75)).toEqual([75]);
    expect(crossedAiUsageThresholds(92)).toEqual([90, 75]);
    expect(crossedAiUsageThresholds(100)).toEqual([100, 90, 75]);
  });
});

describe("computeClinicAiCommercialUsage", () => {
  it("reports a small percentage for a configured pro_ai clinic with light usage", () => {
    // Four requests whose actual managed cost is far below the worst-case pool.
    const usage = computeClinicAiCommercialUsage({
      ...baseInput(),
      period: { budget_limit_micros: PLAN_CREDITS, reserved_micros: 0, spent_micros: 2_000_000 },
      requestCounter: { used: 4, limit_snapshot: 1000 },
    });
    expect(usage.managedAllowanceConfigured).toBe(true);
    expect(usage.usedPercent).toBe(0); // 2,000,000 / 1,620,000,000 rounds to 0%
    expect(usage.threshold).toBe("normal");
    expect(usage.requestUsed).toBe(4);
    expect(usage.requestLimit).toBe(1000);
    expect(usage.requestRemaining).toBe(996);
  });

  it("does NOT report a false 100% exhausted when no managed allowance is configured", () => {
    // Regression guard for the reported bug: pre-P4.5C plan row => planBudget 0.
    const usage = computeClinicAiCommercialUsage({
      ...baseInput(),
      planBudgetMicros: 0,
      requestCounter: { used: 4, limit_snapshot: 1000 },
    });
    expect(usage.budgetLimitMicros).toBe(0);
    expect(usage.managedAllowanceConfigured).toBe(false);
    expect(usage.usedPercent).toBe(0);
    expect(usage.threshold).toBe("normal");
    // Request meter stays independent and correct.
    expect(usage.requestUsed).toBe(4);
    expect(usage.requestLimit).toBe(1000);
  });

  it("saturates at 100% exhausted when a configured allowance is fully committed", () => {
    const usage = computeClinicAiCommercialUsage({
      ...baseInput(),
      period: {
        budget_limit_micros: PLAN_CREDITS,
        reserved_micros: 20_000_000,
        spent_micros: PLAN_CREDITS,
      },
      requestCounter: { used: 1000, limit_snapshot: 1000 },
    });
    expect(usage.usedPercent).toBe(100);
    expect(usage.threshold).toBe("exhausted");
  });

  it("keeps request-count and cost-weighted allowance separate", () => {
    // Many requests, tiny cost: request meter high, cost meter low.
    const usage = computeClinicAiCommercialUsage({
      ...baseInput(),
      period: { budget_limit_micros: PLAN_CREDITS, reserved_micros: 0, spent_micros: 1_000_000 },
      requestCounter: { used: 950, limit_snapshot: 1000 },
    });
    expect(usage.requestRemaining).toBe(50);
    expect(usage.usedPercent).toBeLessThan(1);
    expect(usage.threshold).toBe("normal");
  });

  it("surfaces BYOK usage separately without touching the managed allowance", () => {
    const usage = computeClinicAiCommercialUsage({
      ...baseInput(),
      period: { budget_limit_micros: PLAN_CREDITS, reserved_micros: 0, spent_micros: 0 },
      requestCounter: { used: 12, limit_snapshot: 1000 },
      byokRequestUsed: 12,
      byokEstimatedCostMicros: 3_450_000,
    });
    // Managed spend is untouched by BYOK direct provider cost.
    expect(usage.managedSpentMicros).toBe(0);
    expect(usage.usedPercent).toBe(0);
    expect(usage.byokRequestUsed).toBe(12);
    expect(usage.byokEstimatedCostMicros).toBe(3_450_000);
  });

  it("adds included override, add-on, and contracted overage into the budget", () => {
    const usage = computeClinicAiCommercialUsage({
      ...baseInput(),
      terms: {
        included_budget_override_micros: 500_000_000,
        addon_budget_micros: 200_000_000,
        overage_mode: "contracted",
        overage_budget_micros: 100_000_000,
      },
      period: { budget_limit_micros: 0, reserved_micros: 0, spent_micros: 400_000_000 },
      requestCounter: { used: 5, limit_snapshot: 1000 },
    });
    // 500M override + 200M add-on + 100M overage = 800M
    expect(usage.budgetLimitMicros).toBe(800_000_000);
    expect(usage.usedPercent).toBe(50);
    expect(usage.remainingMicros).toBe(400_000_000);
    expect(usage.overageMode).toBe("contracted");
    expect(usage.hasAddon).toBe(true);
  });

  it("carries the reset date through unchanged", () => {
    const usage = computeClinicAiCommercialUsage({ ...baseInput() });
    expect(usage.periodStart).toBe(PERIOD);
    expect(usage.resetDate).toBe("2026-08-01");
  });

  it("shows a managed clinic as managed while allowance remains", () => {
    const usage = computeClinicAiCommercialUsage({
      ...baseInput(),
      period: { budget_limit_micros: PLAN_CREDITS, reserved_micros: 0, spent_micros: 10_000_000 },
      byokConfigured: true,
    });
    expect(usage.providerState).toBe("managed");
  });

  it("shows an exhausted managed clinic with a key as running on its own key", () => {
    const usage = computeClinicAiCommercialUsage({
      ...baseInput(),
      period: {
        budget_limit_micros: PLAN_CREDITS,
        reserved_micros: 0,
        spent_micros: PLAN_CREDITS,
      },
      byokConfigured: true,
    });
    expect(usage.threshold).toBe("exhausted");
    expect(usage.providerState).toBe("auto_byok");
    expect(usage.remainingMicros).toBe(0);
  });

  it("keeps an exhausted managed clinic WITHOUT a key on the managed state", () => {
    // There is nothing to hand over to, so the meter must not imply there is.
    const usage = computeClinicAiCommercialUsage({
      ...baseInput(),
      period: {
        budget_limit_micros: PLAN_CREDITS,
        reserved_micros: 0,
        spent_micros: PLAN_CREDITS,
      },
      byokConfigured: false,
    });
    expect(usage.threshold).toBe("exhausted");
    expect(usage.providerState).toBe("managed");
  });

  it("shows a clinic that CHOSE BYOK as BYOK regardless of allowance", () => {
    const usage = computeClinicAiCommercialUsage({
      ...baseInput(),
      credentialMode: "byok_strict",
      byokConfigured: true,
      period: { budget_limit_micros: PLAN_CREDITS, reserved_micros: 0, spent_micros: 0 },
    });
    expect(usage.providerState).toBe("byok");
  });
});
