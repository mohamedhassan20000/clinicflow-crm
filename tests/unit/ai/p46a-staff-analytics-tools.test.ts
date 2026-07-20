import { describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

// P4.6A tool-authorization suite — the security-critical deliverable of the
// sub-phase, reviewed without UI dilution. Every cell of the §P4.6 role matrix
// is asserted here, plus the containment properties the tools promise: hard row
// caps, fixed field allow-lists, small-cell suppression passthrough, the
// clarification contract for ambiguous entity filters, and an audit row per
// invocation. The model is never exercised; execute() is driven directly.

type Role = "admin" | "manager" | "receptionist" | "doctor";

type MockUser = {
  id: string;
  clinicId: string;
  role: Role;
  departmentId?: string | null;
  fullName?: string;
};

const CLINIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_CLINIC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function user(role: Role, clinicId = CLINIC): MockUser {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    clinicId,
    role,
    departmentId: null,
    fullName: "Test User",
  };
}

/** The full pro_ai AI vocabulary. Individual tests turn keys off. */
const PRO_AI_FEATURES = {
  ai_assistant: true,
  "ai.staff_assistant": true,
  "ai.staff_analytics": true,
  "ai.financial_insights": true,
};

type LoadOptions = {
  features?: Record<string, boolean>;
  subscriptionAllowed?: boolean;
  /** Row returned from user_ai_permissions for the caller. */
  financialPermission?: boolean | null;
  pageVisibility?: "visible" | "hidden" | "lookup_failed";
};

async function load(actor: MockUser, options: LoadOptions = {}) {
  vi.resetModules();
  const mocks = createServerActionMocks();
  const logAgentToolCall = vi.fn(async () => ({ data: "audit-1", error: null }));

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
      subscriptionAllowed: options.subscriptionAllowed ?? true,
    })),
    hasFeature: (
      ents: { subscriptionAllowed: boolean; features: Record<string, boolean> },
      key: string,
    ) => ents.subscriptionAllowed && ents.features[key] === true,
  }));
  vi.doMock("@/lib/server-page-permissions", () => ({
    getPageVisibilityState: vi.fn(async () => options.pageVisibility ?? "visible"),
  }));

  if (options.financialPermission !== undefined) {
    mocks.state.tableResults["user_ai_permissions"] =
      options.financialPermission === null
        ? { data: null, error: null }
        : { data: { granted: options.financialPermission }, error: null };
  }

  const { buildStaffTools, resolveToolMount } = await import("@/lib/ai/tools");
  const context = { user: actor as never, locale: "en" } as const;
  const tools = await buildStaffTools(context);
  const mount = await resolveToolMount(context);
  return { tools, mount, mocks, logAgentToolCall };
}

const opts = {} as never;

const OPERATIONAL_TOOLS = [
  "get_clinic_summary",
  "get_patient_stats",
  "get_appointment_stats",
  "list_appointments",
  "count_new_patients",
  "list_pending_followups",
  "run_clinic_report",
];
const FINANCIAL_TOOLS = [
  "get_revenue_summary",
  "compare_revenue_periods",
  "list_outstanding_invoices",
];

