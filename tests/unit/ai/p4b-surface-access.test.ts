import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  entitlements: vi.fn(),
  hasFeature: vi.fn(),
  usage: vi.fn(),
  visibility: vi.fn(),
  conversation: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@/lib/entitlements", () => ({
  getEntitlements: mocks.entitlements,
  hasFeature: mocks.hasFeature,
}));
vi.mock("@/lib/ai/usage", () => ({ checkAiTurn: mocks.usage }));
vi.mock("@/lib/server-page-permissions", () => ({
  getPageVisibilityState: mocks.visibility,
}));
vi.mock("@/lib/ai/conversations", () => ({
  loadLatestDoctorConversation: mocks.conversation,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));

import {
  getStaffAssistantSurfaceAccess,
  resolvePatientAssistantLauncher,
  resolveStaffAssistantPage,
} from "@/lib/ai/surface";

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
  mocks.visibility.mockResolvedValue("visible");
  mocks.conversation.mockResolvedValue(null);
});

describe("P4B assistant surface access", () => {
  it("returns the remaining allowance for an entitled clinic", async () => {
    await expect(getStaffAssistantSurfaceAccess(user)).resolves.toEqual({
      state: "available",
      remaining: 19,
      limit: 20,
    });
  });

  it("shows an upgrade gate when the plan lacks the feature", async () => {
    mocks.hasFeature.mockReturnValue(false);
    await expect(getStaffAssistantSurfaceAccess(user)).resolves.toEqual({ state: "upgrade" });
    expect(mocks.usage).not.toHaveBeenCalled();
  });

  it("shows cap degradation and temporary lookup failure distinctly", async () => {
    mocks.usage.mockResolvedValueOnce({ allowed: false, remaining: 0, limit: 100, reason: "limit_reached" });
    await expect(getStaffAssistantSurfaceAccess(user)).resolves.toEqual({ state: "cap_reached", limit: 100 });

    mocks.usage.mockResolvedValueOnce({ allowed: false, remaining: 0, limit: 0, reason: "lookup_failed" });
    await expect(getStaffAssistantSurfaceAccess(user)).resolves.toEqual({ state: "temporarily_unavailable" });
  });

  it.each(["admin", "manager", "doctor", "receptionist"] as const)(
    "resolves a controlled Assistant page for %s",
    async (role) => {
      await expect(resolveStaffAssistantPage({ ...user, role })).resolves.toMatchObject({
        state: "render",
        access: { state: "available" },
      });
    },
  );

  it("turns missing conversation persistence into a localized unavailable state", async () => {
    mocks.conversation.mockRejectedValueOnce(new Error("PGRST205"));
    await expect(resolveStaffAssistantPage(user)).resolves.toEqual({
      state: "render",
      access: { state: "temporarily_unavailable" },
      conversation: null,
    });
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  it("keeps the patient launcher doctor-only and optional", async () => {
    await expect(resolvePatientAssistantLauncher({
      user: { ...user, role: "receptionist" },
      patientId: "patient-1",
    })).resolves.toBeNull();

    mocks.conversation.mockRejectedValueOnce(new Error("PGRST205"));
    await expect(resolvePatientAssistantLauncher({
      user,
      patientId: "patient-1",
    })).resolves.toBeNull();
  });

  it("keeps the patient page usable when an Assistant entitlement dependency throws", async () => {
    mocks.entitlements.mockRejectedValueOnce(new Error("entitlement dependency unavailable"));
    await expect(resolvePatientAssistantLauncher({
      user,
      patientId: "patient-1",
    })).resolves.toBeNull();
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "entitlement dependency unavailable" }),
      expect.objectContaining({ tags: { area: "patient-assistant-launcher" } }),
    );
  });
});
