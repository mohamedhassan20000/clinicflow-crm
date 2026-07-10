import type { SubscriptionStatus } from "@/lib/billing/types";

export type SubscriptionAccessRow = {
  status: SubscriptionStatus;
  trial_ends_at: string | null;
  current_period_end: string | null;
};

export type SubscriptionAccessReason =
  | "active"
  | "trial_active"
  | "trial_expired"
  | "inactive"
  | "missing"
  | "lookup_failed";

export type SubscriptionAccess = {
  allowed: boolean;
  reason: SubscriptionAccessReason;
};

export function resolveSubscriptionAccess(
  subscription: SubscriptionAccessRow | null,
  now = new Date(),
): SubscriptionAccess {
  if (!subscription) return { allowed: false, reason: "missing" };
  if (subscription.status === "active") {
    const periodExpired = subscription.current_period_end
      ? new Date(subscription.current_period_end).getTime() <= now.getTime()
      : false;
    return { allowed: !periodExpired, reason: periodExpired ? "inactive" : "active" };
  }
  if (subscription.status === "trialing") {
    const trialActive = Boolean(
      subscription.trial_ends_at &&
        new Date(subscription.trial_ends_at).getTime() > now.getTime(),
    );
    return { allowed: trialActive, reason: trialActive ? "trial_active" : "trial_expired" };
  }
  return { allowed: false, reason: "inactive" };
}

