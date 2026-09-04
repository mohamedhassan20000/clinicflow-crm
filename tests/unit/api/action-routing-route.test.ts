import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The reported action-routing defect, encoded as a route-level scenario rather
 * than as a regex property (review §9.3).
 *
 * Unlike `p4b-chat-route.test.ts`, this file deliberately runs the **real**
 * task-class router inside the route, stubbing only the budget reservation, the
 * agent, and the database. The bug was that the class is computed per request
 * and the mount follows it, so the only faithful reproduction drives the actual
 * request path across several turns of one conversation.
 */

const USER = {
  id: "00000000-0000-4000-8000-000000000001",
  clinicId: "00000000-0000-4000-8000-000000000002",
  email: "reception@example.com",
  fullName: "Test Receptionist",
  role: "receptionist" as const,
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
};

const PATIENT = "00000000-0000-4000-8000-000000000011";
const APPOINTMENT = "00000000-0000-4000-8000-000000000012";
const conversationId = "00000000-0000-4000-8000-000000000010";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  prepareExecution: vi.fn(),
  finalizeExecution: vi.fn(),
  rateLimit: vi.fn(),
  ensureConversation: vi.fn(),
  persistTurn: vi.fn(),
  createAgent: vi.fn(),
  stream: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("next-intl/server", () => ({ getLocale: async () => "en" }));
vi.mock("@/lib/ai/authorization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/authorization")>();
  return { ...actual, authorizeStaffAssistant: mocks.authorize };
});
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: async () => ({
    clinicId: USER.clinicId,
    planSlug: "pro_ai",
    features: {
      ai_assistant: true,
      "ai.staff_assistant": true,
      "ai.staff_analytics": true,
      "ai.write_scheduling": true,
    },
    limits: {},
    subscriptionAllowed: true,
  }),
  hasFeature: (
    ents: { subscriptionAllowed: boolean; features: Record<string, boolean> },
    key: string,
  ) => ents.subscriptionAllowed && ents.features[key] === true,
}));
// The real router, the stubbed reservation. This is the point of the file.
vi.mock("@/lib/ai/client", async () => {
  const execution = await import("@/lib/ai/platform/execution");
  return {
    AiPolicyInputLimitError: execution.AiPolicyInputLimitError,
    createAiRequestId: () => "00000000-0000-4000-8000-000000000099",
    staffTaskForRole: execution.staffTaskForRole,
    prepareAiExecution: mocks.prepareExecution,
  };
});
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.rateLimit }));
vi.mock("@/lib/ai/conversations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/conversations")>();
  return {
    ...actual,
    ensureDoctorConversation: mocks.ensureConversation,
    persistDoctorTurn: mocks.persistTurn,
  };
});
vi.mock("@/lib/ai/staff-agent", () => ({ createStaffAgent: mocks.createAgent }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const chain: Record<string, unknown> = {
        maybeSingle: async () => ({ data: { name: "Test Clinic" }, error: null }),
      };
      for (const method of ["select", "eq", "is", "in", "order", "limit"]) {
        chain[method] = () => chain;
      }
      return chain;
    },
  }),
}));

import { POST } from "@/app/api/agent/chat/route";
import { AI_TOOL_REGISTRY_BY_NAME } from "@/lib/ai/tools/registry";

function slot(entityType: string, entityId: string) {
  return {
    entity_type: entityType,
    entity_id: entityId,
    display_label: "Resolved",
    set_at: new Date().toISOString(),
    set_by: "resolution" as const,
  };
}

function request(text: string) {
  return new Request("https://clinicflow.test/api/agent/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: conversationId,
      message: {
        id: `message-${Math.random().toString(36).slice(2)}`,
        role: "user",
        parts: [{ type: "text", text }],
      },
    }),
  });
}

async function taskFor(text: string): Promise<string> {
  mocks.prepareExecution.mockClear();
  await POST(request(text));
  expect(mocks.prepareExecution).toHaveBeenCalledTimes(1);
  return mocks.prepareExecution.mock.calls[0][0].task as string;
}

