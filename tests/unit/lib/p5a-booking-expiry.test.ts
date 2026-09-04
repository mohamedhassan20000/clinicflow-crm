import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  expireBookings: vi.fn(),
  expireRequests: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({
  expireAiPendingBookings: mocks.expireBookings,
  expireAiAppointmentRequests: mocks.expireRequests,
}));

import { runAiPendingBookingExpiry } from "@/lib/booking/expiry";

beforeEach(() => vi.clearAllMocks());

describe("P5A pending booking expiry cron core", () => {
  it("returns the database-owned terminal expiry count", async () => {
    mocks.expireBookings.mockResolvedValue({ data: [{ expired_count: 3 }], error: null });
    mocks.expireRequests.mockResolvedValue({ data: [{ expired_count: 2 }], error: null });
    const now = new Date("2026-07-27T10:00:00Z");
    await expect(runAiPendingBookingExpiry(now)).resolves.toEqual({
      expired: 3,
      expiredRequests: 2,
    });
    expect(mocks.expireBookings).toHaveBeenCalledWith(now);
    expect(mocks.expireRequests).toHaveBeenCalledWith(now);
  });

  it("fails the sub-job when the atomic expiry RPC fails", async () => {
    mocks.expireBookings.mockResolvedValue({ data: null, error: new Error("db unavailable") });
    mocks.expireRequests.mockResolvedValue({ data: [{ expired_count: 0 }], error: null });
    await expect(runAiPendingBookingExpiry()).rejects.toThrow("db unavailable");
  });

  it("fails the sub-job when provisional request expiry fails", async () => {
    mocks.expireBookings.mockResolvedValue({ data: [{ expired_count: 0 }], error: null });
    mocks.expireRequests.mockResolvedValue({ data: null, error: new Error("request expiry unavailable") });
    await expect(runAiPendingBookingExpiry()).rejects.toThrow(
      "request expiry unavailable",
    );
  });
});
