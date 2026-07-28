import "server-only";

import { hasFeature, type Entitlements } from "@/lib/entitlements";
import {
  AI_ASSISTANT_FEATURE,
} from "@/lib/ai/authorization";
import {
  AI_PATIENT_SUGGEST_FEATURE,
} from "@/lib/ai/patient-authorization";

export const AI_PATIENT_AUTO_FEATURE = "ai.patient_auto" as const;

/** The mode stored on the clinic (§6.2). `auto` is entitlement-gated. */
export type ClinicAiReplyMode = "off" | "suggest" | "auto";

/** The mode actually applied to a turn after entitlement resolution. */
export type EffectiveAiReplyMode = "off" | "suggest" | "auto";

export function normalizeClinicAiReplyMode(value: string | null | undefined): ClinicAiReplyMode {
  return value === "suggest" || value === "auto" ? value : "off";
}

/**
 * Resolves the mode a patient turn actually runs in, fail-closed.
 *
 * - No active subscription, no `ai_assistant`, or no `ai.patient_suggest` → `off`.
 *   Patient AI is `pro_ai`-only and opt-in; without the suggest entitlement the
 *   agent never drafts anything, regardless of the clinic column.
 * - Clinic column `off` → `off`.
 * - Clinic column `auto` **without** `ai.patient_auto` → downgraded to `suggest`.
 *   This is the §12-HP / §P5 safety gate: `auto` stays behind its own
 *   entitlement so it cannot be turned on by the clinic toggle alone.
 * - Clinic column `auto` **with** `ai.patient_auto` → `auto`.
 * - Clinic column `suggest` → `suggest`.
 */
export function resolveEffectiveAiReplyMode(input: {
  clinicMode: ClinicAiReplyMode;
  entitlements: Entitlements;
}): EffectiveAiReplyMode {
  const { clinicMode, entitlements } = input;
  if (clinicMode === "off") return "off";
  if (
    !hasFeature(entitlements, AI_ASSISTANT_FEATURE) ||
    !hasFeature(entitlements, AI_PATIENT_SUGGEST_FEATURE)
  ) {
    return "off";
  }
  if (clinicMode === "auto") {
    return hasFeature(entitlements, AI_PATIENT_AUTO_FEATURE) ? "auto" : "suggest";
  }
  return "suggest";
}