describe("P4.6A registration matrix", () => {
  it("mounts operational and financial tools for an entitled admin", async () => {
    const { tools } = await load(user("admin"));
    for (const name of [...OPERATIONAL_TOOLS, ...FINANCIAL_TOOLS]) {
      expect(Object.keys(tools)).toContain(name);
    }
  });

  it("denies financial tools to a manager without the per-user permission", async () => {
    const { tools } = await load(user("manager"), { financialPermission: null });
    for (const name of FINANCIAL_TOOLS) {
      expect(Object.keys(tools)).not.toContain(name);
    }
    // Operational access is unaffected by the financial grant.
    expect(Object.keys(tools)).toContain("get_clinic_summary");
    expect(Object.keys(tools)).toContain("list_appointments");
  });

  it("mounts financial tools for a manager once an admin grants the permission", async () => {
    const { tools } = await load(user("manager"), { financialPermission: true });
    for (const name of FINANCIAL_TOOLS) {
      expect(Object.keys(tools)).toContain(name);
    }
  });

  it("treats an explicitly revoked grant as a denial", async () => {
    const { tools } = await load(user("manager"), { financialPermission: false });
    for (const name of FINANCIAL_TOOLS) {
      expect(Object.keys(tools)).not.toContain(name);
    }
  });

  it("denies financial tools when the entitlement is off, whatever the permission says", async () => {
    const { tools } = await load(user("manager"), {
      features: { ...PRO_AI_FEATURES, "ai.financial_insights": false },
      financialPermission: true,
    });
    for (const name of FINANCIAL_TOOLS) {
      expect(Object.keys(tools)).not.toContain(name);
    }
  });

  it("never mounts financial tools for a receptionist, even with a stray grant row", async () => {
    const { tools } = await load(user("receptionist"), { financialPermission: true });
    for (const name of FINANCIAL_TOOLS) {
      expect(Object.keys(tools)).not.toContain(name);
    }
    // Receptionists keep the operational list/stat tools they are entitled to.
    expect(Object.keys(tools)).toContain("list_appointments");
    expect(Object.keys(tools)).toContain("count_new_patients");
    expect(Object.keys(tools)).toContain("list_pending_followups");
  });

  it("excludes receptionists from clinic-wide aggregate tools", async () => {
    const { tools } = await load(user("receptionist"));
    for (const name of ["get_clinic_summary", "get_patient_stats", "get_appointment_stats"]) {
      expect(Object.keys(tools)).not.toContain(name);
    }
  });

  it("excludes managers from follow-ups, matching the underlying RPC denial", async () => {
    const { tools } = await load(user("manager"));
    expect(Object.keys(tools)).not.toContain("list_pending_followups");
  });

  it("gives doctors no P4.6 tools at all — only their P4 clinical set", async () => {
    const { tools } = await load(user("doctor"), { financialPermission: true });
    for (const name of [...OPERATIONAL_TOOLS, ...FINANCIAL_TOOLS]) {
      expect(Object.keys(tools)).not.toContain(name);
    }
    expect(Object.keys(tools)).toEqual([
      "search_authorized_patients",
      "get_patient_summary",
      "search_patient_visits",
      "list_doctor_appointments",
      "check_availability",
    ]);
  });

  it("denies every P4.6 tool on a pro/basic clinic with no AI entitlements", async () => {
    for (const role of ["admin", "manager", "receptionist"] as const) {
      const { tools } = await load(user(role), {
        features: { ai_assistant: false },
        financialPermission: true,
      });
      expect(Object.keys(tools)).toEqual([]);
    }
  });

  it("denies analytics tools when only the legacy umbrella entitlement is present", async () => {
    const { tools } = await load(user("admin"), {
      features: { ai_assistant: true },
      financialPermission: true,
    });
    expect(Object.keys(tools)).toEqual([
      "search_authorized_patients",
      "check_availability",
    ]);
  });

  it("denies everything when the subscription is inactive", async () => {
    const { tools } = await load(user("admin"), { subscriptionAllowed: false });
    expect(Object.keys(tools)).toEqual([]);
  });
});

/**
 * These assert *re-authorization inside execute()*, which is the property that
 * matters: mounting happened earlier and cannot be trusted to still hold.
 *
 * They previously asserted it by expecting a rejection. Since review #2's H2
 * the mount wrapper converts an `AiToolAuthorizationError` into a structured
 * `permission_denied` result rather than letting it throw into the model loop,
 * where the reason code was discarded by the transport. The gate that runs, and
 * the reason it produces, are unchanged — only the shape it comes back in is —
 * so each assertion moved from `.rejects` to the returned reason rather than
 * being relaxed. Each still also asserts that no read happened.
 */
