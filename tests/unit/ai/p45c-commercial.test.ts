import { describe, expect, it } from "vitest";
import {
  NAMESPACED_AI_FEATURES,
  aiModeFeatures,
  isAiFeatureKey,
  isKnownAiFeature,
} from "@/lib/ai/commercial-policy";
import { aiUsageThreshold, computeClinicAiCommercialUsage } from "@/lib/ai/commercial";

const PERIOD = "2026-07-01";
const PLAN_CREDITS = 1_620_000_000;

function baseInput() {
  return {
    periodStart: PERIOD,
    planBudgetMicros: PLAN_CREDITS,
    requestPlanLimit: 1000,
    period: null,
    requestCounter: null,
    terms: null,
    byokRequestUsed: 0,
    byokEstimatedCostMicros: 0,
  } as const;
}

describe("P4.5C commercial policy", () => {
  it("keeps a closed namespaced feature vocabulary", () => {
    expect(NAMESPACED_AI_FEATURES).toContain("ai.staff_assistant");
    expect(NAMESPACED_AI_FEATURES).toContain("ai.financial_insights");
    expect(isKnownAiFeature("ai.hybrid_fallback")).toBe(true);
    expect(isKnownAiFeature("ai.tenant_selected_model")).toBe(false);
    expect(isAiFeatureKey("ai.tenant_selected_model")).toBe(true);
  });

  it("requires both BYOK and explicit fallback entitlement for hybrid", () => {
    expect(aiModeFeatures("managed")).toEqual(["ai.managed"]);
    expect(aiModeFeatures("byok_strict")).toEqual(["ai.byok"]);
    expect(aiModeFeatures("hybrid")).toEqual(["ai.byok", "ai.hybrid_fallback"]);
  });

  it("uses the roadmap's 70/90/100 degradation thresholds", () => {
    expect(aiUsageThreshold(69)).toBe("normal");
    expect(aiUsageThreshold(70)).toBe("seventy");
    expect(aiUsageThreshold(90)).toBe("ninety");
    expect(aiUsageThreshold(100)).toBe("exhausted");
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
    expect(usage.overageMode).toBe("contracted");
    expect(usage.hasAddon).toBe(true);
  });
});
