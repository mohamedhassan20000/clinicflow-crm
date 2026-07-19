import { describe, expect, it } from "vitest";
import {
  hasAiProviderMode,
  hasFeature,
  normalizeLimits,
  resolveEntitlements,
} from "@/lib/entitlements";

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

  it("accepts only non-negative integer limits", () => {
    expect(normalizeLimits({ valid: 10, negative: -1, fraction: 1.5, text: "10" })).toEqual({
      valid: 10,
    });
  });
});