describe("P4.6A per-invocation re-authorization", () => {
  it("re-checks the financial gate inside execute, so a revoked grant denies the next call", async () => {
    // Mounted while the grant was live...
    const { tools, mocks } = await load(user("manager"), { financialPermission: true });
    expect(tools.get_revenue_summary).toBeDefined();

    // ...then the admin revokes it mid-conversation.
    mocks.state.tableResults["user_ai_permissions"] = {
      data: { granted: false },
      error: null,
    };
    await expect(
      tools.get_revenue_summary!.execute!({ preset: "this_month" }, opts),
    ).resolves.toMatchObject({
      permission_denied: true,
      reason: "permission_not_granted",
      guidance: expect.stringContaining("administrator"),
    });
    expect(mocks.state.rpc).not.toHaveBeenCalled();
  });

  /**
   * Mounting deliberately does not re-read page visibility — the route's
   * authorizeStaffAssistant already refuses the whole request when the
   * Assistant page is hidden. The property that matters is that each tool
   * re-asserts it inside execute(), so a mid-conversation revocation denies the
   * next call rather than relying on the mount decision made earlier.
   */
  it("denies an operational tool inside execute when Assistant visibility is revoked", async () => {
    const { tools, mocks } = await load(user("admin"), { pageVisibility: "hidden" });

    await expect(
      tools.get_clinic_summary!.execute!({ preset: "this_month" }, opts),
    ).resolves.toMatchObject({ permission_denied: true, reason: "page_hidden" });
    expect(mocks.state.rpc).not.toHaveBeenCalled();
  });

  it("fails closed rather than open when the visibility lookup itself fails", async () => {
    const { tools, mocks } = await load(user("admin"), { pageVisibility: "lookup_failed" });

    // Fails closed *and* audibly: the user is told the check could not be
    // completed, instead of getting an anonymous "could not complete" chip.
    await expect(
      tools.list_appointments!.execute!({ preset: "today" }, opts),
    ).resolves.toMatchObject({ permission_denied: true, reason: "lookup_failed" });
    expect(mocks.state.from).not.toHaveBeenCalledWith("appointments");
  });
});

describe("P4.6A aggregate tools", () => {
  it("calls the clinic-scoped RPC and audits the invocation", async () => {
    const { tools, mocks, logAgentToolCall } = await load(user("admin"));
    mocks.state.rpcResults.ai_get_clinic_summary = {
      data: { departments_active: 4, patients_total: 120 },
      error: null,
    };

    const result = (await tools.get_clinic_summary!.execute!(
      { preset: "this_month" },
      opts,
    )) as { summary: unknown; range: { preset: string } };

    expect(mocks.state.rpc).toHaveBeenCalledWith(
      "ai_get_clinic_summary",
      expect.objectContaining({ p_start: expect.any(String), p_end: expect.any(String) }),
    );
    expect(result.summary).toEqual({ departments_active: 4, patients_total: 120 });
    expect(logAgentToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "get_clinic_summary", clinicId: CLINIC }),
    );
  });

  it("never passes a clinic id to the aggregate RPCs — tenancy is re-resolved server-side", async () => {
    const { tools, mocks } = await load(user("admin", OTHER_CLINIC));
    mocks.state.rpcResults.ai_get_patient_stats = { data: {}, error: null };

    await tools.get_patient_stats!.execute!(
      { preset: "this_month", group_by: "blood_type" },
      opts,
    );

    const args = mocks.state.rpc.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(args)).toEqual(["p_start", "p_end", "p_group_by"]);
    expect(JSON.stringify(args)).not.toContain(OTHER_CLINIC);
    expect(JSON.stringify(args)).not.toContain(CLINIC);
  });

  it("returns suppressed buckets verbatim without inventing a count", async () => {
    const { tools, mocks } = await load(user("admin"));
    // Mirrors the real RPC payload: complementary suppression means at least
    // two hidden cells, and the co-published total is rounded rather than exact
    // so the hidden residual cannot be recovered by subtraction. The
    // reversibility itself is proved against live Postgres in
    // tests/unit/integration/p46a-analytics-rpc-isolation.test.ts.
    mocks.state.rpcResults.ai_get_patient_stats = {
      data: {
        suppression_floor: 5,
        suppressed_bucket_count: 2,
        patients_total: null,
        patients_total_approx: 50,
        patients_total_exact: false,
        bucket_scope: "all_time",
        buckets_all_time: [
          { bucket: "O+", count: 42, display: "42", suppressed: false },
          { bucket: "AB-", count: null, display: "<5", suppressed: true },
          { bucket: "B-", count: null, display: "<5", suppressed: true },
        ],
      },
      error: null,
    };

    const result = (await tools.get_patient_stats!.execute!(
      { preset: "this_month", group_by: "blood_type" },
      opts,
    )) as {
      stats: {
        patients_total: number | null;
        buckets_all_time: { display: string; count: number | null }[];
      };
    };

    const suppressed = result.stats.buckets_all_time[1]!;
    expect(suppressed.display).toBe("<5");
    expect(suppressed.count).toBeNull();
    // The tool passes the RPC's decision through untouched — it never
    // reconstitutes an exact total the database deliberately withheld.
    expect(result.stats.patients_total).toBeNull();
  });

  it("clamps an absurd custom range back to a safe default", async () => {
    const { tools, mocks } = await load(user("admin"));
    mocks.state.rpcResults.ai_get_appointment_stats = { data: {}, error: null };

    const result = (await tools.get_appointment_stats!.execute!(
      {
        preset: "custom",
        date_from: "2000-01-01",
        date_to: "2030-01-01",
        group_by: "status",
      },
      opts,
    )) as { range: { preset: string } };

    expect(result.range.preset).toBe("this_month");
  });
});

