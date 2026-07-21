import { describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

/**
 * Regression suite for `docs/reviews/P4.6_PHASE_REVIEW.md`.
 *
 * One describe block per finding, named by its id, so a future reader can go
 * from a finding to the assertion that keeps it closed without reading the
 * review. The model is never exercised — `execute()` and the mount resolution
 * are driven directly, which is what makes these assertions about
 * authorization and contract rather than about prompting.
 */

type Role = "admin" | "manager" | "receptionist" | "doctor";
type MockUser = { id: string; clinicId: string; role: Role; departmentId: null; fullName: string };

const CLINIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function user(role: Role): MockUser {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    clinicId: CLINIC,
    role,
    departmentId: null,
    fullName: "Test User",
  };
}

const PRO_AI_FEATURES = {
  ai_assistant: true,
  "ai.staff_assistant": true,
  "ai.staff_analytics": true,
  "ai.financial_insights": true,
};

type LoadOptions = {
  features?: Record<string, boolean>;
  financialPermission?: boolean | null;
  taskClass?: string | null;
};

async function load(actor: MockUser, options: LoadOptions = {}) {
  vi.resetModules();
  const mocks = createServerActionMocks();
  // Typed parameter so `mock.calls[0][0]` is inspectable rather than `never`.
  const logAgentToolCall = vi.fn(async (input: Record<string, unknown>) => {
    void input;
    return { data: "audit-1", error: null };
  });

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
    getPageVisibilityState: vi.fn(async () => "visible"),
  }));

  if (options.financialPermission !== undefined) {
    mocks.state.tableResults["user_ai_permissions"] =
      options.financialPermission === null
        ? { data: null, error: null }
        : { data: { granted: options.financialPermission }, error: null };
  }

  const { buildStaffTools, resolveToolMount } = await import("@/lib/ai/tools");
  const context = {
    user: actor as never,
    locale: "en",
    taskClass: options.taskClass as never,
  } as const;
  return {
    tools: await buildStaffTools(context),
    mount: await resolveToolMount(context),
    mocks,
    logAgentToolCall,
  };
}

const opts = {} as never;

// ---------------------------------------------------------------------------
// H1 — run_clinic_report advertised a report it would then refuse, and the
//      refusal was unpresentable.
// ---------------------------------------------------------------------------

describe("H1 — the advertised report list matches what execute() will allow", () => {
  it("hides the revenue report from a manager without the financial grant", async () => {
    const { tools } = await load(user("manager"), { financialPermission: null });
    const description = (tools.run_clinic_report as { description: string }).description;

    expect(description).not.toContain("revenue");
    // The non-financial reports a manager genuinely may run are still offered —
    // the fix narrows the description, it does not unmount the tool.
    expect(description).toContain("cancellations");
    expect(description).toContain("doctor_performance");
  });

  it("offers the revenue report once the grant is present", async () => {
    const { tools } = await load(user("manager"), { financialPermission: true });
    expect((tools.run_clinic_report as { description: string }).description).toContain(
      "revenue",
    );
  });

  it("never offers a report the role itself may not run", async () => {
    const { tools } = await load(user("receptionist"));
    const description = (tools.run_clinic_report as { description: string }).description;
    // Receptionists are excluded from both performance reports and revenue.
    expect(description).not.toContain("doctor_performance");
    expect(description).not.toContain("receptionist_performance");
    expect(description).not.toContain("revenue");
    expect(description).toContain("followups");
  });

  it("returns a permission denial the UI can classify instead of throwing", async () => {
    const { tools } = await load(user("manager"), { financialPermission: false });
    const result = (await tools.run_clinic_report!.execute!(
      { report: "revenue", preset: "this_month" },
      opts,
    )) as Record<string, unknown>;

    expect(result.permission_denied).toBe(true);
    expect(result.reason).toBe("permission_not_granted");
  });

  it("distinguishes an entitlement failure from a permission failure", async () => {
    const { tools } = await load(user("manager"), {
      features: { ...PRO_AI_FEATURES, "ai.financial_insights": false },
      financialPermission: true,
    });
    const result = (await tools.run_clinic_report!.execute!(
      { report: "revenue", preset: "this_month" },
      opts,
    )) as Record<string, unknown>;

    expect(result.reason).toBe("feature_not_entitled");
  });

  /**
   * Superseded by review #2's H2/M3, and kept rather than deleted because the
   * *authorization* half of it is unchanged and worth pinning: a receptionist
   * is still refused the revenue report, by the same role check, before any
   * read.
   *
   * What changed is the shape. Review #1 reasoned that `role_forbidden` should
   * keep throwing because it is "a wiring bug, not a state a user can act on",
   * on the understanding that a throw carried its reason to the client. It does
   * not — a thrown tool error becomes a `tool-output-error` part whose reason
   * the UI discarded, so the deliberate loud failure was the quietest outcome
   * of the three. It is now a structured denial like every other reason, with
   * copy that says plainly that the tool is not available for this role.
   */
  it("returns a classified role denial rather than throwing into the model loop", async () => {
    const { tools } = await load(user("receptionist"));
    await expect(
      tools.run_clinic_report!.execute!({ report: "revenue", preset: "this_month" }, opts),
    ).resolves.toMatchObject({
      permission_denied: true,
      reason: "role_forbidden",
      guidance: expect.stringContaining("role"),
    });
  });
});

