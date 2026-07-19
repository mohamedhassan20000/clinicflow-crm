import { describe, expect, it } from "vitest";
import {
  NAMESPACED_AI_FEATURES,
  aiModeFeatures,
  isAiFeatureKey,
  isKnownAiFeature,
} from "@/lib/ai/commercial-policy";
import { aiUsageThreshold } from "@/lib/ai/commercial";

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
