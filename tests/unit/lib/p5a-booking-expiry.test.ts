import { beforeEach, describe, expect, it, vi } from "vitest";

const expire = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/admin", () => ({ expireAiPendingBookings: expire }));

import { runAiPendingBookingExpiry } from "@/lib/booking/expiry";

beforeEach(() => vi.clearAllMocks());

describe("P5A pending booking expiry cron core", () => {
  it("returns the database-owned terminal expiry count", async () => {
    expire.mockResolvedValue({ data: [{ expired_count: 3 }], error: null });
    const now = new Date("2026-07-27T10:00:00Z");
    await expect(runAiPendingBookingExpiry(now)).resolves.toEqual({ expired: 3 });
    expect(expire).toHaveBeenCalledWith(now);
  });

  it("fails the sub-job when the atomic expiry RPC fails", async () => {
    expire.mockResolvedValue({ data: null, error: new Error("db unavailable") });
    await expect(runAiPendingBookingExpiry()).rejects.toThrow("db unavailable");
  });
});
