import "server-only";
import type { BillingProvider } from "@/lib/billing/provider";
import { UnsupportedBillingOperationError } from "@/lib/billing/provider";

/** P1's only provider. State changes are explicit operator-issued grants. */
export const manualBillingProvider: BillingProvider = {
  id: "manual",
  async createCheckout() {
    throw new UnsupportedBillingOperationError("checkout");
  },
  async syncSubscriptionFromProvider() {
    throw new UnsupportedBillingOperationError("provider synchronization");
  },
  // Manual cancellation is immediate: status=cancelled denies access at once.
  // The existing period end is retained as billing history, not an access grant.
  async cancelSubscription() {
    return {
      status: "cancelled",
      provider_subscription_id: null,
    };
  },
  async verifySignature() {
    return false;
  },
  async parseWebhook() {
    throw new UnsupportedBillingOperationError("webhooks");
  },
};
