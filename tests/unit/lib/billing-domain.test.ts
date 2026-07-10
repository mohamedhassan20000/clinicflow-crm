import { describe, expect, it } from "vitest";
import { resolveSubscriptionAccess, SubscriptionAccessError } from "@/lib/billing/subscriptions";
import { resolveCouponEffect, validateCoupon, CouponRedemptionError } from "@/lib/billing/coupons";
import { manualBillingProvider } from "@/lib/billing/manual";
import { UnsupportedBillingOperationError } from "@/lib/billing/provider";
import type { Database } from "@/types/database";

type Subscription = Database["public"]["Tables"]["subscriptions"]["Row"];
type Coupon = Database["public"]["Tables"]["coupons"]["Row"];

const now = new Date("2026-07-10T12:00:00.000Z");
const subscription: Subscription = {
  id: "subscription-1",
  clinic_id: "clinic-1",
  plan_id: "plan-1",
  provider: "manual",
  provider_subscription_id: null,
  status: "trialing",
  trial_ends_at: "2026-07-20T12:00:00.000Z",
  current_period_start: null,
  current_period_end: null,
  created_at: now.toISOString(),
  updated_at: now.toISOString(),
};

function coupon(values: Partial<Coupon>): Coupon {
  return {
    id: "coupon-1",
    code: "TEST",
    kind: "lifetime_free",
    months: null,
    percent: null,
    expires_at: null,
    max_redemptions: null,
    redemption_count: 0,
    clinic_id: null,
    invitation_id: null,
    is_active: true,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...values,
  };
}

describe("billing subscription lifecycle", () => {
  it("allows active trials and fails closed for expired, missing, and ended active periods", () => {
    expect(resolveSubscriptionAccess(subscription, now).reason).toBe("trial_active");
    expect(
      resolveSubscriptionAccess({ ...subscription, trial_ends_at: now.toISOString() }, now),
    ).toMatchObject({ allowed: false, reason: "trial_expired" });
    expect(resolveSubscriptionAccess(null, now)).toMatchObject({ allowed: false, reason: "missing" });
    expect(
      resolveSubscriptionAccess(
        { ...subscription, status: "active", current_period_end: now.toISOString() },
        now,
      ),
    ).toMatchObject({ allowed: false, reason: "inactive" });
  });

  it("manual provider has no checkout/webhook surface and cancels provider-neutrally", async () => {
    await expect(
      manualBillingProvider.createCheckout({
        clinicId: "clinic-1",
        planId: "plan-1",
        successUrl: "https://example.com/success",
        cancelUrl: "https://example.com/cancel",
      }),
    ).rejects.toBeInstanceOf(UnsupportedBillingOperationError);
    await expect(manualBillingProvider.verifySignature(new Request("https://example.com"))).resolves.toBe(false);
    await expect(manualBillingProvider.cancelSubscription(subscription)).resolves.toMatchObject({
      status: "cancelled",
      provider_subscription_id: null,
    });
  });

  it("exposes stable domain errors for subscription gates", () => {
    expect(new SubscriptionAccessError("trial_expired")).toMatchObject({
      code: "SUBSCRIPTION_REQUIRED",
      reason: "trial_expired",
    });
  });
});

describe("coupon domain", () => {
  it("enforces expiry, activity, usage limit, clinic, and invitation assignment", () => {
    const cases: Array<[Coupon, CouponRedemptionError["code"]]> = [
      [coupon({ is_active: false }), "COUPON_INACTIVE"],
      [coupon({ expires_at: now.toISOString() }), "COUPON_EXPIRED"],
      [coupon({ max_redemptions: 2, redemption_count: 2 }), "COUPON_LIMIT_REACHED"],
      [coupon({ clinic_id: "clinic-2" }), "COUPON_NOT_ASSIGNED"],
      [coupon({ invitation_id: "invite-2" }), "COUPON_NOT_ASSIGNED"],
    ];
    for (const [value, code] of cases) {
      expect(() => validateCoupon(value, { clinicId: "clinic-1", invitationId: "invite-1", now })).toThrowError(
        expect.objectContaining({ code }),
      );
    }
  });

  it("applies lifetime, one-year/X-month, and percentage effects", () => {
    const lifetime = resolveCouponEffect(coupon({}), subscription, now);
    expect(lifetime).toMatchObject({
      effect: { kind: "lifetime_free", compedUntil: null, discountPercent: 100 },
      subscriptionUpdate: { status: "active", current_period_end: null },
    });

    const months = resolveCouponEffect(coupon({ kind: "months_free", months: 12 }), subscription, now);
    expect(months.effect).toEqual({
      kind: "months_free",
      compedUntil: "2027-07-20T12:00:00.000Z",
      discountPercent: 100,
    });

    const percentage = resolveCouponEffect(
      coupon({ kind: "percent_discount", percent: 25 }),
      subscription,
      now,
    );
    expect(percentage).toEqual({
      effect: { kind: "percent_discount", compedUntil: null, discountPercent: 25 },
      subscriptionUpdate: {},
    });
  });

  it("does not truncate an unbounded active grant with months_free", () => {
    const result = resolveCouponEffect(
      coupon({ kind: "months_free", months: 3 }),
      { ...subscription, status: "active", trial_ends_at: null, current_period_end: null },
      now,
    );
    expect(result).toEqual({
      effect: { kind: "months_free", compedUntil: null, discountPercent: 100 },
      subscriptionUpdate: {},
    });
  });
});
