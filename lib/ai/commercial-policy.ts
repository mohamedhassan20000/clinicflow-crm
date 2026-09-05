export const LEGACY_AI_ASSISTANT_FEATURE = "ai_assistant" as const;

export const AI_CAPABILITY_FEATURES = [
  "ai.read_operational",
  "ai.read_clinical",
  "ai.read_financial",
  "ai.write_scheduling",
  "ai.write_records",
  "ai.write_administration",
  "ai.write_privileged",
  "ai.documents",
  "ai.bulk_export",
] as const;

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
  ...AI_CAPABILITY_FEATURES,
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

/**
 * Marks a plan that sells every supported AI capability. Pro + AI carries it;
 * a plan that adds AI capabilities piecemeal does not. It is a catalog value,
 * not a slug test, so the resolver below still never branches on a plan name.
 */
export const AI_SUPERSET_FEATURE = "ai.superset" as const;

/**
 * Canonical TypeScript-side AI entitlement rule. SQL's
 * `public.effective_ai_feature` implements the same four inputs so callers on
 * either side of the application boundary cannot fall back to a plan slug.
 *
 * `features` is the plan catalog with the clinic's overrides already merged
 * over it, so an operator override remains authoritative in both directions:
 * an explicit `false` denies even on a superset plan.
 *
 * This answers "did the clinic buy this capability" and nothing else. Role,
 * financial permission, tenant scope, patient consent and budget are separate
 * gates that still run on their own.
 */
export function resolveEffectiveAiFeature(input: {
  subscriptionAllowed: boolean;
  termsAccepted: boolean;
  features: Readonly<Record<string, boolean>>;
  featureKey: string;
}): boolean {
  if (!input.subscriptionAllowed || !input.termsAccepted) return false;
  if (input.features[LEGACY_AI_ASSISTANT_FEATURE] !== true) return false;
  if (input.featureKey === LEGACY_AI_ASSISTANT_FEATURE) return true;
  if (input.features[input.featureKey] === true) return true;
  return input.features[AI_SUPERSET_FEATURE] === true
    && input.features[input.featureKey] !== false;
}

/**
 * The DEFAULT included managed AI allowance a plan carries, per clinic, per
 * billing period — ClinicFlow's internal cost-weighted allowance, not a
 * customer price.
 *
 * The authoritative store is the plan catalog: `plans.limits.ai_credits_month`,
 * seeded by `supabase/migrations/20260901120000_p13b_default_ai_allowance_ten_usd.sql`.
 * Every runtime path (the reservation SQL, `operator_ai_allowance_report`, and
 * the recompute fallback in `lib/ai/operator-allowance.ts`) reads the plan row,
 * so this constant is the shared *definition* of the seeded default rather than
 * a second calculation: nothing in the UI may substitute it for the value the
 * database actually reports.
 *
 * A clinic-specific override lives in
 * `ai_commercial_terms.included_budget_override_micros` and always wins; this
 * default applies only where no override exists.
 */
export const DEFAULT_INCLUDED_AI_ALLOWANCE_MICROS = 10_000_000;

/** The same default expressed in whole USD, for copy and test assertions. */
export const DEFAULT_INCLUDED_AI_ALLOWANCE_USD =
  DEFAULT_INCLUDED_AI_ALLOWANCE_MICROS / 1_000_000;

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
