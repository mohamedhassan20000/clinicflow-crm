import { describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

// P4.10A default-parameter plumbing, observed behaviorally through the real
// tool execute():
//   * search_authorized_patients proposes the active patient only on a single
//     high-confidence match (never on medium/low/ambiguous).
//   * get_patient_summary / search_patient_visits fall back to the active
//     patient when the model omits patient_id, re-authorize the effective id
//     (so a stale context returns found:false, never data), and ask for
//     clarification when there is no patient in context.
// The model itself is never run — each execute() is driven directly.

const DOCTOR = {
  id: "11111111-1111-4111-8111-111111111111",
  clinicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  role: "doctor" as const,
  departmentId: "dept-1",
  email: "doc@clinic.test",
  fullName: "Dr House",
  avatarUrl: null,
  mustChangePassword: false,
};

const ACTIVE_PATIENT = "22222222-2222-4222-8222-222222222222";
const OTHER_PATIENT = "33333333-3333-4333-8333-333333333333";
const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";

const opts = {} as never;

type ContextOverrides = {
  activePatientId?: string | null;
  conversationId?: string | null;
  withRecorder?: boolean;
};

async function loadContextTools(overrides: ContextOverrides = {}) {
  vi.resetModules();
  const mocks = createServerActionMocks();
  const logAgentToolCall = vi.fn<
    (input: {
      clinicId: string;
      actorId: string | null;
      tool: string;
      tableName?: string | null;
      recordId?: string | null;
      summary?: Record<string, unknown>;
    }) => Promise<{ data: string; error: null }>
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
      clinicId: DOCTOR.clinicId,
      planSlug: "pro_ai",
      features: { ai_assistant: true },
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

  const { ConversationContextRecorder } = await import("@/lib/ai/conversation-context");
  const [{ getPatientSummaryTool }, { searchPatientVisitsTool }, { searchAuthorizedPatientsTool }] =
    await Promise.all([
      import("@/lib/ai/tools/get-patient-summary"),
      import("@/lib/ai/tools/search-patient-visits"),
      import("@/lib/ai/tools/search-authorized-patients"),
    ]);

  const recorder = overrides.withRecorder ? new ConversationContextRecorder() : null;
  const context = {
    user: DOCTOR as never,
    locale: "en" as const,
    activePatientId: overrides.activePatientId,
    conversationId: "conversationId" in overrides ? overrides.conversationId : CONVERSATION_ID,
    contextRecorder: recorder,
  };
  return {
    mocks,
    logAgentToolCall,
    recorder,
    get_patient_summary: getPatientSummaryTool(context),
    search_patient_visits: searchPatientVisitsTool(context),
    search_authorized_patients: searchAuthorizedPatientsTool(context),
  };
}

function rankedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ACTIVE_PATIENT,
    full_name: "Mohamed Hassan",
    file_number: "CF-1",
    phone: "+96550000001",
    email: "m@example.com",
    score: 0.95,
    match_kind: "name_fuzzy",
    ...overrides,
  };
}

describe("search_authorized_patients active-context proposal", () => {
  it("proposes the active patient on a single high-confidence match", async () => {
    const { search_authorized_patients, recorder, mocks } = await loadContextTools({ withRecorder: true });
    mocks.state.rpcResults.search_patients_ranked = { data: [rankedRow()], error: null };

    const result = (await search_authorized_patients.execute!({ query: "Mohamed" }, opts)) as {
      confidence: string;
    };
    expect(result.confidence).toBe("high");
    expect(recorder!.take()).toEqual({
      entityType: "patient",
      entityId: ACTIVE_PATIENT,
      displayLabel: "Mohamed Hassan",
      setBy: "resolution",
    });
  });

  it("does not propose on a medium/ambiguous multi-candidate result", async () => {
    const { search_authorized_patients, recorder, mocks } = await loadContextTools({ withRecorder: true });
    mocks.state.rpcResults.search_patients_ranked = {
      data: [rankedRow({ score: 0.5 }), rankedRow({ id: OTHER_PATIENT, score: 0.48 })],
      error: null,
    };

    const result = (await search_authorized_patients.execute!({ query: "Mohamed" }, opts)) as {
      confidence: string;
    };
    expect(result.confidence).not.toBe("high");
    expect(recorder!.take()).toBeNull();
  });

  it("does not propose when there is no conversation to bind to", async () => {
    const { search_authorized_patients, recorder, mocks } = await loadContextTools({
      withRecorder: true,
      conversationId: null,
    });
    mocks.state.rpcResults.search_patients_ranked = { data: [rankedRow()], error: null };

    await search_authorized_patients.execute!({ query: "Mohamed" }, opts);
    expect(recorder!.take()).toBeNull();
  });
});

