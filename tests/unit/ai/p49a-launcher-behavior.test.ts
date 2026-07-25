import { describe, expect, it, vi } from "vitest";

type Role = "admin" | "manager" | "receptionist" | "doctor";

const BASE_FEATURES = {
  ai_assistant: true,
  "ai.staff_assistant": true,
  "ai.staff_analytics": true,
  "ai.financial_insights": true,
  "ai.assistant_customization": true,
};

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  clinicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "staff@clinic.test",
  role: "doctor" as Role,
  fullName: "Test Staff",
  avatarUrl: null,
  departmentId: "22222222-2222-4222-8222-222222222222",
  mustChangePassword: false,
};

type Scenario = {
  role?: Role;
  roleSetting?: boolean;
  userOverride?: boolean;
  features?: Record<string, boolean>;
  financialPermission?: boolean;
  area?: "dashboard" | "revenue";
};

async function observeScenario(input: Scenario = {}) {
  vi.resetModules();
  const user = { ...USER, role: input.role ?? "doctor" };
  const features: Record<string, boolean> = {
    ...BASE_FEATURES,
    ...input.features,
  };
  const financialPermission = input.financialPermission ?? true;

  vi.doMock("server-only", () => ({}));
  vi.doMock("@sentry/nextjs", () => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  }));
  vi.doMock("@/lib/entitlements", () => ({
    getEntitlements: async () => ({
      clinicId: user.clinicId,
      planSlug: "pro_ai",
      features,
      limits: {},
      subscriptionAllowed: true,
    }),
    hasFeature: (
      entitlements: { subscriptionAllowed: boolean; features: Record<string, boolean> },
      feature: string,
    ) => entitlements.subscriptionAllowed && entitlements.features[feature] === true,
  }));
  vi.doMock("@/lib/server-page-permissions", () => ({
    getPageVisibilityState: async () => "visible",
  }));
  vi.doMock("@/lib/ai/permissions", () => ({
    hasAiUserPermission: async () => financialPermission,
  }));
  vi.doMock("@/lib/supabase/admin", () => ({
    createClinicScopedAdminClient: () => ({
      from: (table: string) => {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({
            data:
              table === "assistant_launcher_settings"
                ? input.roleSetting === undefined
                  ? null
                  : { enabled: input.roleSetting }
                : input.userOverride === undefined
                  ? null
                  : { enabled: input.userOverride },
            error: null,
          }),
        };
        return builder;
      },
    }),
  }));
  vi.doMock("@/lib/ai/surface", () => ({
    getStaffAssistantSurfaceAccess: async (
      _user: unknown,
      requiredFeatures: readonly string[],
    ) =>
      requiredFeatures.every((feature) => features[feature] === true)
        ? { state: "available", remaining: 19, limit: 20 }
        : { state: "upgrade" },
    loadAssistantConversationForSurface: async () => ({
      conversation: null,
      persistenceAvailable: true,
    }),
  }));
  vi.doMock("@/lib/ai/capabilities", () => ({
    resolveAssistantCapabilities: async () => ({ toolNames: [], items: [] }),
  }));
  vi.doMock("@/lib/ai/conversations", () => ({
    assertDoctorPatientContextAccess: async () => undefined,
  }));
  vi.doMock("@/lib/ai/persistence-readiness", () => ({
    isAssistantPersistenceReady: async () => true,
  }));
  vi.doMock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
  vi.doMock("@/lib/ai/audit", () => ({ logAgentTool: async () => undefined }));

  const [{ resolveAssistantLauncher, resolveAssistantLauncherSession }, authorization, tools] =
    await Promise.all([
      import("@/lib/ai/launchers"),
      import("@/lib/ai/authorization"),
      import("@/lib/ai/tools"),
    ]);
  const context =
    input.area === "revenue"
      ? {
          type: "revenue" as const,
          dateRange: { from: "2026-07-01", to: "2026-07-31" },
        }
      : { type: "dashboard" as const };

  const launcher = await resolveAssistantLauncher({ user: user as never, context });
  const session = await resolveAssistantLauncherSession({
    user: user as never,
    context,
  });
  let directAuthorization: "allowed" | string = "allowed";
  try {
    await authorization.assertStaffToolAccess(user as never);
  } catch (error) {
    directAuthorization = (error as { reason?: string }).reason ?? "error";
  }
  let financialAuthorization: "allowed" | string = "allowed";
  try {
    await authorization.assertFinancialInsightsAccess(user as never);
  } catch (error) {
    financialAuthorization = (error as { reason?: string }).reason ?? "error";
  }
  const mount = await tools.resolveToolMount({ user: user as never, locale: "en" });

  return {
    launcherVisible: launcher !== null,
    sessionAvailable: session !== null,
    directAuthorization,
    financialAuthorization,
    toolNames: Object.keys(mount.tools).sort(),
  };
}

describe("P49A-M2 — launcher placement is behaviorally isolated", () => {
  it("keeps direct Assistant authorization and the complete tool mount identical across placement changes", async () => {
    const defaulted = await observeScenario();
    const roleDisabled = await observeScenario({ roleSetting: false });
    const userDisabled = await observeScenario({ userOverride: false });
    const userEnabled = await observeScenario({
      roleSetting: false,
      userOverride: true,
    });

    expect(defaulted.launcherVisible).toBe(true);
    expect(roleDisabled.launcherVisible).toBe(false);
    expect(userDisabled.launcherVisible).toBe(false);
    expect(userEnabled.launcherVisible).toBe(true);
    expect(roleDisabled.sessionAvailable).toBe(false);
    expect(userDisabled.sessionAvailable).toBe(false);

    for (const result of [defaulted, roleDisabled, userDisabled, userEnabled]) {
      expect(result.directAuthorization).toBe("allowed");
      expect(result.toolNames).toEqual(defaulted.toolNames);
      expect(result.toolNames).toContain("get_patient_summary");
    }
  });

  it("cannot use an enabled override to bypass a launcher's role restriction", async () => {
    const result = await observeScenario({
      role: "doctor",
      area: "revenue",
      roleSetting: true,
      userOverride: true,
    });

    expect(result.launcherVisible).toBe(false);
    expect(result.sessionAvailable).toBe(false);
    expect(result.toolNames).not.toContain("get_revenue_summary");
    expect(result.toolNames).not.toContain("compare_revenue_periods");
    expect(result.financialAuthorization).toBe("role_forbidden");
  });

  it("cannot use an enabled override to bypass the financial permission gate", async () => {
    const result = await observeScenario({
      role: "manager",
      area: "revenue",
      userOverride: true,
      financialPermission: false,
    });

    expect(result.launcherVisible).toBe(false);
    expect(result.sessionAvailable).toBe(false);
    expect(result.directAuthorization).toBe("allowed");
    expect(result.toolNames).not.toContain("get_revenue_summary");
    expect(result.toolNames).not.toContain("compare_revenue_periods");
    expect(result.toolNames).not.toContain("list_outstanding_invoices");
    expect(result.financialAuthorization).toBe("permission_not_granted");
  });

  it("cannot use an enabled override to bypass the financial entitlement", async () => {
    const result = await observeScenario({
      role: "manager",
      area: "revenue",
      userOverride: true,
      features: { "ai.financial_insights": false },
      financialPermission: true,
    });

    expect(result.launcherVisible).toBe(false);
    expect(result.sessionAvailable).toBe(false);
    expect(result.toolNames).not.toContain("get_revenue_summary");
    expect(result.toolNames).not.toContain("compare_revenue_periods");
    expect(result.financialAuthorization).toBe("feature_not_entitled");
  });
});
