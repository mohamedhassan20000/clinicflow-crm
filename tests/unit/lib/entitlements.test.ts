import { describe, expect, it } from "vitest";
import {
  hasAiProviderMode,
  hasFeature,
  normalizeLimits,
  resolveAiRequestLimit,
  resolveEntitlements,
} from "@/lib/entitlements";

// Mirrors the canonical P4.5C `pro_ai` plan catalog (see the catalog re-assert
// migration). Kept here so the "fully configured pro_ai" expectation is a guard
// against catalog drift like the one that produced the reported bug.
const PRO_AI_FEATURES = {
  ai_assistant: true,
  "ai.staff_assistant": true,
  "ai.patient_suggest": false,
  "ai.patient_auto": false,
  "ai.managed": true,
  "ai.byok": true,
  "ai.hybrid_fallback": false,
  "ai.staff_analytics": true,
  "ai.financial_insights": true,
} as const;
const PRO_AI_LIMITS = {
  ai_credits_month: 1_620_000_000,
  ai_requests_month: 1000,
  ai_messages_month: 1000,
  ai_concurrent_requests: 4,
} as const;

describe("entitlement resolution", () => {
  it("denies Basic AI even when an operator override attempts to enable it", () => {
    const basic = resolveEntitlements({
      clinicId: "clinic-1",
      planSlug: "basic",
      planFeatures: { ai_assistant: false, whatsapp: false },
      planLimits: { ai_messages_month: 0, staff_seats: 3 },
      subscriptionAllowed: true,
    });
    expect(hasFeature(basic, "ai_assistant")).toBe(false);

    const overridden = resolveEntitlements({
      clinicId: "clinic-1",
      planSlug: "basic",
      planFeatures: { ai_assistant: false },
      overrides: [{ feature_key: "ai_assistant", enabled: true }],
      subscriptionAllowed: true,
    });
    expect(hasFeature(overridden, "ai_assistant")).toBe(false);
  });

  it("requires the pro_ai umbrella and namespaced feature for provider modes", () => {
    const entitled = resolveEntitlements({
      clinicId: "clinic-1",
      planSlug: "pro_ai",
      planFeatures: {
        ai_assistant: true,
        "ai.staff_assistant": true,
        "ai.managed": true,
        "ai.byok": true,
        "ai.hybrid_fallback": false,
      },
      subscriptionAllowed: true,
    });
    expect(hasFeature(entitled, "ai.staff_assistant")).toBe(true);
    expect(hasAiProviderMode(entitled, "managed")).toBe(true);
    expect(hasAiProviderMode(entitled, "byok_strict")).toBe(true);
    expect(hasAiProviderMode(entitled, "hybrid")).toBe(false);

    const umbrellaDisabled = resolveEntitlements({
      clinicId: "clinic-1",
      planSlug: "pro_ai",
      planFeatures: { ai_assistant: false, "ai.managed": true },
      subscriptionAllowed: true,
    });
    expect(hasFeature(umbrellaDisabled, "ai.managed")).toBe(false);
  });

  it("fails feature checks closed when the subscription is inactive", () => {
    const expired = resolveEntitlements({
      clinicId: "clinic-1",
      planSlug: "pro_ai",
      planFeatures: { ai_assistant: true },
      subscriptionAllowed: false,
    });
    expect(hasFeature(expired, "ai_assistant")).toBe(false);
  });

  it("grants managed and strict BYOK from the canonical pro_ai catalog", () => {
    const proAi = resolveEntitlements({
      clinicId: "clinic-1",
      planSlug: "pro_ai",
      planFeatures: PRO_AI_FEATURES,
      planLimits: PRO_AI_LIMITS,
      subscriptionAllowed: true,
    });
    expect(hasAiProviderMode(proAi, "managed")).toBe(true);
    expect(hasAiProviderMode(proAi, "byok_strict")).toBe(true);
    // Hybrid is off by default in the plan catalog.
    expect(hasAiProviderMode(proAi, "hybrid")).toBe(false);
    expect(resolveAiRequestLimit(proAi)).toBe(1000);
  });

  it("enables hybrid via a per-clinic ai.hybrid_fallback override (runbook path)", () => {
    const withHybrid = resolveEntitlements({
      clinicId: "clinic-1",
      planSlug: "pro_ai",
      planFeatures: PRO_AI_FEATURES,
      planLimits: PRO_AI_LIMITS,
      overrides: [{ feature_key: "ai.hybrid_fallback", enabled: true }],
      subscriptionAllowed: true,
    });
    expect(hasAiProviderMode(withHybrid, "hybrid")).toBe(true);
    // A non-pro_ai plan can never be lifted into AN AI mode by the same override.
    const basicWithHybrid = resolveEntitlements({
      clinicId: "clinic-1",
      planSlug: "basic",
      planFeatures: { ai_assistant: false },
      overrides: [
        { feature_key: "ai.byok", enabled: true },
        { feature_key: "ai.hybrid_fallback", enabled: true },
      ],
      subscriptionAllowed: true,
    });
    expect(hasAiProviderMode(basicWithHybrid, "hybrid")).toBe(false);
  });

  it("accepts only non-negative integer limits", () => {
    expect(normalizeLimits({ valid: 10, negative: -1, fraction: 1.5, text: "10" })).toEqual({
      valid: 10,
    });
  });
});
