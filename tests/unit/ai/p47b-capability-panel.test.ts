import { describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

// P4.7B — the capability panel and its model-facing twin, `list_my_capabilities`.
//
// The headline property is asserted first and hard: the panel and tool expose
// the authorized union across task classes supported for the role, while every
// active-turn mount is a subset and all active mounts union back to that exact
// set. Everything comes from one registry resolver, so no unauthorized or stale
// hand-maintained capability can appear. The rest covers role, entitlement,
// per-user grant, localization, and audit behavior.

type Role = "admin" | "manager" | "receptionist" | "doctor";
type MockUser = { id: string; clinicId: string; role: Role; fullName?: string };

const CLINIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function user(role: Role): MockUser {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    clinicId: CLINIC,
    role,
    fullName: "Test User",
  };
}

const PRO_AI_FEATURES = {
  ai_assistant: true,
  "ai.staff_assistant": true,
  "ai.staff_analytics": true,
  "ai.financial_insights": true,
  whatsapp: true,
};

type LoadOptions = {
  features?: Record<string, boolean>;
  visibility?: Partial<Record<string, "visible" | "hidden" | "lookup_failed">>;
  /** Grant/deny the per-user financial-insights permission (default: denied). */
  financialPermission?: boolean;
  locale?: "en" | "ar";
};

async function load(actor: MockUser, options: LoadOptions = {}) {
  vi.resetModules();
  const mocks = createServerActionMocks();
  const logAgentToolCall = vi.fn<
    (input: Record<string, unknown>) => Promise<{ data: string; error: null }>
  >(async () => ({ data: "audit-1", error: null }));

  vi.doMock("server-only", () => ({}));
  vi.doMock("@sentry/nextjs", () => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));
  vi.doMock("@/lib/supabase/admin", () => ({ logAgentToolCall }));
  vi.doMock("@/lib/entitlements", () => ({
    getEntitlements: vi.fn(async () => ({
      clinicId: actor.clinicId,
      planSlug: "pro_ai",
      features: options.features ?? PRO_AI_FEATURES,
      limits: {},
      subscriptionAllowed: true,
    })),
    hasFeature: (
      ents: { subscriptionAllowed: boolean; features: Record<string, boolean> },
      key: string,
    ) => ents.subscriptionAllowed && ents.features[key] === true,
  }));
  vi.doMock("@/lib/server-page-permissions", () => ({
    getPageVisibilityState: vi.fn(
      async (_u: unknown, slug: string) => options.visibility?.[slug] ?? "visible",
    ),
  }));
  vi.doMock("@/lib/ai/permissions", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/ai/permissions")>();
    return {
      ...actual,
      hasAiUserPermission: vi.fn(async () => options.financialPermission === true),
    };
  });

  const { buildStaffTools, resolveToolMount } = await import("@/lib/ai/tools");
  const { staffTaskClassesForRole } = await import("@/lib/ai/tools");
  const { resolveAssistantCapabilities } = await import("@/lib/ai/capabilities");
  const context = { user: actor as never, locale: options.locale ?? ("en" as const) };
  return {
    tools: await buildStaffTools(context),
    mount: await resolveToolMount(context),
    capabilities: await resolveAssistantCapabilities(actor as never, options.locale ?? "en"),
    logAgentToolCall,
    resolveToolMount,
    staffTaskClassesForRole,
    context,
  };
}

const opts = {} as never;

type CapabilityPayload = {
  capabilities: { name: string; group: string; description: string }[];
  capability_only: boolean;
  capability_scope: "authorized_task_class_union";
};

async function runTool(actor: MockUser, options: LoadOptions = {}) {
  const { tools, ...rest } = await load(actor, options);
  const payload = (await tools.list_my_capabilities!.execute!({}, opts)) as CapabilityPayload;
  return { payload, tools, ...rest };
}

describe("P4.7B list_my_capabilities is mounted deny-by-default under ai_assistant", () => {
  it("mounts for every staff role", async () => {
    for (const role of ["admin", "manager", "receptionist", "doctor"] as const) {
      const { tools } = await load(user(role));
      expect(Object.keys(tools)).toContain("list_my_capabilities");
    }
  });

  it("is absent when the assistant feature is absent (pro/basic clinic)", async () => {
    const { tools } = await load(user("admin"), { features: { ai_assistant: false } });
    expect(Object.keys(tools)).not.toContain("list_my_capabilities");
  });

  it("is present on a help turn (rides in every task class, like the help tools)", async () => {
    const { mount } = await load(user("admin"));
    // The registry declares it in HELP_TASKS, so it is answerable in any class.
    expect(mount.definitions.some((d) => d.name === "list_my_capabilities")).toBe(true);
  });
});