describe("P4.6A operational list tools", () => {
  it("caps rows and returns only allow-listed appointment fields", async () => {
    const { tools, mocks } = await load(user("receptionist"));
    mocks.state.tableResults["appointments"] = {
      data: [
        {
          id: "appt-1",
          scheduled_at: "2026-07-20T09:00:00.000Z",
          status: "confirmed",
          duration_minutes: 30,
          notes: "SECRET CLINICAL NOTE",
          outstanding_amount: 250,
          patients: { full_name: "Jane Roe", file_number: "CF-1" },
          profiles: { full_name: "Dr House" },
          departments: { name: "Cardiology" },
        },
      ],
      error: null,
    };

    const result = (await tools.list_appointments!.execute!(
      { preset: "today" },
      opts,
    )) as { row_cap: number; appointments: Record<string, unknown>[] };

    expect(result.row_cap).toBe(50);
    expect(Object.keys(result.appointments[0]!)).toEqual([
      "id",
      "scheduled_at",
      "status",
      "duration_minutes",
      "patient_name",
      "patient_file_number",
      "doctor_name",
      "department_name",
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SECRET CLINICAL NOTE");
    expect(serialized).not.toContain("250");

    // Cap + 1: the extra row is how "there is more" is told apart from "there
    // is exactly this much" (phase review L5). The returned list is still 50.
    const limitCall = mocks.state.queryLog.find((entry) => entry.args[0] === "limit");
    expect(limitCall?.args[1]).toBe(51);
  });

  it("asks the user to choose instead of guessing an ambiguous doctor name", async () => {
    const { tools, mocks } = await load(user("admin"));
    mocks.state.rpcResults.search_staff_ranked = {
      data: [
        { id: "d1", full_name: "Ahmed Ali", score: 0.82, match_kind: "name_fuzzy" },
        { id: "d2", full_name: "Ahmed Aly", score: 0.8, match_kind: "name_fuzzy" },
      ],
      error: null,
    };

    const result = (await tools.list_appointments!.execute!(
      { preset: "today", doctor: "Ahmed" },
      opts,
    )) as { needs_clarification: boolean; candidates: { id: string }[] };

    expect(result.needs_clarification).toBe(true);
    expect(result.candidates).toHaveLength(2);
    // No appointment read happened — the tool stopped before querying.
    expect(mocks.state.queryLog.some((entry) => entry.table === "appointments")).toBe(false);
  });

  it("proceeds on a confident unique doctor match", async () => {
    const { tools, mocks } = await load(user("admin"));
    mocks.state.rpcResults.search_staff_ranked = {
      data: [{ id: "d1", full_name: "Ahmed Ali", score: 0.95, match_kind: "exact_name" }],
      error: null,
    };
    mocks.state.tableResults["appointments"] = { data: [], error: null };

    const result = (await tools.list_appointments!.execute!(
      { preset: "today", doctor: "Ahmed Ali" },
      opts,
    )) as { appointments: unknown[] };

    expect(result.appointments).toEqual([]);
    expect(
      mocks.state.queryLog.some(
        (entry) => entry.args[0] === "eq" && entry.args[1] === "doctor_id",
      ),
    ).toBe(true);
  });

  it("counts new patients without reading any patient row", async () => {
    const { tools, mocks, logAgentToolCall } = await load(user("receptionist"));
    mocks.state.tableResults["patients"] = [
      { data: null, error: null, count: 12 },
      { data: null, error: null, count: 8 },
    ];

    const result = (await tools.count_new_patients!.execute!(
      { preset: "this_month" },
      opts,
    )) as { new_patients: number; previous_period_new_patients: number; change: number };

    expect(result).toMatchObject({
      new_patients: 12,
      previous_period_new_patients: 8,
      change: 4,
    });
    expect(logAgentToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "count_new_patients" }),
    );
  });

  it("strips national ids and amounts from the follow-up worklist", async () => {
    const { tools, mocks } = await load(user("receptionist"));
    mocks.state.rpcResults.get_followups_dashboard = {
      data: {
        summary: { completedCount: 3 },
        pending: [
          {
            id: "appt-1",
            scheduled_at: "2026-07-20T09:00:00.000Z",
            total_amount: 900,
            payment_note: "PRIVATE NOTE",
            patients: {
              full_name: "Jane Roe",
              phone: "+96550000001",
              file_number: "CF-1",
              national_id: "NATIONAL-ID-123",
            },
            profiles: { full_name: "Dr House" },
            departments: { name: "Cardiology" },
          },
        ],
        done: [],
      },
      error: null,
    };

    const result = (await tools.list_pending_followups!.execute!(
      { preset: "this_month" },
      opts,
    )) as { pending: Record<string, unknown>[]; mode: string };

    expect(result.mode).toBe("pending");
    expect(Object.keys(result.pending[0]!)).toEqual([
      "appointment_id",
      "scheduled_at",
      "patient_name",
      "patient_phone",
      "patient_file_number",
      "doctor_name",
      "department_name",
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("NATIONAL-ID-123");
    expect(serialized).not.toContain("PRIVATE NOTE");
  });
});

describe("P4.6A financial tools", () => {
  it("returns aggregates and audits the call for an entitled admin", async () => {
    const { tools, mocks, logAgentToolCall } = await load(user("admin"));
    mocks.state.rpcResults.ai_get_revenue_summary = {
      data: { gross_total: 12000, outstanding_total: 300 },
      error: null,
    };

    const result = (await tools.get_revenue_summary!.execute!(
      { preset: "this_month" },
      opts,
    )) as { revenue: { gross_total: number } };

    expect(result.revenue.gross_total).toBe(12000);
    expect(logAgentToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "get_revenue_summary" }),
    );
  });

  it("compares two periods through a single RPC rather than model arithmetic", async () => {
    const { tools, mocks } = await load(user("admin"));
    mocks.state.rpcResults.ai_compare_revenue_periods = {
      data: { gross_delta: -500, gross_delta_percent: -4.1 },
      error: null,
    };

    const result = (await tools.compare_revenue_periods!.execute!(
      {
        period_a: { date_from: "2026-05-01", date_to: "2026-05-31" },
        period_b: { date_from: "2026-06-01", date_to: "2026-06-30" },
      },
      opts,
    )) as { comparison: { gross_delta: number } };

    expect(mocks.state.rpc).toHaveBeenCalledWith(
      "ai_compare_revenue_periods",
      expect.objectContaining({
        p_a_start: expect.any(String),
        p_b_end: expect.any(String),
      }),
    );
    expect(result.comparison.gross_delta).toBe(-500);
  });

  it("returns only name, amount, and age for outstanding balances", async () => {
    const { tools, mocks } = await load(user("admin"));
    mocks.state.tableResults["appointments"] = {
      data: [
        {
          id: "appt-1",
          scheduled_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
          outstanding_amount: 450,
          payment_note: "PRIVATE NOTE",
          patients: { full_name: "Jane Roe", national_id: "NATIONAL-ID-123" },
        },
      ],
      error: null,
    };

    const result = (await tools.list_outstanding_invoices!.execute!({ limit: 10 }, opts)) as {
      outstanding: Record<string, unknown>[];
    };

    expect(Object.keys(result.outstanding[0]!)).toEqual([
      "appointment_id",
      "patient_name",
      "outstanding_amount",
      "age_days",
    ]);
    expect(result.outstanding[0]!.age_days).toBe(3);
    expect(JSON.stringify(result)).not.toContain("NATIONAL-ID-123");
  });

  it("caps the requested limit at 25", async () => {
    const { tools, mocks } = await load(user("admin"));
    mocks.state.tableResults["appointments"] = { data: [], error: null };

    await tools.list_outstanding_invoices!.execute!({ limit: 25 }, opts);

    const limitCall = mocks.state.queryLog.find((entry) => entry.args[0] === "limit");
    expect(limitCall?.args[1]).toBe(26); // cap + 1, see L5 above
  });
});

