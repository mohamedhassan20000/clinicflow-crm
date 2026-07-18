import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  entitlements: vi.fn(),
  hasFeature: vi.fn(),
  usage: vi.fn(),
}));

vi.mock("@/lib/entitlements", () => ({
  getEntitlements: mocks.entitlements,
  hasFeature: mocks.hasFeature,
}));
vi.mock("@/lib/ai/usage", () => ({ checkAiTurn: mocks.usage }));

import { getDoctorAssistantSurfaceAccess } from "@/lib/ai/surface";

const user = {
  id: "user-1",
  clinicId: "clinic-1",
  email: "doctor@example.com",
  role: "doctor" as const,
  fullName: "Doctor",
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.entitlements.mockResolvedValue({ subscriptionAllowed: true });
  mocks.hasFeature.mockReturnValue(true);
  mocks.usage.mockResolvedValue({ allowed: true, remaining: 19, limit: 20, reason: "allowed" });
});

describe("P4B assistant surface access", () => {
  it("returns the remaining allowance for an entitled clinic", async () => {
    await expect(getDoctorAssistantSurfaceAccess(user)).resolves.toEqual({
      state: "available",
      remaining: 19,
      limit: 20,
    });
  });

  it("shows an upgrade gate when the plan lacks the feature", async () => {
    mocks.hasFeature.mockReturnValue(false);
    await expect(getDoctorAssistantSurfaceAccess(user)).resolves.toEqual({ state: "upgrade" });
    expect(mocks.usage).not.toHaveBeenCalled();
  });

  it("shows cap degradation and temporary lookup failure distinctly", async () => {
    mocks.usage.mockResolvedValueOnce({ allowed: false, remaining: 0, limit: 100, reason: "limit_reached" });
    await expect(getDoctorAssistantSurfaceAccess(user)).resolves.toEqual({ state: "cap_reached", limit: 100 });

    mocks.usage.mockResolvedValueOnce({ allowed: false, remaining: 0, limit: 0, reason: "lookup_failed" });
    await expect(getDoctorAssistantSurfaceAccess(user)).resolves.toEqual({ state: "temporarily_unavailable" });
  });
});
