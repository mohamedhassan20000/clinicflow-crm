import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  visibility: vi.fn(),
  surfaceAccess: vi.fn(),
  loadConversation: vi.fn(),
  capabilities: vi.fn(),
  permission: vi.fn(),
  patientAccess: vi.fn(),
  persistenceReady: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@/lib/server-page-permissions", () => ({
  getPageVisibilityState: mocks.visibility,
}));
vi.mock("@/lib/ai/surface", () => ({
  getStaffAssistantSurfaceAccess: mocks.surfaceAccess,
  loadAssistantConversationForSurface: mocks.loadConversation,
}));
vi.mock("@/lib/ai/capabilities", () => ({
  resolveAssistantCapabilities: mocks.capabilities,
}));
vi.mock("@/lib/ai/permissions", () => ({
  hasAiUserPermission: mocks.permission,
}));
vi.mock("@/lib/ai/conversations", () => ({
  assertDoctorPatientContextAccess: mocks.patientAccess,
}));
vi.mock("@/lib/ai/persistence-readiness", () => ({
  isAssistantPersistenceReady: mocks.persistenceReady,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));

import {
  ASSISTANT_LAUNCHER_REGISTRY,
  resolveAssistantLauncher,
  resolveAssistantLauncherDefinition,
  resolveAssistantLauncherSession,
} from "@/lib/ai/launchers";

const USER = {
  id: "00000000-0000-4000-8000-000000000001",
  clinicId: "00000000-0000-4000-8000-000000000002",
  email: "doctor@example.com",
  role: "doctor" as const,
  fullName: "Doctor",
  avatarUrl: null,
  departmentId: "00000000-0000-4000-8000-000000000003",
  mustChangePassword: false,
};
const PATIENT_ID = "00000000-0000-4000-8000-000000000011";
const RANGE = { from: "2026-07-01", to: "2026-07-07" };
const CAPABILITIES = {
  toolNames: ["list_appointments"],
  items: [],
  financial: "not_applicable",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.visibility.mockResolvedValue("visible");
  mocks.surfaceAccess.mockResolvedValue({ state: "available", remaining: 19, limit: 20 });
  mocks.loadConversation.mockResolvedValue({
    conversation: null,
    persistenceAvailable: true,
  });
  mocks.capabilities.mockResolvedValue(CAPABILITIES);
  mocks.permission.mockResolvedValue(true);
  mocks.patientAccess.mockResolvedValue(undefined);
  mocks.persistenceReady.mockResolvedValue(true);
});

