import "server-only";

import type { LanguageModelUsage } from "ai";
import type {
  AiTokenPricing,
  CertifiedModelRoute,
  CertifiedTaskPolicy,
} from "@/lib/ai/platform/types";

function costMicros(tokens: number | undefined, rateMicrosPerMillion: number): number {
  if (!tokens || tokens <= 0) return 0;
  return Math.ceil((tokens * rateMicrosPerMillion) / 1_000_000);
}

export function calculateUsageCostMicros(
  pricing: AiTokenPricing,
  usage: LanguageModelUsage,
): number {
  const cacheRead = usage.inputTokenDetails.cacheReadTokens ?? 0;
  const cacheWrite = usage.inputTokenDetails.cacheWriteTokens ?? 0;
  const noCache =
    usage.inputTokenDetails.noCacheTokens ??
    Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite);
  return (
    costMicros(noCache, pricing.inputMicrosPerMillion) +
    costMicros(cacheRead, pricing.cacheReadMicrosPerMillion) +
    costMicros(cacheWrite, pricing.cacheWriteMicrosPerMillion) +
    costMicros(usage.outputTokens, pricing.outputMicrosPerMillion)
  );
}

/** Savings from provider-side caching are never assumed for hard reservations. */
export function calculateWorstCaseCostMicros(
  policy: CertifiedTaskPolicy,
  route: CertifiedModelRoute,
): number {
  const worstInputRate = Math.max(
    route.pricing.inputMicrosPerMillion,
    route.pricing.cacheReadMicrosPerMillion,
    route.pricing.cacheWriteMicrosPerMillion,
  );
  const perStep =
    costMicros(policy.maxInputTokensPerStep, worstInputRate) +
    costMicros(policy.maxOutputTokens, route.pricing.outputMicrosPerMillion);
  return perStep * policy.maxSteps;
}

export function calculateWorstCaseStepCostMicros(
  policy: CertifiedTaskPolicy,
  route: CertifiedModelRoute,
): number {
  const worstInputRate = Math.max(
    route.pricing.inputMicrosPerMillion,
    route.pricing.cacheReadMicrosPerMillion,
    route.pricing.cacheWriteMicrosPerMillion,
  );
  return (
    costMicros(policy.maxInputTokensPerStep, worstInputRate) +
    costMicros(policy.maxOutputTokens, route.pricing.outputMicrosPerMillion)
  );
}