describe("P4.7B panel/tool authorized-union contract", () => {
  it("the tool's capability names equal the user's authorized cross-task union", async () => {
    const { payload, mount } = await runTool(user("admin"));
    expect(payload.capabilities.map((c) => c.name).sort()).toEqual(
      mount.definitions.map((d) => d.name).sort(),
    );
  });

  it("every supported task-class mount is an authorized subset and their set union is exact", async () => {
    for (const role of ["admin", "manager", "receptionist", "doctor"] as const) {
      const loaded = await load(user(role), { financialPermission: true });
      const authorizedUnion = new Set(loaded.mount.definitions.map((definition) => definition.name));
      const unionOfActiveMounts = new Set<string>();

      for (const taskClass of loaded.staffTaskClassesForRole(role)) {
        const active = await loaded.resolveToolMount({
          ...loaded.context,
          taskClass,
        });
        for (const definition of active.definitions) {
          expect(
            authorizedUnion.has(definition.name),
            `${role}/${taskClass} mounted unauthorized ${definition.name}`,
          ).toBe(true);
          unionOfActiveMounts.add(definition.name);
        }
      }

      expect([...authorizedUnion].sort()).toEqual([...unionOfActiveMounts].sort());
    }
  });

  it("an unsupported role/task-class pairing produces no mount", async () => {
    const loaded = await load(user("doctor"));
    const active = await loaded.resolveToolMount({
      ...loaded.context,
      taskClass: "staff_operational_query",
    });
    expect(active.definitions).toEqual([]);
  });

  it("the panel items equal the tool payload for the same user", async () => {
    const { payload, capabilities } = await runTool(user("manager"), {
      financialPermission: true,
    });
    expect(capabilities.items.map((i) => i.name).sort()).toEqual(
      payload.capabilities.map((c) => c.name).sort(),
    );
  });

  it("marks the payload corpus/capability-only so the model does not append invented abilities", async () => {
    const { payload } = await runTool(user("receptionist"));
    expect(payload.capability_only).toBe(true);
    expect(payload.capability_scope).toBe("authorized_task_class_union");
  });
});

describe("P4.7B capability presentation is permission-aware", () => {
  it("gives an entitled, granted admin the financial capabilities", async () => {
    const { payload } = await runTool(user("admin"), { financialPermission: true });
    const names = payload.capabilities.map((c) => c.name);
    expect(names).toContain("get_revenue_summary");
    expect(payload.capabilities.find((c) => c.name === "get_revenue_summary")?.group).toBe(
      "financial",
    );
  });

  it("withholds financial capabilities from a manager without the per-user grant", async () => {
    const { payload } = await runTool(user("manager"), { financialPermission: false });
    const names = payload.capabilities.map((c) => c.name);
    expect(names).not.toContain("get_revenue_summary");
    expect(names).not.toContain("list_outstanding_invoices");
    // But operational capabilities remain.
    expect(names).toContain("list_appointments");
  });

  it("never offers financial or clinic-analytics capabilities to a receptionist", async () => {
    const { payload } = await runTool(user("receptionist"), { financialPermission: true });
    const names = payload.capabilities.map((c) => c.name);
    expect(names).not.toContain("get_revenue_summary");
    expect(names).not.toContain("get_patient_stats");
    expect(names).toContain("list_appointments");
    expect(names).toContain("search_help");
  });

  it("gives a doctor only clinical and guidance capabilities", async () => {
    const { payload } = await runTool(user("doctor"));
    const groups = new Set(payload.capabilities.map((c) => c.group));
    expect(groups).not.toContain("operational");
    expect(groups).not.toContain("financial");
    expect(payload.capabilities.map((c) => c.name)).toContain("get_patient_summary");
    expect(payload.capabilities.map((c) => c.name)).toContain("list_my_capabilities");
  });

  it("drops the analytics/financial surface when the clinic lacks ai.staff_analytics", async () => {
    const { payload } = await runTool(user("admin"), {
      features: { ai_assistant: true, "ai.staff_assistant": true },
    });
    const names = payload.capabilities.map((c) => c.name);
    expect(names).not.toContain("get_clinic_summary");
    expect(names).not.toContain("get_revenue_summary");
    // The base assistant survives: help + capability transparency + patient lookup.
    expect(names).toContain("search_authorized_patients");
    expect(names).toContain("list_my_capabilities");
  });
});

describe("P4.7B localization, ordering, and audit", () => {
  it("returns Arabic descriptions when the session locale is Arabic", async () => {
    const { payload } = await runTool(user("receptionist"), { locale: "ar" });
    const help = payload.capabilities.find((c) => c.name === "search_help");
    expect(help?.description).toMatch(/[؀-ۿ]/);
  });

  it("orders capabilities by group: clinical, operational, financial, then guidance", async () => {
    const { capabilities } = await load(user("admin"), { financialPermission: true });
    const order = ["clinical", "operational", "financial", "guidance"];
    const seen = capabilities.items.map((i) => order.indexOf(i.group));
    const sorted = [...seen].sort((a, b) => a - b);
    expect(seen).toEqual(sorted);
  });

  it("audits the call with a capability count and no clinic table", async () => {
    const { logAgentToolCall, payload } = await runTool(user("admin"), {
      financialPermission: true,
    });
    const audited = logAgentToolCall.mock.calls.find(
      (call) => (call[0] as { tool?: string }).tool === "list_my_capabilities",
    );
    expect(audited).toBeDefined();
    expect((audited?.[0] as { tableName?: string | null }).tableName).toBeNull();
    expect(
      (audited?.[0] as { summary?: { capability_count?: number } }).summary?.capability_count,
    ).toBe(payload.capabilities.length);
  });

  it("denies the call when the assistant page is hidden mid-session", async () => {
    const { tools } = await load(user("admin"), { visibility: { assistant: "hidden" } });
    const result = (await tools.list_my_capabilities!.execute!({}, opts)) as {
      permission_denied?: boolean;
      reason?: string;
    };
    // harden() converts the thrown AiToolAuthorizationError into a structured
    // denial rather than letting it escape the model loop.
    expect(result.permission_denied).toBe(true);
    expect(result.reason).toBe("page_hidden");
  });
});
