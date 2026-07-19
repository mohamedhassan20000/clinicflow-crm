import { describe, expect, it, vi } from "vitest";

// Surface-level authorization for the doctor assistant (§9.1, §6.7): identity
// from the session, ai_assistant entitlement, and role are all enforced before
// any tool runs. The model never influences these checks.

const DOCTOR = {
  id: "11111111-1111-4111-8111-111111111111",
  clinicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  role: "doctor" as const,
  email: "doc@clinic.test",
  fullName: "Dr House",
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
};

async function loadAuth(opts: {
  user: typeof DOCTOR | null;
  subscriptionAllowed?: boolean;
  aiFeature?: boolean;
  visibility?: "visible" | "hidden" | "lookup_failed";
}) {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  vi.doMock("@/lib/rbac", () => ({
    getAuthedUser: vi.fn(async () => opts.user),
  }));
  vi.doMock("@/lib/entitlements", () => ({
    getEntitlements: vi.fn(async () => ({
      clinicId: DOCTOR.clinicId,
      planSlug: "pro_ai",
      features: { ai_assistant: opts.aiFeature ?? true },
      limits: {},
      subscriptionAllowed: opts.subscriptionAllowed ?? true,
    })),
    hasFeature: (ents: { subscriptionAllowed: boolean; features: Record<string, boolean> }, key: string) =>
      ents.subscriptionAllowed && ents.features[key] === true,
  }));
  vi.doMock("@/lib/server-page-permissions", () => ({
    getPageVisibilityState: vi.fn(async () => opts.visibility ?? "visible"),
  }));
  return import("@/lib/ai/authorization");
}

describe("authorizeStaffAssistant", () => {
  it.each(["admin", "manager", "doctor", "receptionist"] as const)(
    "authorizes an entitled %s",
    async (role) => {
      const { authorizeStaffAssistant } = await loadAuth({
        user: { ...DOCTOR, role: role as never },
      });
      await expect(authorizeStaffAssistant()).resolves.toMatchObject({
        id: DOCTOR.id,
        role,
      });
    },
  );

  it("rejects an unauthenticated request", async () => {
    const { authorizeStaffAssistant } = await loadAuth({ user: null });
    await expect(authorizeStaffAssistant()).rejects.toMatchObject({ reason: "unauthenticated" });
  });

  it("rejects a clinic without the ai_assistant entitlement", async () => {
    const { authorizeStaffAssistant } = await loadAuth({ user: DOCTOR, aiFeature: false });
    await expect(authorizeStaffAssistant()).rejects.toMatchObject({
      reason: "feature_not_entitled",
    });
  });

  it("rejects an inactive subscription", async () => {
    const { authorizeStaffAssistant } = await loadAuth({
      user: DOCTOR,
      subscriptionAllowed: false,
    });
    await expect(authorizeStaffAssistant()).rejects.toMatchObject({
      reason: "subscription_inactive",
    });
  });

  it("rejects direct access when the admin saved Assistant as hidden", async () => {
    const { authorizeStaffAssistant } = await loadAuth({ user: DOCTOR, visibility: "hidden" });
    await expect(authorizeStaffAssistant()).rejects.toMatchObject({ reason: "page_hidden" });
  });

  it("fails closed when Assistant visibility cannot be verified", async () => {
    const { authorizeStaffAssistant } = await loadAuth({
      user: DOCTOR,
      visibility: "lookup_failed",
    });
    await expect(authorizeStaffAssistant()).rejects.toMatchObject({ reason: "lookup_failed" });
  });

  it("keeps clinical tool authorization doctor-only", async () => {
    const { assertClinicalToolAccess } = await loadAuth({
      user: { ...DOCTOR, role: "admin" as never },
    });
    await expect(
      assertClinicalToolAccess({ ...DOCTOR, role: "admin" as never }),
    ).rejects.toMatchObject({ reason: "role_forbidden" });
  });
});

async function loadUsage(resolution: {
  allowed: boolean;
  reason?: "allowed" | "limit_reached" | "subscription_inactive" | "lookup_failed";
  used?: number;
  limit?: number;
  remaining?: number;
}) {
  vi.resetModules();
  const captureMessage = vi.fn();
  const captureException = vi.fn();
  vi.doMock("server-only", () => ({}));
  vi.doMock("@sentry/nextjs", () => ({ captureMessage, captureException }));
  vi.doMock("@/lib/entitlements", () => ({
    checkUsageLimit: vi.fn(async () => ({
      used: 0,
      limit: 10,
      remaining: 10,
      reason: "allowed",
      ...resolution,
    })),
  }));
  const usage = await import("@/lib/ai/usage");
  return {
    ...usage,
    captureMessage,
    captureException,
  };
}

describe("P4A AI turn usage enforcement (§6.7)", () => {
  it("throws usage_limit_reached when the monthly cap is reached", async () => {
    const { assertAiTurnAllowed } = await loadUsage({
      allowed: false,
      reason: "limit_reached",
    });
    await expect(assertAiTurnAllowed(DOCTOR.clinicId)).rejects.toMatchObject({
      reason: "usage_limit_reached",
    });
  });

  it("classifies a lookup failure as temporary infrastructure failure", async () => {
    const { assertAiTurnAllowed, captureMessage } = await loadUsage({
      allowed: false,
      reason: "lookup_failed",
    });
    await expect(assertAiTurnAllowed(DOCTOR.clinicId)).rejects.toMatchObject({
      reason: "lookup_failed",
      message: "AI usage is temporarily unavailable. Please try again.",
    });
    expect(captureMessage).toHaveBeenCalledWith(
      "AI usage limit lookup failed",
      expect.objectContaining({ level: "error" }),
    );
  });

});