describe("H1 — the denial survives the presentation layer", () => {
  it("renders a permission denial as its own notice", async () => {
    const { summarizeToolResult } = await import("@/lib/ai/tool-presentation");
    const summary = summarizeToolResult({
      permission_denied: true,
      reason: "permission_not_granted",
      report: "revenue",
    });

    expect(summary.notices).toContainEqual({
      kind: "permission_denied",
      reason: "permission_not_granted",
    });
  });

  it("ignores a denial payload that does not name a known reason", async () => {
    const { summarizeToolResult } = await import("@/lib/ai/tool-presentation");
    const summary = summarizeToolResult({ permission_denied: true, reason: "nonsense" });
    expect(summary.notices).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M3 — the audit ledger recorded successes, not invocations.
// ---------------------------------------------------------------------------

describe("M3 — denied, clarified, and failed invocations are audited", () => {
  it("writes an audit row when a tool denies", async () => {
    const { tools, logAgentToolCall } = await load(user("receptionist"));
    await tools.run_clinic_report!.execute!(
      { report: "revenue", preset: "this_month" },
      opts,
    );

    // The denial itself is the thing an audit ledger exists to answer for: who
    // tried to reach financial data and was refused. Still exactly one row: the
    // conversion to a structured result must not make the wrapper log the
    // denial once in the catch and again as a "result".
    expect(logAgentToolCall).toHaveBeenCalledTimes(1);
    expect(logAgentToolCall.mock.calls[0]![0]).toMatchObject({
      clinicId: CLINIC,
      tool: "run_clinic_report",
    });
  });

  it("writes an audit row for a structured permission denial", async () => {
    const { tools, logAgentToolCall } = await load(user("manager"), {
      financialPermission: false,
    });
    await tools.run_clinic_report!.execute!(
      { report: "revenue", preset: "this_month" },
      opts,
    );
    expect(logAgentToolCall).toHaveBeenCalledTimes(1);
  });

  it("writes an audit row when a tool stops to ask for clarification", async () => {
    const { tools, mocks, logAgentToolCall } = await load(user("admin"));
    // Two equally-ranked namesakes force the clarification contract.
    mocks.state.rpcResults["search_staff_ranked"] = {
      data: [
        { id: "d1", full_name: "Ahmed Ali", score: 0.6 },
        { id: "d2", full_name: "Ahmed Aly", score: 0.6 },
      ],
      error: null,
    };

    const result = (await tools.list_appointments!.execute!(
      { preset: "today", doctor: "Ahmed" },
      opts,
    )) as Record<string, unknown>;

    expect(result.needs_clarification).toBe(true);
    expect(logAgentToolCall).toHaveBeenCalledTimes(1);
  });

  it("does not double-log a successful invocation", async () => {
    const { tools, mocks, logAgentToolCall } = await load(user("admin"));
    mocks.state.tableResults["appointments"] = { data: [], error: null };
    await tools.list_appointments!.execute!({ preset: "today" }, opts);
    // The tool logs its own success with the redacted parameter detail the
    // wrapper cannot see; the wrapper must stay out of the way.
    expect(logAgentToolCall).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// M5 — the clarification candidate set was the largest PII payload in the phase.
// ---------------------------------------------------------------------------

describe("M5 — contact details are withheld from a candidate list", () => {
  async function search(rows: unknown[]) {
    const { tools, mocks } = await load(user("receptionist"));
    mocks.state.rpcResults["search_patients_ranked"] = { data: rows, error: null };
    return (await tools.search_authorized_patients!.execute!(
      { query: "mohamed" },
      opts,
    )) as {
      confidence: string;
      contact_details_withheld: boolean;
      patients: { phone: string | null; email: string | null; full_name: string }[];
    };
  }

  it("masks phone and drops email when the user must choose", async () => {
    const result = await search([
      { id: "p1", full_name: "Mohamed Hassan", file_number: "CF-1", phone: "+96550001111", email: "a@example.com", score: 0.6, match_kind: "name_fuzzy" },
      { id: "p2", full_name: "Mohammed Hassan", file_number: "CF-2", phone: "+96550002222", email: "b@example.com", score: 0.58, match_kind: "name_fuzzy" },
    ]);

    expect(result.confidence).not.toBe("high");
    expect(result.contact_details_withheld).toBe(true);
    for (const patient of result.patients) {
      expect(patient.email).toBeNull();
      expect(patient.phone).toMatch(/^••••\d{4}$/);
    }
    // Identity is still complete — it is what the user disambiguates on.
    expect(result.patients[0]!.full_name).toBe("Mohamed Hassan");
  });

  it("returns full contact details for a single confident match", async () => {
    const result = await search([
      { id: "p1", full_name: "Mohamed Hassan", file_number: "CF-1", phone: "+96550001111", email: "a@example.com", score: 1, match_kind: "file_number" },
    ]);

    expect(result.confidence).toBe("high");
    expect(result.contact_details_withheld).toBe(false);
    expect(result.patients[0]!.phone).toBe("+96550001111");
    expect(result.patients[0]!.email).toBe("a@example.com");
  });
});

// ---------------------------------------------------------------------------
// M6 — the task-class gate is enforced, but currently excludes nothing.
// ---------------------------------------------------------------------------

describe("M6 — the task-class gate is mechanically load-bearing", () => {
  it("excludes P4.6 tools from a clinical-summary turn", async () => {
    // Use the role that can actually run this certified class. Unsupported
    // role/class pairings now fail closed with an empty mount; the separate
    // P4.7 union-contract test pins that behavior.
    const { mount } = await load(user("doctor"), { taskClass: "staff_clinical_summary" });
    const names = mount.definitions.map((definition) => definition.name);

    expect(names).not.toContain("get_clinic_summary");
    expect(names).not.toContain("run_clinic_report");
    expect(names).toContain("search_authorized_patients");
  });

  it("mounts the operational tools for an administrative turn", async () => {
    const { mount } = await load(user("admin"), { taskClass: "staff_operational_query" });
    expect(mount.definitions.map((d) => d.name)).toContain("get_clinic_summary");
  });
});

// ---------------------------------------------------------------------------
// M7 — central sanitization silently truncated and reflowed every string.
// ---------------------------------------------------------------------------

describe("M7 — report pass-through text survives, and truncation is visible", () => {
  it("does not clip a report's free text to a name-sized cap", async () => {
    const { sanitizeUntrustedDeep } = await import("@/lib/ai/untrusted-text");
    const reason = "Patient rescheduled. ".repeat(30); // ~600 chars
    const result = sanitizeUntrustedDeep({
      result: { rows: [{ cancellation_reason: reason }] },
    }) as { result: { rows: { cancellation_reason: string }[] } };

    expect(result.result.rows[0]!.cancellation_reason).not.toContain("…");
    expect(result.result.rows[0]!.cancellation_reason.length).toBeGreaterThan(500);
  });

  it("still caps a name tightly — a 5,000-character name is not a name", async () => {
    const { sanitizeUntrustedDeep } = await import("@/lib/ai/untrusted-text");
    const result = sanitizeUntrustedDeep({
      patients: [{ full_name: "x".repeat(5_000) }],
    }) as { patients: { full_name: string }[] };
    expect(result.patients[0]!.full_name.length).toBe(201);
  });

  it("reports which fields were truncated so nothing is silently clipped", async () => {
    const { sanitizeUntrustedDeep } = await import("@/lib/ai/untrusted-text");
    const truncated: string[] = [];
    sanitizeUntrustedDeep(
      { patients: [{ full_name: "x".repeat(5_000) }] },
      { onTruncate: (path) => truncated.push(path) },
    );
    expect(truncated).toEqual(["patients[0].full_name"]);
  });

  it("surfaces the truncation signal on the tool result", async () => {
    const { tools, mocks } = await load(user("admin"));
    mocks.state.tableResults["appointments"] = {
      data: [
        {
          id: "a1",
          scheduled_at: "2026-07-20T09:00:00.000Z",
          status: "confirmed",
          duration_minutes: 30,
          patients: { full_name: "y".repeat(400), file_number: "CF-1" },
          profiles: { full_name: "Dr House" },
          departments: { name: "Cardiology" },
        },
      ],
      error: null,
    };

    const result = (await tools.list_appointments!.execute!({ preset: "today" }, opts)) as {
      text_truncated_fields?: string[];
    };
    expect(result.text_truncated_fields).toContain("appointments[0].patient_name");
  });

  it("renders the truncation signal as a user-visible notice", async () => {
    const { summarizeToolResult } = await import("@/lib/ai/tool-presentation");
    const summary = summarizeToolResult({ text_truncated_fields: ["a.b", "c.d"] });
    expect(summary.notices).toContainEqual({ kind: "text_truncated", fields: 2 });
  });
});

// ---------------------------------------------------------------------------
// L5 / L6 / L7 — honesty of the bounded lists, filters, and provenance.
// ---------------------------------------------------------------------------

describe("L5 — `truncated` is false when the row count exactly equals the cap", () => {
  function appointment(index: number) {
    return {
      id: `a${index}`,
      scheduled_at: "2026-07-20T09:00:00.000Z",
      status: "confirmed",
      duration_minutes: 30,
      patients: { full_name: `Patient ${index}`, file_number: `CF-${index}` },
      profiles: { full_name: "Dr House" },
      departments: { name: "Cardiology" },
    };
  }

  it("does not claim truncation at exactly 50 appointments", async () => {
    const { tools, mocks } = await load(user("admin"));
    mocks.state.tableResults["appointments"] = {
      data: Array.from({ length: 50 }, (_, i) => appointment(i)),
      error: null,
    };
    const result = (await tools.list_appointments!.execute!({ preset: "today" }, opts)) as {
      truncated: boolean;
      appointments: unknown[];
    };
    expect(result.truncated).toBe(false);
    expect(result.appointments).toHaveLength(50);
  });

  it("claims truncation, and returns exactly the cap, at 51", async () => {
    const { tools, mocks } = await load(user("admin"));
    mocks.state.tableResults["appointments"] = {
      data: Array.from({ length: 51 }, (_, i) => appointment(i)),
      error: null,
    };
    const result = (await tools.list_appointments!.execute!({ preset: "today" }, opts)) as {
      truncated: boolean;
      appointments: unknown[];
    };
    expect(result.truncated).toBe(true);
    expect(result.appointments).toHaveLength(50);
  });
});

describe("L6 — a doctor filter is only resolved for reports that use one", () => {
  it("does not ask about a doctor for the follow-ups report", async () => {
    const { tools, mocks } = await load(user("admin"));
    // Ambiguous on purpose: if the filter were resolved, this would clarify.
    mocks.state.rpcResults["search_staff_ranked"] = {
      data: [
        { id: "d1", full_name: "Ahmed Ali", score: 0.6 },
        { id: "d2", full_name: "Ahmed Aly", score: 0.6 },
      ],
      error: null,
    };
    mocks.state.rpcResults["get_followups_dashboard"] = { data: {}, error: null };

    const result = (await tools.run_clinic_report!.execute!(
      { report: "followups", preset: "this_month", doctor: "Ahmed" },
      opts,
    )) as Record<string, unknown>;

    expect(result.needs_clarification).toBeUndefined();
    expect(result.doctor_filter_supported).toBe(false);
    expect(result.doctor_filter_applied).toBe(false);
  });
});

describe("L7 — the provenance marker means exactly one thing", () => {
  it("does not overwrite a provenance a tool set for itself", async () => {
    const { withProvenance } = await import("@/lib/ai/untrusted-text");
    const result = withProvenance({ data_provenance: "custom_claim", rows: [] });
    expect(result.data_provenance).toBe("custom_claim");
  });

  it("does not call a candidate-free clarification 'records entered by staff'", async () => {
    const { withProvenance } = await import("@/lib/ai/untrusted-text");
    const result = withProvenance({
      needs_clarification: true,
      field: "doctor",
      guidance: "Ask the user.",
      candidates: [],
    });
    expect(result.data_provenance).toMatch(/^system_generated:/);
  });

  it("keeps tenant framing when a clarification carries tenant names", async () => {
    const { withProvenance } = await import("@/lib/ai/untrusted-text");
    const result = withProvenance({
      needs_clarification: true,
      candidates: [{ id: "d1", name: "Ahmed Ali" }],
    });
    expect(result.data_provenance).toMatch(/^untrusted_tenant_text:/);
  });
});
