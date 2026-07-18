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
  return import("@/lib/ai/authorization");
}

describe("authorizeDoctorAssistant", () => {
  it("authorizes an entitled doctor", async () => {
    const { authorizeDoctorAssistant } = await loadAuth({ user: DOCTOR });
    await expect(authorizeDoctorAssistant()).resolves.toMatchObject({ id: DOCTOR.id });
  });

  it("rejects an unauthenticated request", async () => {
    const { authorizeDoctorAssistant } = await loadAuth({ user: null });
    await expect(authorizeDoctorAssistant()).rejects.toMatchObject({ reason: "unauthenticated" });
  });

  it("rejects a forbidden role", async () => {
    const { authorizeDoctorAssistant } = await loadAuth({
      user: { ...DOCTOR, role: "receptionist" as never },
    });
    await expect(authorizeDoctorAssistant()).rejects.toMatchObject({ reason: "role_forbidden" });
  });

  it("rejects a clinic without the ai_assistant entitlement", async () => {
    const { authorizeDoctorAssistant } = await loadAuth({ user: DOCTOR, aiFeature: false });
    await expect(authorizeDoctorAssistant()).rejects.toMatchObject({
      reason: "feature_not_entitled",
    });
  });

  it("rejects an inactive subscription", async () => {
    const { authorizeDoctorAssistant } = await loadAuth({
      user: DOCTOR,
      subscriptionAllowed: false,
    });
    await expect(authorizeDoctorAssistant()).rejects.toMatchObject({
      reason: "subscription_inactive",
    });
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
  const incrementClinicUsage = vi.fn();
  const releaseClinicUsage = vi.fn();
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
  vi.doMock("@/lib/supabase/admin", () => ({ incrementClinicUsage, releaseClinicUsage }));
  const usage = await import("@/lib/ai/usage");
  return {
    ...usage,
    captureMessage,
    captureException,
    incrementClinicUsage,
    releaseClinicUsage,
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

  it("atomically reserves a unit and returns the authoritative remaining count", async () => {
    const { reserveAiTurn, incrementClinicUsage } = await loadUsage({
      allowed: true,
      reason: "allowed",
      used: 4,
      limit: 10,
      remaining: 6,
    });
    incrementClinicUsage.mockResolvedValueOnce({ data: 5, error: null });
    await expect(reserveAiTurn(DOCTOR.clinicId)).resolves.toEqual({
      used: 5,
      limit: 10,
      remaining: 5,
      periodStart: expect.stringMatching(/^\d{4}-\d{2}-01$/),
    });
    expect(incrementClinicUsage).toHaveBeenCalledWith(
      DOCTOR.clinicId,
      "ai_messages",
      1,
      expect.stringMatching(/^\d{4}-\d{2}-01$/),
    );
  });

  it("maps an atomic reservation race loss to usage_limit_reached", async () => {
    const { reserveAiTurn, incrementClinicUsage } = await loadUsage({
      allowed: true,
      reason: "allowed",
    });
    incrementClinicUsage.mockResolvedValueOnce({
      data: null,
      error: { message: "USAGE_LIMIT_EXCEEDED" },
    });
    await expect(reserveAiTurn(DOCTOR.clinicId)).rejects.toMatchObject({
      reason: "usage_limit_reached",
    });
  });

  it("swallows and captures reservation-release failures", async () => {
    const { releaseAiTurn, releaseClinicUsage, captureException } = await loadUsage({
      allowed: true,
      reason: "allowed",
    });
    releaseClinicUsage.mockRejectedValueOnce(new Error("counter unavailable"));
    await expect(releaseAiTurn(DOCTOR.clinicId, "2026-07-01")).resolves.toBeUndefined();
    expect(releaseClinicUsage).toHaveBeenCalledWith(
      DOCTOR.clinicId,
      "ai_messages",
      1,
      "2026-07-01",
    );
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "counter unavailable" }),
      expect.objectContaining({ tags: { area: "ai-usage-release" } }),
    );
  });
});