describe("get_patient_summary default parameter + re-authorization", () => {
  function seedSummary(mocks: Awaited<ReturnType<typeof loadContextTools>>["mocks"], patientRow: unknown) {
    mocks.state.tableResults["patients"] = { data: patientRow, error: null };
    mocks.state.tableResults["appointments"] = { data: [], error: null };
    mocks.state.tableResults["medical_notes"] = { data: [], error: null };
    mocks.state.tableResults["follow_ups"] = { data: [], error: null };
    mocks.state.tableResults["patient_packages"] = { data: [], error: null };
  }

  it("uses the active patient when the id is omitted and re-scopes the read to it", async () => {
    const tools = await loadContextTools({ activePatientId: ACTIVE_PATIENT });
    seedSummary(tools.mocks, {
      id: ACTIVE_PATIENT, full_name: "Mohamed Hassan", date_of_birth: "1990-01-01",
      blood_type: "O+", clinic_id: DOCTOR.clinicId,
    });

    const result = (await tools.get_patient_summary.execute!({}, opts)) as { found: boolean };
    expect(result.found).toBe(true);
    // The id-scoped read used the active patient id.
    const idFilter = tools.mocks.state.queryLog.find(
      (q) => q.args[0] === "eq" && q.args[1] === "id",
    );
    expect(idFilter?.args[2]).toBe(ACTIVE_PATIENT);
    // Audited as an active-context resolution.
    expect(tools.logAgentToolCall.mock.calls[0][0]).toMatchObject({
      tool: "get_patient_summary",
      summary: expect.objectContaining({ from_active_context: true }),
    });
  });

  it("prefers an explicit id over the active patient and marks it not-from-context", async () => {
    const tools = await loadContextTools({ activePatientId: ACTIVE_PATIENT });
    seedSummary(tools.mocks, {
      id: OTHER_PATIENT, full_name: "Sara", date_of_birth: "1990-01-01",
      blood_type: "A+", clinic_id: DOCTOR.clinicId,
    });

    await tools.get_patient_summary.execute!({ patient_id: OTHER_PATIENT }, opts);
    const idFilter = tools.mocks.state.queryLog.find((q) => q.args[0] === "eq" && q.args[1] === "id");
    expect(idFilter?.args[2]).toBe(OTHER_PATIENT);
    expect(tools.logAgentToolCall.mock.calls[0][0]).toMatchObject({
      summary: expect.objectContaining({ from_active_context: false }),
    });
  });

  it("returns found:false when the active patient is no longer in RLS scope (revocation)", async () => {
    // A stale/forged context id: RLS returns no row, so the tool leaks nothing.
    const tools = await loadContextTools({ activePatientId: ACTIVE_PATIENT });
    seedSummary(tools.mocks, null);

    const result = (await tools.get_patient_summary.execute!({}, opts)) as { found: boolean };
    expect(result.found).toBe(false);
    expect(result).not.toHaveProperty("patient");
  });

  it("asks for clarification when no id is given and no patient is in context", async () => {
    const tools = await loadContextTools({ activePatientId: null });
    const result = (await tools.get_patient_summary.execute!({}, opts)) as {
      needs_clarification: boolean; field: string;
    };
    expect(result).toMatchObject({ needs_clarification: true, field: "patient_id" });
    // No patient read was attempted.
    expect(tools.mocks.state.queryLog.some((q) => q.table === "patients")).toBe(false);
    expect(tools.logAgentToolCall).not.toHaveBeenCalled();
  });
});

describe("search_patient_visits default parameter + re-authorization", () => {
  it("uses the active patient when the id is omitted", async () => {
    const tools = await loadContextTools({ activePatientId: ACTIVE_PATIENT });
    tools.mocks.state.tableResults["patients"] = { data: { id: ACTIVE_PATIENT }, error: null };
    tools.mocks.state.tableResults["medical_notes"] = { data: [], error: null };
    tools.mocks.state.tableResults["appointments"] = { data: [], error: null };

    const result = (await tools.search_patient_visits.execute!({ query: "fever" }, opts)) as {
      found: boolean;
    };
    expect(result.found).toBe(true);
    const idFilter = tools.mocks.state.queryLog.find((q) => q.args[0] === "eq" && q.args[1] === "id");
    expect(idFilter?.args[2]).toBe(ACTIVE_PATIENT);
    expect(tools.logAgentToolCall.mock.calls[0][0]).toMatchObject({
      summary: expect.objectContaining({ from_active_context: true }),
    });
  });

  it("returns found:false for a stale context patient outside RLS scope", async () => {
    const tools = await loadContextTools({ activePatientId: ACTIVE_PATIENT });
    tools.mocks.state.tableResults["patients"] = { data: null, error: null };

    const result = (await tools.search_patient_visits.execute!({ query: "fever" }, opts)) as {
      found: boolean; notes: unknown[]; appointments: unknown[];
    };
    expect(result).toMatchObject({ found: false, notes: [], appointments: [] });
  });

  it("asks for clarification with no id and no active patient", async () => {
    const tools = await loadContextTools({ activePatientId: null });
    const result = (await tools.search_patient_visits.execute!({ query: "fever" }, opts)) as {
      needs_clarification: boolean; field: string;
    };
    expect(result).toMatchObject({ needs_clarification: true, field: "patient_id" });
    expect(tools.mocks.state.queryLog.some((q) => q.table === "patients")).toBe(false);
  });
});