describe("P4.6A run_clinic_report", () => {
  it("runs a permitted report and returns a verifiable deep link", async () => {
    const { tools, mocks, logAgentToolCall } = await load(user("admin"));
    mocks.state.rpcResults.get_no_show_report = {
      data: { totalAppointments: 100, noShowCount: 7, noShowRate: 7, byDoctor: [] },
      error: null,
    };

    const result = (await tools.run_clinic_report!.execute!(
      { report: "no_shows", preset: "this_month" },
      opts,
    )) as { link: string; result: { noShowCount: number } };

    expect(result.link).toContain("/reports/no-shows?");
    expect(result.link).toContain("preset=this_month");
    expect(result.result.noShowCount).toBe(7);
    expect(logAgentToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "run_clinic_report" }),
    );
  });

  it("denies a receptionist the revenue report before any read happens", async () => {
    const { tools, mocks } = await load(user("receptionist"));

    await expect(
      tools.run_clinic_report!.execute!({ report: "revenue", preset: "this_month" }, opts),
    ).resolves.toMatchObject({ permission_denied: true, reason: "role_forbidden" });
    expect(mocks.state.rpc).not.toHaveBeenCalled();
  });

  it("denies a manager the follow-ups report, matching the RPC's own denial", async () => {
    const { tools, mocks } = await load(user("manager"));

    await expect(
      tools.run_clinic_report!.execute!({ report: "followups", preset: "this_month" }, opts),
    ).resolves.toMatchObject({ permission_denied: true, reason: "role_forbidden" });
    expect(mocks.state.rpc).not.toHaveBeenCalled();
  });

  it("requires the financial gate for the revenue report even for a manager with the entitlement", async () => {
    const { tools, mocks } = await load(user("manager"), { financialPermission: null });

    // Returned, not thrown (phase review H1). A throw here happens inside the
    // model loop, where the route can no longer classify it and the user gets a
    // generic "try again" for a denial retrying cannot fix. The structured
    // result is what lets both the model and the UI say the actionable thing.
    const denial = (await tools.run_clinic_report!.execute!(
      { report: "revenue", preset: "this_month" },
      opts,
    )) as { permission_denied?: boolean; reason?: string; guidance?: string };
    expect(denial.permission_denied).toBe(true);
    expect(denial.reason).toBe("permission_not_granted");
    expect(denial.guidance).toMatch(/administrator/i);
    expect(mocks.state.rpc).not.toHaveBeenCalled();
  });
});

