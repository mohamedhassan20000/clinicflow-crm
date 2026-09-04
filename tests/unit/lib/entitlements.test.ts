import { describe, expect, it } from "vitest";
import {
  hasAiProviderMode,
  hasFeature,
  normalizeLimits,
  resolveAiRequestLimit,
  resolveEntitlements,
} from "@/lib/entitlements";

// Mirrors the canonical `pro_ai` plan catalog after the superset migration
// (20260817170000). Pro + AI is the highest AI plan and carries every AI
// capability plus the `ai.superset` marker; kept here so catalog drift below
// that line shows up as a failing expectation rather than as a paid clinic
// being told it is not entitled.
const PRO_AI_FEATURES = {
  ai_assistant: true,
  "ai.superset": true,
  "ai.staff_assistant": true,
  "ai.patient_suggest": true,
  "ai.patient_auto": true,
  "ai.managed": true,
  "ai.byok": true,
  "ai.hybrid_fallback": true,
  "ai.staff_analytics": true,
  "ai.financial_insights": true,
  "ai.assistant_customization": true,
  "ai.workflows": true,
  "ai.followup_generation": true,
  "ai.scheduling": true,
} as const;
const PRO_AI_LIMITS = {
  ai_credits_month: 1_620_000_000,
  ai_requests_month: 1000,
  ai_messages_month: 1000,
  ai_concurrent_requests: 4,
} as const;

