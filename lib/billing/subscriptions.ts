import "server-only";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import {
  resolveSubscriptionAccess,
  type SubscriptionAccess,
  type SubscriptionAccessReason,
} from "@/lib/billing/access";

export { resolveSubscriptionAccess } from "@/lib/billing/access";

export async function getSubscriptionAccess(
  clinicId: string,
  now = new Date(),
): Promise<SubscriptionAccess> {
  try {
    const client = createClinicScopedAdminClient(clinicId);
    const { data, error } = await client
      .from("subscriptions")
      .select("*")
      .eq("clinic_id", clinicId)
      .maybeSingle();
    if (error) return { allowed: false, reason: "lookup_failed" };
    return resolveSubscriptionAccess(data, now);
  } catch {
    return { allowed: false, reason: "lookup_failed" };
  }
}

export class SubscriptionAccessError extends Error {
  readonly code = "SUBSCRIPTION_REQUIRED";
  constructor(public readonly reason: SubscriptionAccessReason) {
    super("An active subscription or trial is required for this operation.");
    this.name = "SubscriptionAccessError";
  }
}

export async function requireActiveSubscription(clinicId: string): Promise<void> {
  const access = await getSubscriptionAccess(clinicId);
  if (!access.allowed) throw new SubscriptionAccessError(access.reason);
}
