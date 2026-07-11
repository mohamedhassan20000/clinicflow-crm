/**
 * Pure operator-panel domain helpers. Kept dependency-free so the issuance
 * quota and manual-grant period rules are unit-testable in isolation.
 */

export type IssuanceQuota = {
  acceptedThisWeek: number;
  pendingIssued: number;
  weeklyLimit: number;
};

/**
 * §3.2: the weekly limit never rejects a valid invitation at acceptance time;
 * the operator is warned/blocked at issuance instead. Projected acceptances =
 * already accepted this week + currently redeemable issued invitations.
 */
export function issuanceBlocked(quota: IssuanceQuota, force = false): boolean {
  if (force) return false;
  return quota.acceptedThisWeek + quota.pendingIssued >= quota.weeklyLimit;
}

/**
 * Coupon expiry from the operator form. A date-only value ("2026-08-01") is
 * inclusive: the coupon stays redeemable through the end of that day (UTC),
 * not just its first instant. Full ISO timestamps pass through unchanged.
 */
export function couponExpiryFromInput(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T23:59:59.999Z`;
  }
  return new Date(value).toISOString();
}

/**
 * Manual grant period: extends from the later of now and the current period
 * end (same accumulation rule as months_free coupons); null months = an
 * unbounded manual grant (current_period_end = null).
 */
export function manualGrantPeriod(
  months: number | null,
  currentPeriodEnd: string | null,
  now = new Date(),
): { current_period_start: string; current_period_end: string | null } {
  if (months === null) {
    return { current_period_start: now.toISOString(), current_period_end: null };
  }
  const existing = currentPeriodEnd ? new Date(currentPeriodEnd) : null;
  const base = existing && existing.getTime() > now.getTime() ? existing : now;
  const end = new Date(base);
  const day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));
  return { current_period_start: now.toISOString(), current_period_end: end.toISOString() };
}
