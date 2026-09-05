import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  visibility: vi.fn(),
  surfaceAccess: vi.fn(),
  pageContextSeed: vi.fn(),
  capabilities: vi.fn(),
  permission: vi.fn(),
  patientAccess: vi.fn(),
  persistenceReady: vi.fn(),
  placement: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@/lib/server-page-permissions", () => ({
  getPageVisibilityState: mocks.visibility,
}));
vi.mock("@/lib/ai/surface", () => ({
  getStaffAssistantSurfaceAccess: mocks.surfaceAccess,
}));
vi.mock("@/lib/ai/page-context-seed", () => ({
  resolvePageContextSeed: mocks.pageContextSeed,
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
vi.mock("@/lib/ai/launcher-placement", () => ({
  resolveAssistantLauncherPlacement: mocks.placement,
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
  toolNames: ["query_resource"],
  items: [],
  financial: "not_applicable",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.visibility.mockResolvedValue("visible");
  mocks.surfaceAccess.mockResolvedValue({ state: "available", remaining: 19, limit: 20 });
  mocks.pageContextSeed.mockResolvedValue([]);
  mocks.capabilities.mockResolvedValue(CAPABILITIES);
  mocks.permission.mockResolvedValue(true);
  mocks.patientAccess.mockResolvedValue(undefined);
  mocks.persistenceReady.mockResolvedValue(true);
  mocks.placement.mockResolvedValue(true);
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
    // Every supported role has a per-role default, and the originally-shipped
    // combinations still default ON (new combinations default OFF).
    expect(
      ASSISTANT_LAUNCHER_REGISTRY.every((entry) =>
        entry.roles.every((role) => role in entry.defaultEnabledByRole),
      ),
    ).toBe(true);
    const patient = ASSISTANT_LAUNCHER_REGISTRY.find((e) => e.area === "patient")!;
    expect(patient.defaultEnabledByRole.doctor).toBe(true);
    expect(patient.defaultEnabledByRole.assistant).toBe(false);
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

  it("omits a placement-disabled launcher without weakening the host or Assistant gates", async () => {
    mocks.placement.mockResolvedValue(false);

    await expect(resolveAssistantLauncher({
      user: USER,
      context: { type: "dashboard" },
    })).resolves.toBeNull();

    expect(mocks.placement).toHaveBeenCalledWith({
      user: USER,
      area: "dashboard",
      defaultEnabled: true,
    });
    expect(mocks.surfaceAccess).not.toHaveBeenCalled();
    expect(mocks.pageContextSeed).not.toHaveBeenCalled();
    expect(mocks.capabilities).not.toHaveBeenCalled();
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
    expect(mocks.pageContextSeed).not.toHaveBeenCalled();
    expect(mocks.capabilities).not.toHaveBeenCalled();
  });

  it("silently omits launchers when the cached persistence schema probe fails", async () => {
    mocks.persistenceReady.mockResolvedValue(false);
    await expect(resolveAssistantLauncher({
      user: USER,
      context: { type: "patient", patientId: PATIENT_ID },
    })).resolves.toBeNull();
    expect(mocks.pageContextSeed).not.toHaveBeenCalled();
    expect(mocks.capabilities).not.toHaveBeenCalled();
  });

  // Post-plan completion, change 3: a launcher no longer resumes the caller's
  // latest conversation. It seeds a *new* one with the server-derived context of
  // the record on screen, and past conversations are reached through the shared
  // history actions instead. The patient re-authorization at this boundary is
  // unchanged and still gates everything after it.
  it("re-authorizes the patient and seeds a new session rather than resuming history", async () => {
    mocks.pageContextSeed.mockResolvedValueOnce([{
      entityType: "patient",
      entityId: PATIENT_ID,
      displayLabel: "Seeded Patient",
      setBy: "page_context",
    }]);
    const resolution = await resolveAssistantLauncherSession({
      user: USER,
      context: { type: "patient", patientId: PATIENT_ID },
    });
    expect(resolution).toMatchObject({
      context: { type: "patient", patientId: PATIENT_ID },
      capabilities: null,
      seededActiveContext: {
        patient: expect.objectContaining({
          entity_type: "patient",
          entity_id: PATIENT_ID,
          display_label: "Seeded Patient",
          set_by: "page_context",
        }),
      },
    });
    expect(mocks.patientAccess).toHaveBeenCalledWith({
      supabase: {},
      user: USER,
      patientId: PATIENT_ID,
    });
    expect(mocks.capabilities).not.toHaveBeenCalled();
  });

  it("never derives patient context when opened-session authorization fails", async () => {
    mocks.patientAccess.mockRejectedValueOnce(new Error("invalid_patient_context"));
    await expect(resolveAssistantLauncherSession({
      user: USER,
      context: { type: "patient", patientId: PATIENT_ID },
    })).resolves.toBeNull();
    expect(mocks.pageContextSeed).not.toHaveBeenCalled();
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

  it("supports the appointments launcher for managers when placement is enabled", async () => {
    // Manager gained the Appointments page in this work, so the combination is
    // now supported (product default OFF; here placement is mocked ON). This is
    // placement visibility, not authorization — the tools still re-check role.
    await expect(resolveAssistantLauncher({
      user: { ...USER, role: "manager" },
      context: { type: "appointments", dateRange: RANGE },
    })).resolves.toMatchObject({ context: { type: "appointments" } });
  });

  it.each(["admin", "manager", "receptionist", "doctor"] as const)(
    "allows an entitled %s to launch from the always-visible dashboard",
    async (role) => {
      const resolution = await resolveAssistantLauncher({
        user: { ...USER, role },
        context: { type: "dashboard" },
      });
      expect(resolution).toMatchObject({ context: { type: "dashboard" } });
      expect(mocks.pageContextSeed).not.toHaveBeenCalled();
      expect(mocks.capabilities).not.toHaveBeenCalled();
    },
  );

  it("defers tool-derived capabilities until session hydration and seeds no slot for a view context", async () => {
    await expect(resolveAssistantLauncherSession({
      user: USER,
      context: { type: "dashboard" },
      locale: "ar",
    })).resolves.toMatchObject({
      capabilities: CAPABILITIES,
      seededActiveContext: {},
    });
    expect(mocks.pageContextSeed).toHaveBeenCalledWith(expect.objectContaining({
      user: USER,
      context: { type: "dashboard" },
      locale: "ar",
    }));
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
        defaultEnabledByRole: { doctor: true },
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
      expect(mocks.pageContextSeed).not.toHaveBeenCalled();
    },
  );

  it("fails soft without logging patient identifiers when session hydration throws", async () => {
    mocks.pageContextSeed.mockRejectedValueOnce(new Error("conversation store unavailable"));
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
