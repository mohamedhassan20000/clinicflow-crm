import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ rpc: mocks.rpc })),
}));
vi.mock("next/cache", () => ({
  revalidateTag: mocks.revalidateTag,
}));

import { redeemCoupon } from "@/lib/billing/coupons";

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.revalidateTag.mockReset();
});

describe("coupon redemption action", () => {
  it("delegates to the atomic RPC and invalidates clinic entitlements", async () => {
    mocks.rpc.mockResolvedValue({
      data: { kind: "lifetime_free", compedUntil: null, discountPercent: 100 },
      error: null,
    });
    await expect(redeemCoupon({ clinicId: "clinic-1", code: " launch " })).resolves.toMatchObject({
      kind: "lifetime_free",
    });
    expect(mocks.rpc).toHaveBeenCalledWith("redeem_coupon", {
      p_clinic_id: "clinic-1",
      p_code: "LAUNCH",
    });
    expect(mocks.revalidateTag).toHaveBeenCalledWith("entitlements:clinic-1", { expire: 0 });
  });

  it("does not invalidate after a failed transaction and maps the domain error", async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: "COUPON_LIMIT_REACHED" },
    });
    await expect(redeemCoupon({ clinicId: "clinic-1", code: "LIMITED" })).rejects.toMatchObject({
      code: "COUPON_LIMIT_REACHED",
    });
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  it("passes invitation identity only for RPC-side ownership validation", async () => {
    mocks.rpc.mockResolvedValue({
      data: { kind: "percent_discount", compedUntil: null, discountPercent: 10 },
      error: null,
    });
    await redeemCoupon({ clinicId: "clinic-1", code: "INVITED", invitationId: "invitation-1" });
    expect(mocks.rpc).toHaveBeenCalledWith("redeem_coupon", {
      p_clinic_id: "clinic-1",
      p_code: "INVITED",
      p_invitation_id: "invitation-1",
    });
  });
});

