export const LEGACY_AI_ASSISTANT_FEATURE = "ai_assistant" as const;

export const NAMESPACED_AI_FEATURES = [
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
] as const;

export type NamespacedAiFeature = (typeof NAMESPACED_AI_FEATURES)[number];
export type AiCommercialFeature = typeof LEGACY_AI_ASSISTANT_FEATURE | NamespacedAiFeature;

const AI_FEATURE_SET = new Set<string>([
  LEGACY_AI_ASSISTANT_FEATURE,
  ...NAMESPACED_AI_FEATURES,
]);

export function isKnownAiFeature(featureKey: string): featureKey is AiCommercialFeature {
  return AI_FEATURE_SET.has(featureKey);
}

export function isAiFeatureKey(featureKey: string): boolean {
  return featureKey === LEGACY_AI_ASSISTANT_FEATURE || featureKey.startsWith("ai.");
}

export const AI_LIMIT_KEYS = {
  creditsMonth: "ai_credits_month",
  requestsMonth: "ai_requests_month",
  legacyRequestsMonth: "ai_messages_month",
  concurrentRequests: "ai_concurrent_requests",
  turnStepsMax: "ai_turn_steps_max",
  outputTokensMax: "ai_output_tokens_max",
} as const;

export type AiCommercialMode = "managed" | "byok_strict" | "hybrid";

export function aiModeFeatures(mode: AiCommercialMode): readonly NamespacedAiFeature[] {
  if (mode === "managed") return ["ai.managed"];
  if (mode === "byok_strict") return ["ai.byok"];
  return ["ai.byok", "ai.hybrid_fallback"];
}