describe("entitlement resolution", () => {
  it("grants Basic AI from features or overrides without consulting the plan slug", () => {
    const basic = resolveEntitlements({
      clinicId: "clinic-1",
      planSlug: "basic",
      planFeatures: {
        ai_assistant: true,
        "ai.read_operational": true,
        whatsapp: false,
      },
      planLimits: { ai_credits_month: 1_000, staff_seats: 3 },
      subscriptionAllowed: true,
      aiTermsAccepted: true,
    });
    expect(hasFeature(basic, "ai_assistant")).toBe(true);
    expect(hasFeature(basic, "ai.read_operational")).toBe(true);

    const overridden = resolveEntitlements({
      clinicId: "clinic-1",
      planSlug: "basic",
      planFeatures: { ai_assistant: false },
      overrides: [
        { feature_key: "ai_assistant", enabled: true },
        { feature_key: "ai.read_operational", enabled: true },
      ],
      subscriptionAllowed: true,
      aiTermsAccepted: true,
    });
    expect(hasFeature(overridden, "ai.read_operational")).toBe(true);

    const professionalCustomizationOverride = resolveEntitlements({
      clinicId: "clinic-1",
      planSlug: "pro",
      planFeatures: {
        ai_assistant: false,
        "ai.assistant_customization": false,
      },
      overrides: [
        { feature_key: "ai_assistant", enabled: true },
        { feature_key: "ai.assistant_customization", enabled: true },
      ],
      subscriptionAllowed: true,
      aiTermsAccepted: true,
    });
    expect(
      hasFeature(
        professionalCustomizationOverride,
        "ai.assistant_customization",
      ),
    ).toBe(true);
  });

  it("requires accepted terms, the umbrella, and the namespaced provider feature", () => {
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
      aiTermsAccepted: true,
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
      aiTermsAccepted: true,
    });
    expect(hasFeature(umbrellaDisabled, "ai.managed")).toBe(false);

    const unsigned = resolveEntitlements({
      clinicId: "clinic-1",
      planSlug: "pro_ai",
      planFeatures: { ai_assistant: true, "ai.managed": true },
      subscriptionAllowed: true,
      aiTermsAccepted: false,
    });
    expect(hasFeature(unsigned, "ai_assistant")).toBe(false);
    expect(hasFeature(unsigned, "ai.managed")).toBe(false);
  });

  it("fails feature checks closed when the subscription is inactive", () => {
    const expired = resolveEntitlements({
      clinicId: "clinic-1",
      planSlug: "pro_ai",
      planFeatures: { ai_assistant: true },
      subscriptionAllowed: false,
      aiTermsAccepted: true,
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
      aiTermsAccepted: true,
    });
    expect(hasAiProviderMode(proAi, "managed")).toBe(true);
    expect(hasAiProviderMode(proAi, "byok_strict")).toBe(true);
    // Pro + AI is the superset plan, so hybrid needs no per-clinic override.
    // Persisted hybrid consent and a healthy connection are still required at
    // reservation time; that gate is enforced in the database, not here.
    expect(hasAiProviderMode(proAi, "hybrid")).toBe(true);
    expect(hasFeature(proAi, "ai.assistant_customization")).toBe(true);
    expect(hasFeature(proAi, "ai.patient_auto")).toBe(true);
    expect(resolveAiRequestLimit(proAi)).toBe(1000);
  });

  it("grants a Pro + AI clinic an AI capability the plan row never listed", () => {
    // The superset marker is what stops a capability added after the catalog
    // row was last edited from resolving false on the highest plan.
    const proAi = resolveEntitlements({
      clinicId: "clinic-1",
      planSlug: "pro_ai",
      planFeatures: { ai_assistant: true, "ai.superset": true },
      planLimits: PRO_AI_LIMITS,
      subscriptionAllowed: true,
      aiTermsAccepted: true,
    });
    expect(hasFeature(proAi, "ai.some_future_capability")).toBe(true);
    // Entitlement only. A non-AI feature is unaffected by the AI superset.
    expect(hasFeature(proAi, "whatsapp")).toBe(false);
  });

  it("lets an operator override withhold a capability from a superset plan", () => {
    const restricted = resolveEntitlements({
      clinicId: "clinic-1",
      planSlug: "pro_ai",
      planFeatures: PRO_AI_FEATURES,
      planLimits: PRO_AI_LIMITS,
      overrides: [{ feature_key: "ai.patient_auto", enabled: false }],
      subscriptionAllowed: true,
      aiTermsAccepted: true,
    });
    expect(hasFeature(restricted, "ai.patient_auto")).toBe(false);
    expect(hasFeature(restricted, "ai.staff_assistant")).toBe(true);
  });

  it("never lets the superset marker outrank terms, the umbrella, or the subscription", () => {
    const base = {
      clinicId: "clinic-1",
      planSlug: "pro_ai",
      planFeatures: PRO_AI_FEATURES,
      planLimits: PRO_AI_LIMITS,
    };
    const unsigned = resolveEntitlements({
      ...base,
      subscriptionAllowed: true,
      aiTermsAccepted: false,
    });
    const inactive = resolveEntitlements({
      ...base,
      subscriptionAllowed: false,
      aiTermsAccepted: true,
    });
    const umbrellaRevoked = resolveEntitlements({
      ...base,
      overrides: [{ feature_key: "ai_assistant", enabled: false }],
      subscriptionAllowed: true,
      aiTermsAccepted: true,
    });
    for (const entitlements of [unsigned, inactive, umbrellaRevoked]) {
      expect(hasFeature(entitlements, "ai.staff_assistant")).toBe(false);
      expect(hasFeature(entitlements, "ai.patient_auto")).toBe(false);
      expect(hasAiProviderMode(entitlements, "hybrid")).toBe(false);
    }
  });

  it("enables hybrid via a per-clinic ai.hybrid_fallback override (runbook path)", () => {
    const withHybrid = resolveEntitlements({
      clinicId: "clinic-1",
      planSlug: "pro_ai",
      planFeatures: PRO_AI_FEATURES,
      planLimits: PRO_AI_LIMITS,
      overrides: [{ feature_key: "ai.hybrid_fallback", enabled: true }],
      subscriptionAllowed: true,
      aiTermsAccepted: true,
    });
    expect(hasAiProviderMode(withHybrid, "hybrid")).toBe(true);
    // A different catalog tier can be lifted into an AI mode by feature data.
    const basicWithHybrid = resolveEntitlements({
      clinicId: "clinic-1",
      planSlug: "basic",
      planFeatures: { ai_assistant: false },
      overrides: [
        { feature_key: "ai_assistant", enabled: true },
        { feature_key: "ai.byok", enabled: true },
        { feature_key: "ai.hybrid_fallback", enabled: true },
      ],
      subscriptionAllowed: true,
      aiTermsAccepted: true,
    });
    expect(hasAiProviderMode(basicWithHybrid, "hybrid")).toBe(true);
  });

  it("accepts only non-negative integer limits", () => {
    expect(normalizeLimits({ valid: 10, negative: -1, fraction: 1.5, text: "10" })).toEqual({
      valid: 10,
    });
  });
});