/** The certified classes in which `execute_action` is mounted. */
const ACTION_CLASSES = AI_TOOL_REGISTRY_BY_NAME.get("execute_action")!.taskClasses as readonly string[];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(USER);
  mocks.rateLimit.mockResolvedValue({
    allowed: true,
    retryAfterSeconds: 0,
    backendAvailable: true,
  });
  mocks.finalizeExecution.mockResolvedValue(undefined);
  mocks.prepareExecution.mockResolvedValue({
    model: {},
    providerOptions: {},
    transport: "vercel_ai_gateway",
    requestId: "00000000-0000-4000-8000-000000000099",
    taskPolicy: { maxSteps: 8, temperature: 0.2, maxOutputTokens: 1500 },
    route: { alias: "staff-sonnet-bootstrap-v1" },
    legacyUsage: { used: 1, limit: 25, remaining: 24 },
    beginStep: vi.fn(),
    observeStep: vi.fn(),
    finalize: mocks.finalizeExecution,
  });
  mocks.ensureConversation.mockResolvedValue({
    id: conversationId,
    patientId: null,
    messages: [],
    activeContext: {},
  });
  mocks.persistTurn.mockResolvedValue(undefined);
  mocks.createAgent.mockResolvedValue({ stream: mocks.stream });
  mocks.stream.mockResolvedValue({
    toUIMessageStreamResponse: vi.fn(() => new Response("stream", { status: 200 })),
  });
});

// ---------------------------------------------------------------------------
// 10 — the reported multi-turn transcript (review §4.2)
// ---------------------------------------------------------------------------

describe("10 — the reported multi-turn booking transcript", () => {
  it("turn 3 (\"how do I book him for that slot?\") keeps the write surface", async () => {
    // Turns 1 and 2 resolved the patient and confirmed the slot; both are
    // persisted as server-derived active context.
    expect(await taskFor("Find patient Ahmed Ali.")).toBe("staff_administrative");
    expect(await taskFor("Is Dr. Sara free Sunday at 10:00?")).toBe("staff_administrative");

    mocks.ensureConversation.mockResolvedValue({
      id: conversationId,
      patientId: null,
      messages: [],
      activeContext: {
        patient: slot("patient", PATIENT),
        appointment: slot("appointment", APPOINTMENT),
      },
    });

    const task = await taskFor("How do I book him for that slot?");
    expect(task).not.toBe("staff_help");
    expect(ACTION_CLASSES).toContain(task);
  });

  it("does the same in Arabic", async () => {
    mocks.ensureConversation.mockResolvedValue({
      id: conversationId,
      patientId: null,
      messages: [],
      activeContext: { patient: slot("patient", PATIENT) },
    });
    const task = await taskFor("كيف أحجز له موعدًا؟");
    expect(task).not.toBe("staff_help");
    expect(ACTION_CLASSES).toContain(task);
  });

  it("still routes a genuine documentation question to staff_help mid-conversation", async () => {
    mocks.ensureConversation.mockResolvedValue({
      id: conversationId,
      patientId: null,
      messages: [],
      activeContext: { patient: slot("patient", PATIENT) },
    });
    expect(await taskFor("How do I book an appointment?")).toBe("staff_help");
  });
});

// ---------------------------------------------------------------------------
// 11 — class stability across a conversation
// ---------------------------------------------------------------------------

describe("11 — a phrasing change alone does not drop the write surface", () => {
  it("keeps an action-capable class across imperative and instructional phrasings", async () => {
    const imperative = await taskFor(
      "Book Ahmed Ali with Dr. Sara on Sunday at 10:00",
    );
    const instructional = await taskFor(
      "How do I book Ahmed Ali with Dr. Sara on Sunday at 10:00?",
    );
    expect(ACTION_CLASSES).toContain(imperative);
    expect(ACTION_CLASSES).toContain(instructional);
    expect(instructional).toBe(imperative);
  });

  it("keeps the write surface when a conversation that mounted data tools changes mood", async () => {
    expect(ACTION_CLASSES).toContain(await taskFor("Find patient Ahmed Ali."));
    mocks.ensureConversation.mockResolvedValue({
      id: conversationId,
      patientId: null,
      messages: [],
      activeContext: { patient: slot("patient", PATIENT) },
    });
    expect(ACTION_CLASSES).toContain(
      await taskFor("Where do I mark him as arrived today?"),
    );
  });
});
