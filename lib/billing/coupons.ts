import "server-only";
import { revalidateTag } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { CouponEffect } from "@/lib/billing/types";
import type { Database } from "@/types/database";

type Coupon = Database["public"]["Tables"]["coupons"]["Row"];
type Subscription = Database["public"]["Tables"]["subscriptions"]["Row"];

export class CouponRedemptionError extends Error {
  constructor(
    public readonly code:
      | "COUPON_NOT_FOUND"
      | "COUPON_INACTIVE"
      | "COUPON_EXPIRED"
      | "COUPON_LIMIT_REACHED"
      | "COUPON_NOT_ASSIGNED"
      | "COUPON_ALREADY_REDEEMED"
      | "COUPON_UNBOUNDED_GRANT"
      | "SUBSCRIPTION_NOT_FOUND"
      | "REDEMPTION_FAILED",
  ) {
    super(code.replaceAll("_", " ").toLowerCase());
    this.name = "CouponRedemptionError";
  }
}

function addUtcMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

export function validateCoupon(
  coupon: Coupon,
  input: { clinicId: string; invitationId?: string | null; now?: Date },
): void {
  const now = input.now ?? new Date();
  if (!coupon.is_active) throw new CouponRedemptionError("COUPON_INACTIVE");
  if (coupon.expires_at && new Date(coupon.expires_at).getTime() <= now.getTime()) {
    throw new CouponRedemptionError("COUPON_EXPIRED");
  }
  if (coupon.max_redemptions !== null && coupon.redemption_count >= coupon.max_redemptions) {
    throw new CouponRedemptionError("COUPON_LIMIT_REACHED");
  }
  if (coupon.clinic_id !== null && coupon.clinic_id !== input.clinicId) {
    throw new CouponRedemptionError("COUPON_NOT_ASSIGNED");
  }
  if (coupon.invitation_id !== null && coupon.invitation_id !== input.invitationId) {
    throw new CouponRedemptionError("COUPON_NOT_ASSIGNED");
  }
}

export function resolveCouponEffect(
  coupon: Coupon,
  subscription: Subscription,
  now = new Date(),
): { effect: CouponEffect; subscriptionUpdate: Database["public"]["Tables"]["subscriptions"]["Update"] } {
  if (coupon.kind === "lifetime_free") {
    return {
      effect: { kind: "lifetime_free", compedUntil: null, discountPercent: 100 },
      subscriptionUpdate: {
        status: "active",
        trial_ends_at: null,
        current_period_start: subscription.current_period_start ?? now.toISOString(),
        current_period_end: null,
      },
    };
  }
  if (coupon.kind === "months_free") {
    if (subscription.status === "active" && subscription.current_period_end === null) {
      return {
        effect: { kind: "months_free", compedUntil: null, discountPercent: 100 },
        subscriptionUpdate: {},
      };
    }
    const baseCandidates = [now, subscription.trial_ends_at, subscription.current_period_end]
      .filter((value): value is Date | string => Boolean(value))
      .map((value) => new Date(value));
    const base = new Date(Math.max(...baseCandidates.map((date) => date.getTime())));
    const compedUntil = addUtcMonths(base, coupon.months!).toISOString();
    return {
      effect: { kind: "months_free", compedUntil, discountPercent: 100 },
      subscriptionUpdate: {
        status: "active",
        trial_ends_at: null,
        current_period_start: subscription.current_period_start ?? now.toISOString(),
        current_period_end: compedUntil,
      },
    };
  }
  return {
    effect: { kind: "percent_discount", compedUntil: null, discountPercent: coupon.percent! },
    subscriptionUpdate: {},
  };
}

export async function redeemCoupon(input: {
  clinicId: string;
  code: string;
  /**
   * Untrusted request input is insufficient. The RPC accepts this value only
   * after verifying the invitation is accepted and belongs to clinicId.
   */
  invitationId?: string | null;
}): Promise<CouponEffect> {
  const client = await createClient();
  const rpcArgs: Database["public"]["Functions"]["redeem_coupon"]["Args"] = {
    p_clinic_id: input.clinicId,
    p_code: input.code.trim().toUpperCase(),
  };
  if (input.invitationId) rpcArgs.p_invitation_id = input.invitationId;
  const { data, error } = await client.rpc("redeem_coupon", rpcArgs);
  if (error) {
    const code = error.message.match(/COUPON_[A-Z_]+|SUBSCRIPTION_NOT_FOUND/)?.[0];
    throw new CouponRedemptionError(
      (code as CouponRedemptionError["code"] | undefined) ?? "REDEMPTION_FAILED",
    );
  }
  revalidateTag(`entitlements:${input.clinicId}`, { expire: 0 });
  return data as unknown as CouponEffect;
}
