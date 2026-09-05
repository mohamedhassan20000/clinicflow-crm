import "server-only";

import { APICallError } from "ai";

/**
 * ClinicFlow's provider-neutral failure vocabulary.
 *
 * Extracted from the tenant adapter in P12 so the managed direct adapter, the
 * BYOK adapter, and the platform resilience middleware all normalize provider
 * errors identically. Callers above this layer never read a provider status
 * code, which is what keeps "managed Anthropic direct" and "clinic Anthropic
 * direct" indistinguishable to every gate above the transport.
 */
export type AiProviderFailureClass =
  | "authentication"
  | "permission"
  | "quota"
  | "rate_limit"
  | "timeout"
  | "provider_unavailable"
  | "request_failed";

export function classifyAiProviderFailure(error: unknown): AiProviderFailureClass {
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && (error.name === "AbortError" || /timed?\s*out/i.test(error.message))) {
    return "timeout";
  }
  // Saturated platform capacity is surfaced as a provider rate limit: it is the
  // same operational condition from the caller's point of view, and it must
  // never be mistaken for a retryable transient by anything upstream.
  if (
    error instanceof Error &&
    (error as { failureClass?: string }).failureClass === "rate_limit"
  ) {
    return "rate_limit";
  }
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401) return "authentication";
    if (error.statusCode === 403) return "permission";
    if (error.statusCode === 402) return "quota";
    if (error.statusCode === 429) return "rate_limit";
    if (error.statusCode === undefined || error.statusCode >= 500) {
      return "provider_unavailable";
    }
  }
  return "request_failed";
}
