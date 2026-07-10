import type { Database, Json } from "@/types/database";

export type SubscriptionStatus =
  Database["public"]["Enums"]["subscription_status"];
export type CouponKind = Database["public"]["Enums"]["coupon_kind"];

export type BillingSubscription =
  Database["public"]["Tables"]["subscriptions"]["Row"];

export type SubscriptionPatch = Pick<
  Database["public"]["Tables"]["subscriptions"]["Update"],
  | "plan_id"
  | "status"
  | "trial_ends_at"
  | "current_period_start"
  | "current_period_end"
  | "provider_subscription_id"
>;

export type CheckoutRequest = {
  clinicId: string;
  planId: string;
  successUrl: string;
  cancelUrl: string;
};

export type CheckoutResult = { url: string };

export type ProviderWebhook = {
  id: string;
  type: string;
  payload: Json;
};

export type CouponEffect =
  | { kind: "lifetime_free"; compedUntil: null; discountPercent: 100 }
  | { kind: "months_free"; compedUntil: string | null; discountPercent: 100 }
  | { kind: "percent_discount"; compedUntil: null; discountPercent: number };