describe("P4.6A registry integrity", () => {
  it("declares roles, features, and bilingual capability copy for every tool", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    const { AI_TOOL_REGISTRY } = await import("@/lib/ai/tools/registry");

    expect(AI_TOOL_REGISTRY.length).toBeGreaterThan(0);
    for (const definition of AI_TOOL_REGISTRY) {
      expect(definition.roles.length).toBeGreaterThan(0);
      expect(definition.requiredFeatures.length).toBeGreaterThan(0);
      expect(definition.taskClasses.length).toBeGreaterThan(0);
      expect(definition.capabilityDescription.en.length).toBeGreaterThan(0);
      expect(definition.capabilityDescription.ar.length).toBeGreaterThan(0);
    }
  });

  it("gates every financial tool on both the entitlement and the per-user permission", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    const { AI_TOOL_REGISTRY } = await import("@/lib/ai/tools/registry");

    for (const name of FINANCIAL_TOOLS) {
      const definition = AI_TOOL_REGISTRY.find((entry) => entry.name === name);
      expect(definition).toBeDefined();
      expect(definition!.requiredFeatures).toContain("ai.financial_insights");
      expect(definition!.requiredUserPermission).toBe("ai.financial_insights");
      expect(definition!.roles).not.toContain("receptionist");
      expect(definition!.roles).not.toContain("doctor");
    }
  });

  it("registers no tool that a doctor could use for clinic-wide analytics", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    const { AI_TOOL_REGISTRY } = await import("@/lib/ai/tools/registry");

    for (const name of [...OPERATIONAL_TOOLS, ...FINANCIAL_TOOLS]) {
      const definition = AI_TOOL_REGISTRY.find((entry) => entry.name === name)!;
      expect(definition.roles).not.toContain("doctor");
    }
  });
});
