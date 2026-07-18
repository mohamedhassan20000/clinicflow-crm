import "server-only";

/**
 * Model configuration per task tier (§6.1, §11). Model ids are plain
 * "provider/model" strings resolved through the Vercel AI Gateway for
 * observability and provider fallback — no provider SDK is imported directly.
 *
 * Tiers (§11):
 *   - doctor:  Sonnet-tier — clinical summaries where quality matters, low volume.
 *   - patient: Haiku 4.5 — fast, cheap, constrained tool flows (mounted in P5).
 *
 * Defaults are overridable per environment so a model rename never requires a
 * code change. The doctor assistant is read-only, so generation is kept low
 * temperature for faithful, non-embellished summaries.
 */

export type ModelTier = "doctor" | "patient";

const DEFAULT_MODELS: Record<ModelTier, string> = {
  doctor: "anthropic/claude-sonnet-4.5",
  patient: "anthropic/claude-haiku-4.5",
};

export function resolveModelId(tier: ModelTier): string {
  const override =
    tier === "doctor" ? process.env.AI_MODEL_DOCTOR : process.env.AI_MODEL_PATIENT;
  return override && override.trim().length > 0 ? override.trim() : DEFAULT_MODELS[tier];
}

/** Shared generation settings for the read-only doctor assistant. */
export const DOCTOR_GENERATION = {
  temperature: 0.2,
  maxOutputTokens: 1500,
} as const;

/**
 * Maximum tool-use steps for a single assistant turn. Bounds cost and stops a
 * runaway loop; the doctor tools are read-only so a handful of steps suffices.
 */
export const MAX_AGENT_STEPS = 8;
