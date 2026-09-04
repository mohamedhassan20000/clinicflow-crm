import { describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

/**
 * Phase 7 — active-context parity across the supersession (plan §14.3, §9).
 *
 * Superset coverage is a claim about the whole capability, not only the columns.
 * `list_appointments` and `list_doctor_appointments` did two things the field
 * comparison in `phase7-superset-coverage.test.ts` cannot see: they proposed the
 * doctor/department they had *resolved from the user's words*, and they proposed
 * the single appointment when the authorized result was unambiguously one row.
 * Without those, "show me Dr Ahmed's Thursday appointment" would stop leaving an
 * appointment in context and the next turn's "reschedule it" would have no
 * referent.
 *
 * These are the same assertions the P4.10B suite made against the removed tools,
 * re-pointed at `query_resource`. The P4.10 trust boundary is asserted with
 * them, not merely inherited: a uuid the model asserted never becomes stored
 * context, a truncated page never yields a "unique" match, and nothing is
 * proposed outside a conversation.
 */

const CLINIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION = "66666666-6666-4666-8666-666666666666";
const STAFF = "44444444-4444-4444-8444-444444444444";
const DEPARTMENT = "55555555-5555-4555-8555-555555555555";
const APPOINTMENT = "22222222-2222-4222-8222-222222222222";
const PATIENT = "33333333-3333-4333-8333-333333333333";

const opts = {} as never;

function appointmentRow(index: number) {
  return {
    id:
      index === 0
        ? APPOINTMENT
        : `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
    scheduled_at: "2026-07-26T10:00:00.000Z",
    status: "confirmed",
    duration_minutes: 30,
    patient: { id: PATIENT, full_name: "Mona Ali", file_number: "CF-1" },
  };
}

async function load(options: { conversationId?: string | null } = {}) {
  vi.resetModules();
  const mocks = createServerActionMocks();

  vi.doMock("server-only", () => ({}));
  vi.doMock("@sentry/nextjs", () => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));
  vi.doMock("@/lib/supabase/admin", () => ({
    logAgentToolCall: vi.fn(async () => ({ data: "audit", error: null })),
  }));
  vi.doMock("@/lib/server-page-permissions", () => ({
    getPageVisibilityState: vi.fn(async () => "visible"),
  }));
  vi.doMock("@/lib/entitlements", () => ({
    getEntitlements: vi.fn(async () => ({
      clinicId: CLINIC,
      planSlug: "pro_ai",
      features: { ai_assistant: true, "ai.read_operational": true },
      limits: {},
      subscriptionAllowed: true,
      aiTermsAccepted: true,
    })),
    hasFeature: (
      entitlements: { features: Record<string, boolean> },
      key: string,
    ) => entitlements.features[key] === true,
  }));

  const { ConversationContextRecorder } = await import(
    "@/lib/ai/conversation-context"
  );
  const { queryResourceTool } = await import("@/lib/ai/tools/query-resource");

  const recorder = new ConversationContextRecorder();
  const tool = queryResourceTool({
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      email: "admin@example.test",
      role: "admin",
      fullName: "Admin",
      avatarUrl: null,
      clinicId: CLINIC,
      departmentId: null,
      mustChangePassword: false,
    } as never,
    locale: "en",
    conversationId:
      "conversationId" in options ? options.conversationId : CONVERSATION,
    contextRecorder: recorder,
  } as never);

  return { mocks, recorder, tool };
}

describe("Phase 7 · query_resource inherits the P4.10 context proposals", () => {
  it("records deterministic name resolutions and a unique authorized appointment", async () => {
    const { mocks, recorder, tool } = await load();
    mocks.state.rpcResults.search_staff_ranked = {
      data: [{ id: STAFF, full_name: "Dr Ahmed", score: 0.99 }],
      error: null,
    };
    mocks.state.rpcResults.search_departments_ranked = {
      data: [{ id: DEPARTMENT, name: "Cardiology", score: 0.99 }],
      error: null,
    };
    mocks.state.tableResults.appointments = {
      data: [appointmentRow(0)],
      error: null,
      count: 1,
    };

    await tool.execute!(
      {
        resource: "appointments",
        filters: { doctor: "Dr Ahmed", department: "Cardiology" },
        relations: { patient: ["id", "full_name"] },
      },
      opts,
    );

    expect(recorder.takeAll()).toEqual([
      {
        entityType: "staff",
        entityId: STAFF,
        displayLabel: "Dr Ahmed",
        setBy: "resolution",
      },
      {
        entityType: "department",
        entityId: DEPARTMENT,
        displayLabel: "Cardiology",
        setBy: "resolution",
      },
      {
        entityType: "appointment",
        entityId: APPOINTMENT,
        displayLabel: "Mona Ali · 2026-07-26T10:00:00.000Z",
        setBy: "resolution",
      },
    ]);
  });

  it("proposes a patient resolved as the single row of an authorized filter", async () => {
    const { mocks, recorder, tool } = await load();
    mocks.state.tableResults.patients = {
      data: [{ id: PATIENT, full_name: "Mona Ali", file_number: "CF-1" }],
      error: null,
      count: 1,
    };

    await tool.execute!(
      { resource: "patients", filters: { file_number: "CF-1" } },
      opts,
    );

    expect(recorder.takeAll()).toEqual([
      {
        entityType: "patient",
        entityId: PATIENT,
        displayLabel: "Mona Ali",
        setBy: "resolution",
      },
    ]);
  });

  it("never promotes a model-supplied staff UUID into stored context", async () => {
    const { mocks, recorder, tool } = await load();
    // The uuid path revalidates against the caller's own visibility, then
    // filters by it — but the resolution is not `trustedForContext`.
    mocks.state.tableResults.profiles = {
      data: { full_name: "Dr Ahmed" },
      error: null,
    };
    mocks.state.tableResults.appointments = { data: [], error: null, count: 0 };

    await tool.execute!(
      { resource: "appointments", filters: { doctor: STAFF } },
      opts,
    );

    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({ args: ["eq", "doctor_id", STAFF] }),
    );
    expect(recorder.takeAll()).toEqual([]);
  });

  it("never promotes a record addressed by id into stored context", async () => {
    const { mocks, recorder, tool } = await load();
    mocks.state.tableResults.patients = {
      data: [{ id: PATIENT, full_name: "Mona Ali", file_number: "CF-1" }],
      error: null,
      count: 1,
    };

    await tool.execute!({ resource: "patients", filters: { id: PATIENT } }, opts);

    expect(recorder.takeAll()).toEqual([]);
  });

  it("does not infer a unique appointment from a truncated page", async () => {
    const { mocks, recorder, tool } = await load();
    mocks.state.tableResults.appointments = {
      data: Array.from({ length: 51 }, (_, index) => appointmentRow(index)),
      error: null,
      count: 120,
    };

    await tool.execute!(
      { resource: "appointments", page_size: 50 },
      opts,
    );

    expect(recorder.takeAll()).toEqual([]);
  });

  it("does not propose from an ambiguous multi-row result", async () => {
    const { mocks, recorder, tool } = await load();
    mocks.state.tableResults.patients = {
      data: [
        { id: PATIENT, full_name: "Mona Ali", file_number: "CF-1" },
        {
          id: "99999999-9999-4999-8999-999999999999",
          full_name: "Mona Aly",
          file_number: "CF-2",
        },
      ],
      error: null,
      count: 2,
    };

    await tool.execute!(
      { resource: "patients", filters: { full_name: "Mona" } },
      opts,
    );

    expect(recorder.takeAll()).toEqual([]);
  });

  it("never narrows a broad query with an active-context slot", async () => {
    // `list_appointments` had to carry explicit `use_active_*` intent flags so a
    // stale slot could not silently narrow a clinic-wide question. The generic
    // path retires that whole class of bug: it reads no active context, so the
    // only ids that reach a filter are ones the model named. The slots below are
    // set and must leave no trace in the query.
    const { mocks, tool } = await load();
    mocks.state.tableResults.appointments = { data: [], error: null, count: 0 };

    await tool.execute!({ resource: "appointments" }, opts);

    const eqFilters = mocks.state.queryLog.filter(
      (entry) => entry.args[0] === "eq",
    );
    for (const entry of eqFilters) {
      expect([APPOINTMENT, STAFF, DEPARTMENT]).not.toContain(entry.args[2]);
    }
    // The only injected equality is the caller-owned tenant predicate.
    expect(
      eqFilters.some(
        (entry) => entry.args[1] === "clinic_id" && entry.args[2] === CLINIC,
      ),
    ).toBe(true);
  });

  it("does not propose when there is no conversation to bind to", async () => {
    const { mocks, recorder, tool } = await load({ conversationId: null });
    mocks.state.rpcResults.search_staff_ranked = {
      data: [{ id: STAFF, full_name: "Dr Ahmed", score: 0.99 }],
      error: null,
    };
    mocks.state.tableResults.appointments = {
      data: [appointmentRow(0)],
      error: null,
      count: 1,
    };

    await tool.execute!(
      {
        resource: "appointments",
        filters: { doctor: "Dr Ahmed" },
        relations: { patient: ["id", "full_name"] },
      },
      opts,
    );

    expect(recorder.takeAll()).toEqual([]);
  });
});
