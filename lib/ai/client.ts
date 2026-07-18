import "server-only";

import { anthropic } from "@ai-sdk/anthropic";

/**
 * Model configuration per task tier.
 *
 * Models are called directly through the Anthropic API.
 * Defaults can be overridden through environment variables.
 */

export type ModelTier = "doctor" | "patient";

const DEFAULT_MODELS: Record<ModelTier, string> = {
  doctor: "claude-sonnet-4-5",
  patient: "claude-haiku-4-5",
};

export function resolveModelId(tier: ModelTier) {
  const override =
    tier === "doctor"
      ? process.env.AI_MODEL_DOCTOR
      : process.env.AI_MODEL_PATIENT;

  const modelId =
    override && override.trim().length > 0
      ? override.trim()
      : DEFAULT_MODELS[tier];

  return anthropic(modelId);
}

export const DOCTOR_GENERATION = {
  temperature: 0.2,
  maxOutputTokens: 1500,
} as const;

export const MAX_AGENT_STEPS = 8;