describe("P4.8 launcher registry and visibility resolver", () => {
  it("registers the complete P4.8A and P4.8B area vocabulary", () => {
    expect(ASSISTANT_LAUNCHER_REGISTRY.map((entry) => entry.area)).toEqual([
      "patient",
      "appointments",
      "dashboard",
      "revenue",
      "reports",
      "invoices",
      "staff",
      "departments",
      "doctor-schedule",
    ]);
    expect(ASSISTANT_LAUNCHER_REGISTRY.every((entry) => entry.defaultEnabled)).toBe(true);
    expect(ASSISTANT_LAUNCHER_REGISTRY.every((entry) =>
      entry.requiredFeatures.includes("ai_assistant"),
    )).toBe(true);
  });

  it.each(["revenue", "reports", "invoices", "staff", "departments", "doctor-schedule"])(
    "resolves the P4.8B %s area for an authorized admin",
    async (type) => {
      const contexts = {
        revenue: { type, dateRange: RANGE },
        reports: { type, report: "no_shows", range: RANGE },
        invoices: { type, filter: "outstanding" },
        staff: { type },
        departments: { type },
        "doctor-schedule": { type },
      } as const;
      await expect(resolveAssistantLauncher({
        user: { ...USER, role: "admin" },
        context: contexts[type as keyof typeof contexts] as never,
      })).resolves.toMatchObject({ context: { type } });
      expect(mocks.visibility).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["revenue", "receptionist"],
    ["revenue", "doctor"],
    ["reports", "doctor"],
    ["invoices", "manager"],
    ["invoices", "receptionist"],
    ["invoices", "doctor"],
    ["staff", "receptionist"],
    ["staff", "doctor"],
    ["departments", "receptionist"],
    ["departments", "doctor"],
    ["doctor-schedule", "receptionist"],
    ["doctor-schedule", "doctor"],
  ] as const)("denies the %s launcher to the unsupported %s role", async (type, role) => {
    const contexts = {
      revenue: { type: "revenue", dateRange: RANGE },
      reports: { type: "reports", report: "no_shows", range: RANGE },
      invoices: { type: "invoices", filter: "outstanding" },
      staff: { type: "staff" },
      departments: { type: "departments" },
      "doctor-schedule": { type: "doctor-schedule" },
    } as const;
    await expect(resolveAssistantLauncher({
      user: { ...USER, role },
      context: contexts[type],
    })).resolves.toBeNull();
    expect(mocks.visibility).not.toHaveBeenCalled();
  });

  it("requires the financial entitlement and personal grant for revenue and invoices", async () => {
    const manager = { ...USER, role: "manager" as const };
    mocks.permission.mockResolvedValue(false);
    await expect(resolveAssistantLauncher({
      user: manager,
      context: { type: "revenue", dateRange: RANGE },
    })).resolves.toBeNull();
    expect(mocks.surfaceAccess).toHaveBeenCalledWith(manager, [
      "ai_assistant",
      "ai.financial_insights",
    ]);
    expect(mocks.permission).toHaveBeenCalledWith(
      manager,
      "ai.financial_insights",
    );

    vi.clearAllMocks();
    mocks.visibility.mockResolvedValue("visible");
    mocks.surfaceAccess.mockResolvedValue({ state: "available", remaining: 19, limit: 20 });
    mocks.permission.mockResolvedValue(true);
    const admin = { ...USER, role: "admin" as const };
    await expect(resolveAssistantLauncher({
      user: admin,
      context: { type: "invoices", filter: "outstanding" },
    })).resolves.toMatchObject({ context: { type: "invoices" } });
  });

  it("requires staff analytics for reports, staff, departments, and schedules", async () => {
    await resolveAssistantLauncher({
      user: { ...USER, role: "manager" },
      context: { type: "staff" },
    });
    expect(mocks.surfaceAccess).toHaveBeenCalledWith(
      { ...USER, role: "manager" },
      ["ai_assistant", "ai.staff_analytics"],
    );
  });

  it("keeps patient launchers doctor-only without loading a closed launcher's session", async () => {
    await expect(resolveAssistantLauncher({
      user: { ...USER, role: "receptionist" },
      context: { type: "patient", patientId: PATIENT_ID },
    })).resolves.toBeNull();
    expect(mocks.surfaceAccess).not.toHaveBeenCalled();

    const resolution = await resolveAssistantLauncher({
      user: USER,
      context: { type: "patient", patientId: PATIENT_ID },
    });
    expect(resolution).toMatchObject({
      context: { type: "patient", patientId: PATIENT_ID },
      access: { state: "available" },
    });
    expect(mocks.loadConversation).not.toHaveBeenCalled();
    expect(mocks.capabilities).not.toHaveBeenCalled();
  });

  it("silently omits launchers when the cached persistence schema probe fails", async () => {
    mocks.persistenceReady.mockResolvedValue(false);
    await expect(resolveAssistantLauncher({
      user: USER,
      context: { type: "patient", patientId: PATIENT_ID },
    })).resolves.toBeNull();
    expect(mocks.loadConversation).not.toHaveBeenCalled();
    expect(mocks.capabilities).not.toHaveBeenCalled();
  });

  it("hydrates and re-authorizes patient history only at the opened-session boundary", async () => {
    const resolution = await resolveAssistantLauncherSession({
      user: USER,
      context: { type: "patient", patientId: PATIENT_ID },
    });
    expect(resolution).toMatchObject({
      context: { type: "patient", patientId: PATIENT_ID },
      capabilities: null,
    });
    expect(mocks.patientAccess).toHaveBeenCalledWith({
      supabase: {},
      user: USER,
      patientId: PATIENT_ID,
    });
    expect(mocks.loadConversation).toHaveBeenCalledWith({
      user: USER,
      patientId: PATIENT_ID,
    });
    expect(mocks.capabilities).not.toHaveBeenCalled();
  });

  it("never reads patient conversation history when opened-session authorization fails", async () => {
    mocks.patientAccess.mockRejectedValueOnce(new Error("invalid_patient_context"));
    await expect(resolveAssistantLauncherSession({
      user: USER,
      context: { type: "patient", patientId: PATIENT_ID },
    })).resolves.toBeNull();
    expect(mocks.loadConversation).not.toHaveBeenCalled();
    expect(mocks.capabilities).not.toHaveBeenCalled();
  });

  it.each(["admin", "receptionist", "doctor"] as const)(
    "allows the appointments launcher for the existing %s page role",
    async (role) => {
      await expect(resolveAssistantLauncher({
        user: { ...USER, role },
        context: { type: "appointments", dateRange: RANGE },
      })).resolves.toMatchObject({ context: { type: "appointments" } });
    },
  );

  it("does not invent appointments access for managers", async () => {
    await expect(resolveAssistantLauncher({
      user: { ...USER, role: "manager" },
      context: { type: "appointments", dateRange: RANGE },
    })).resolves.toBeNull();
    expect(mocks.visibility).not.toHaveBeenCalled();
  });

  it.each(["admin", "manager", "receptionist", "doctor"] as const)(
    "allows an entitled %s to launch from the always-visible dashboard",
    async (role) => {
      const resolution = await resolveAssistantLauncher({
        user: { ...USER, role },
        context: { type: "dashboard" },
      });
      expect(resolution).toMatchObject({ context: { type: "dashboard" } });
      expect(mocks.loadConversation).not.toHaveBeenCalled();
      expect(mocks.capabilities).not.toHaveBeenCalled();
    },
  );

  it("defers dashboard history and tool-derived capabilities until session hydration", async () => {
    await expect(resolveAssistantLauncherSession({
      user: USER,
      context: { type: "dashboard" },
      locale: "ar",
    })).resolves.toMatchObject({ capabilities: CAPABILITIES });
    expect(mocks.loadConversation).toHaveBeenCalledWith({
      user: USER,
      patientId: null,
    });
    expect(mocks.capabilities).toHaveBeenCalledWith(USER, "ar");
  });

  it.each(["hidden", "lookup_failed"] as const)(
    "fails closed when Assistant visibility is %s",
    async (visibility) => {
      mocks.visibility.mockImplementation(async (_user, slug: string) =>
        slug === "assistant" ? visibility : "visible",
      );
      await expect(resolveAssistantLauncher({
        user: USER,
        context: { type: "dashboard" },
      })).resolves.toBeNull();
      expect(mocks.surfaceAccess).not.toHaveBeenCalled();
    },
  );

  it.each(["hidden", "lookup_failed"] as const)(
    "fails closed when source-page visibility is %s",
    async (visibility) => {
      mocks.visibility.mockImplementation(async (_user, slug: string) =>
        slug === "dashboard" ? visibility : "visible",
      );
      await expect(resolveAssistantLauncher({
        user: USER,
        context: { type: "dashboard" },
      })).resolves.toBeNull();
      expect(mocks.surfaceAccess).not.toHaveBeenCalled();
    },
  );

  it("enforces a definition's optional user permission and complete feature list", async () => {
    mocks.permission.mockResolvedValue(false);
    await expect(resolveAssistantLauncherDefinition({
      user: USER,
      context: { type: "dashboard" },
      definition: {
        area: "dashboard",
        contextType: "dashboard",
        pageSlug: "dashboard",
        roles: ["doctor"],
        requiredFeatures: ["ai_assistant", "ai.staff_analytics"],
        requiredUserPermission: "ai.financial_insights",
        defaultEnabled: true,
      },
    })).resolves.toBeNull();
    expect(mocks.surfaceAccess).toHaveBeenCalledWith(USER, [
      "ai_assistant",
      "ai.staff_analytics",
    ]);
    expect(mocks.permission).toHaveBeenCalledWith(
      USER,
      "ai.financial_insights",
    );
  });

  it.each(["upgrade", "cap_reached", "subscription_inactive", "temporarily_unavailable"] as const)(
    "hides rather than weakens an Assistant gate in the %s state",
    async (state) => {
      mocks.surfaceAccess.mockResolvedValue(
        state === "cap_reached" ? { state, limit: 20 } : { state },
      );
      await expect(resolveAssistantLauncher({
        user: USER,
        context: { type: "dashboard" },
      })).resolves.toBeNull();
      expect(mocks.loadConversation).not.toHaveBeenCalled();
    },
  );

  it("fails soft without logging patient identifiers when session hydration throws", async () => {
    mocks.loadConversation.mockRejectedValueOnce(new Error("conversation store unavailable"));
    await expect(resolveAssistantLauncherSession({
      user: USER,
      context: { type: "patient", patientId: PATIENT_ID },
    })).resolves.toBeNull();
    expect(mocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "conversation store unavailable" }),
      {
        tags: { area: "assistant-launcher-session", launcherArea: "patient" },
        extra: { clinicId: USER.clinicId, role: USER.role },
      },
    );
    expect(JSON.stringify(mocks.captureException.mock.calls)).not.toContain(PATIENT_ID);
  });
});
