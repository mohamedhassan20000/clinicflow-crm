import "server-only";
import type {
  BillingSubscription,
  CheckoutRequest,
  CheckoutResult,
  ProviderWebhook,
  SubscriptionPatch,
} from "@/lib/billing/types";

/**
 * Gateway-neutral boundary for SaaS billing providers. Domain callers depend on
 * this contract; provider SDK objects must never escape an adapter.
 */
export interface BillingProvider {
  readonly id: string;
  createCheckout(request: CheckoutRequest): Promise<CheckoutResult>;
  syncSubscriptionFromProvider(
    providerSubscriptionId: string,
  ): Promise<SubscriptionPatch>;
  cancelSubscription(subscription: BillingSubscription): Promise<SubscriptionPatch>;
  verifySignature(request: Request): Promise<boolean>;
  parseWebhook(request: Request): Promise<ProviderWebhook>;
}

export class UnsupportedBillingOperationError extends Error {
  constructor(operation: string) {
    super(`The manual billing provider does not support ${operation}.`);
    this.name = "UnsupportedBillingOperationError";
  }
}

