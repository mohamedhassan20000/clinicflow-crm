/**
 * The ClinicFlow AI allowance invariant.
 *
 * This module is intentionally dependency-free and holds no logic beyond the
 * threshold constants, so both server and client code — and the tests that
 * assert the invariant — can import the same definitions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE INVARIANT (P12, resolving audit findings G2 and G3)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * There are two different kinds of limit in this system, and before P12 one
 * number was doing both jobs. They are now separate and must stay separate:
 *
 *   COMMERCIAL — "how much AI has ClinicFlow agreed to pay for?"
 *     * `ai_credits_month`  (plan default) + `ai_commercial_terms
 *        .included_budget_override_micros` (per-clinic owner override)
 *        → the monetary allowance, in micros, tracked in
 *          `ai_budget_periods.spent_micros` / `reserved_micros`.
 *     * `ai_messages_month` / `ai_requests_month`
 *        → the ClinicFlow-FUNDED request pool, tracked in `usage_counters`.
 *
 *     Both apply to `managed` turns, and to the fallback leg of `hybrid`.
 *     NEITHER applies to a direct BYOK turn. A clinic spending its own money at
 *     its own provider does not consume an allowance ClinicFlow is not funding,
 *     and being blocked by one was the defect.
 *
 *   PLATFORM PROTECTION — "is this safe for the platform and other tenants?"
 *     * `ai_concurrent_requests` — concurrency, enforced for EVERY mode.
 *     * `ai_byok_requests_month` — a fair-use / abuse ceiling for BYOK turns,
 *       deliberately far above any plausible clinic's usage. It is not a price.
 *     * The in-process provider concurrency ceiling and single bounded retry in
 *       `lib/ai/platform/provider-resilience.ts`.
 *     * Authorization, entitlement, safety gates, credential security, audit and
 *       the usage ledger — all unchanged and all still applied to BYOK.
 *
 *     All of these apply to every mode, always. BYOK is not unmetered; it is
 *     unmonetized.
 *
 * The database is the enforcement point, not this comment.
 * `ai_budget_reservations.consumes_managed_budget` records which side of the
 * split a turn is on, a CHECK constraint forbids a `managed` turn from being on
 * the free side, and `reconcile_ai_budget` refuses to book a single micro of
 * managed spend against a reservation that did not consume the managed budget.
 */

/**
 * Included-usage notification thresholds, as percentages of the effective
 * allowance. Constants rather than literals so the enforcement path, the
 * notification copy, the clinic meter and the owner console cannot drift apart.
 */
export const AI_USAGE_THRESHOLD_PERCENTS = {
  /** Informational: usage is getting high. */
  warning: 75,
  /** Critical: nearly exhausted; recommend configuring an Anthropic key. */
  critical: 90,
  /** Exhausted: managed turns are denied unless a BYOK key can take over. */
  exhausted: 100,
} as const;

export type AiUsageThresholdPercent =
  (typeof AI_USAGE_THRESHOLD_PERCENTS)[keyof typeof AI_USAGE_THRESHOLD_PERCENTS];

/** Ordered high→low so a caller picks the most severe threshold a value crosses. */
export const AI_USAGE_THRESHOLDS_DESCENDING = [
  AI_USAGE_THRESHOLD_PERCENTS.exhausted,
  AI_USAGE_THRESHOLD_PERCENTS.critical,
  AI_USAGE_THRESHOLD_PERCENTS.warning,
] as const;

export type AiUsageThreshold = "normal" | "warning" | "critical" | "exhausted";

/** Maps a consumed percentage onto the named threshold band. */
export function aiUsageThreshold(percent: number): AiUsageThreshold {
  if (percent >= AI_USAGE_THRESHOLD_PERCENTS.exhausted) return "exhausted";
  if (percent >= AI_USAGE_THRESHOLD_PERCENTS.critical) return "critical";
  if (percent >= AI_USAGE_THRESHOLD_PERCENTS.warning) return "warning";
  return "normal";
}

/** Every threshold at or below `percent`, most severe first. */
export function crossedAiUsageThresholds(
  percent: number,
): readonly AiUsageThresholdPercent[] {
  return AI_USAGE_THRESHOLDS_DESCENDING.filter((threshold) => percent >= threshold);
}
