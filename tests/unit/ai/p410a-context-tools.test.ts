import { describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

// P4.10A default-parameter plumbing, observed behaviorally through the real
// tool execute():
//   * search_authorized_patients proposes the active patient only on a single
//     high-confidence match (never on medium/low/ambiguous).
// The model itself is never run — each execute() is driven directly.
//
// Phase 7. The `get_patient_summary` / `search_patient_visits` blocks that stood
// here went with their tools when the resource layer superseded them
// (`lib/ai/tools/superseded.ts`). Their server-side default-parameter fallback
// has no generic equivalent by design: the active-context entity id is already
// placed in the model's prompt (`conversation-context.ts` puts entity_type +
// entity_id there), so the model supplies it as a registered `id` filter and the
// compiler re-authorizes it exactly as those tools re-authorized theirs — a
// stale or forged id yields `unauthorized_scope`, asserted in
// phase1-resource-registry. The proposal half of P4.10A is unchanged for
// `search_authorized_patients` below, and is extended to the generic read path
// in `tests/unit/ai/phase7-context-parity.test.ts`.

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
      features: { ai_assistant: true, "ai.read_clinical": true },
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
  const { searchAuthorizedPatientsTool } = await import(
    "@/lib/ai/tools/search-authorized-patients"
  );

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
