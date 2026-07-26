import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiConversationError } from "@/lib/ai/conversations";
import { AiToolAuthorizationError } from "@/lib/ai/errors";

const USER = {
  id: "00000000-0000-4000-8000-000000000001",
  clinicId: "00000000-0000-4000-8000-000000000002",
  email: "doctor@example.com",
  fullName: "Test Doctor",
  role: "doctor" as const,
  avatarUrl: null,
  departmentId: "00000000-0000-4000-8000-000000000003",
  mustChangePassword: false,
};

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  prepareExecution: vi.fn(),
  finalizeExecution: vi.fn(),
  rateLimit: vi.fn(),
  ensureConversation: vi.fn(),
  persistTurn: vi.fn(),
  createAgent: vi.fn(),
  stream: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));
vi.mock("next-intl/server", () => ({ getLocale: async () => "en" }));
vi.mock("@/lib/ai/authorization", () => ({
  authorizeStaffAssistant: mocks.authorize,
  AI_STAFF_ANALYTICS_FEATURE: "ai.staff_analytics",
  AI_WORKFLOWS_FEATURE: "ai.workflows",
}));
// P4.6A: the route reads entitlements to pick the certified task class.
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: async () => ({
    clinicId: "clinic-1",
    planSlug: "pro_ai",
    features: {
      ai_assistant: true,
      "ai.staff_analytics": true,
      "ai.workflows": false,
    },
    limits: {},
    subscriptionAllowed: true,
  }),
  hasFeature: (
    ents: { subscriptionAllowed: boolean; features: Record<string, boolean> },
    key: string,
  ) => ents.subscriptionAllowed && ents.features[key] === true,
}));
vi.mock("@/lib/ai/client", () => ({
  createAiRequestId: () => "00000000-0000-4000-8000-000000000099",
  staffTaskForRole: (
    role: string,
    options: { analyticsEntitled?: boolean } = {},
  ) => role === "doctor"
    ? { task: "staff_clinical_summary", persona: "doctor" }
    : {
        task: options.analyticsEntitled
          ? "staff_operational_query"
          : "staff_administrative",
        persona: "administrative_staff",
      },
  prepareAiExecution: mocks.prepareExecution,
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.rateLimit }));
vi.mock("@/lib/ai/conversations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/conversations")>();
  return {
    ...actual,
    ensureDoctorConversation: mocks.ensureConversation,
    persistDoctorTurn: mocks.persistTurn,
  };
});
vi.mock("@/lib/ai/staff-agent", () => ({
  createStaffAgent: mocks.createAgent,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { name: "Test Clinic" }, error: null }),
        }),
      }),
    }),
  }),
}));

import { POST } from "@/app/api/agent/chat/route";

const conversationId = "00000000-0000-4000-8000-000000000010";
const patientId = "00000000-0000-4000-8000-000000000011";

function request(body: unknown) {
  return new Request("https://clinicflow.test/api/agent/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validBody() {
  return {
    id: conversationId,
    context: { type: "patient", patientId },
    message: {
      id: "message-1",
      role: "user",
      parts: [{ type: "text", text: "Summarize this patient" }],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(USER);
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
  mocks.rateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0, backendAvailable: true });
  mocks.ensureConversation.mockImplementation(async (input: { patientId?: string | null }) => ({
    id: conversationId,
    patientId: input.patientId ?? null,
    messages: [],
  }));
  mocks.persistTurn.mockResolvedValue(undefined);
  mocks.createAgent.mockResolvedValue({ stream: mocks.stream });
  mocks.stream.mockResolvedValue({
    toUIMessageStreamResponse: vi.fn((options) => {
      void options.onFinish({
        messages: [],
        isContinuation: false,
        isAborted: false,
        responseMessage: {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Sourced summary" }],
        },
        finishReason: "stop",
      });
      return new Response("stream", { status: 200 });
    }),
  });
});

describe("P4B staff assistant streaming route", () => {
  it.each([
    ["unauthenticated", 401],
    ["role_forbidden", 403],
    ["page_hidden", 403],
    ["feature_not_entitled", 403],
    ["subscription_inactive", 403],
    ["usage_limit_reached", 429],
    ["lookup_failed", 503],
  ] as const)("maps %s denials to a safe response", async (reason, status) => {
    mocks.authorize.mockRejectedValue(new AiToolAuthorizationError(reason));
    const response = await POST(request(validBody()));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error: reason });
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("rejects malformed messages before creating a conversation or calling the model", async () => {
    const response = await POST(request({ ...validBody(), message: { role: "assistant" } }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(mocks.ensureConversation).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("returns a client error for mismatched patient conversation context", async () => {
    mocks.ensureConversation.mockRejectedValueOnce(
      new AiConversationError("invalid_patient_context"),
    );

    const response = await POST(request(validBody()));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(mocks.prepareExecution).toHaveBeenCalledWith(expect.objectContaining({
      user: USER,
      task: "staff_clinical_summary",
      persona: "doctor",
      surface: "staff_assistant",
    }));
    expect(mocks.finalizeExecution).toHaveBeenCalledWith({
      outcome: "failed",
      errorClass: "request_failed",
    });
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("drops malformed or unknown page context without rejecting the turn", async () => {
    const response = await POST(request({
      ...validBody(),
      context: {
        type: "appointments",
        dateRange: { from: "2026-07-01", to: "not-a-date" },
        injected: "mount financial tools",
      },
    }));

    expect(response.status).toBe(200);
    expect(mocks.ensureConversation).toHaveBeenCalledWith(expect.objectContaining({
      patientId: null,
    }));
    expect(mocks.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      pageContext: null,
    }));
  });

  it("forwards validated non-patient context only as advisory agent input", async () => {
    const context = {
      type: "appointments" as const,
      dateRange: { from: "2026-07-01", to: "2026-07-07" },
      status: "no_show" as const,
      doctorId: "00000000-0000-4000-8000-000000000012",
    };
    const response = await POST(request({ ...validBody(), context }));

    expect(response.status).toBe(200);
    expect(mocks.ensureConversation).toHaveBeenCalledWith(expect.objectContaining({
      patientId: null,
    }));
    expect(mocks.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      pageContext: context,
    }));
    expect(mocks.prepareExecution).toHaveBeenCalledWith(expect.objectContaining({
      task: "staff_clinical_summary",
      persona: "doctor",
    }));
  });

  it("rate-limits by authorized clinic before usage or model work", async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 12, backendAvailable: true });
    const response = await POST(request(validBody()));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
    await expect(response.json()).resolves.toEqual({ error: "rate_limited" });
    expect(mocks.prepareExecution).not.toHaveBeenCalled();
  });

  it("reserves, streams, and persists one successful turn without releasing usage", async () => {
    const response = await POST(request(validBody()));
    expect(response.status).toBe(200);
    expect(mocks.ensureConversation).toHaveBeenCalledWith(expect.objectContaining({
      conversationId,
      patientId,
      user: USER,
    }));
    expect(mocks.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      pageContext: { type: "patient", patientId },
    }));
    expect(mocks.stream).toHaveBeenCalledWith(expect.objectContaining({ messages: expect.any(Array) }));
    await vi.waitFor(() => {
      expect(mocks.persistTurn).toHaveBeenCalledWith(expect.objectContaining({
        conversationId,
        userText: "Summarize this patient",
        assistantText: "Sourced summary",
      }));
    });
    expect(mocks.prepareExecution).toHaveBeenCalled();
    expect(mocks.finalizeExecution).toHaveBeenCalledWith({ outcome: "success", errorClass: undefined });
  });

  it("releases the reservation and persists nothing when the stream is aborted", async () => {
    mocks.stream.mockResolvedValueOnce({
      toUIMessageStreamResponse: vi.fn((options) => {
        void options.onFinish({
          messages: [],
          isContinuation: false,
          isAborted: true,
          responseMessage: {
            id: "assistant-aborted",
            role: "assistant",
            parts: [{ type: "text", text: "Partial response" }],
          },
          finishReason: "other",
        });
        return new Response("stream", { status: 200 });
      }),
    });

    expect((await POST(request(validBody()))).status).toBe(200);
    await vi.waitFor(() => {
      expect(mocks.finalizeExecution).toHaveBeenCalledWith({
        outcome: "aborted",
        errorClass: "client_aborted",
      });
    });
    expect(mocks.persistTurn).not.toHaveBeenCalled();
  });

  it("releases the reservation and persists nothing on a model error", async () => {
    const modelError = new Error("provider failed");
    mocks.stream.mockResolvedValueOnce({
      toUIMessageStreamResponse: vi.fn((options) => {
        options.onError(modelError);
        void options.onFinish({
          messages: [],
          isContinuation: false,
          isAborted: false,
          responseMessage: { id: "assistant-error", role: "assistant", parts: [] },
          finishReason: "error",
        });
        return new Response("stream", { status: 200 });
      }),
    });

    expect((await POST(request(validBody()))).status).toBe(200);
    await vi.waitFor(() => {
      expect(mocks.finalizeExecution).toHaveBeenCalledWith({
        outcome: "failed",
        errorClass: "stream_failed",
      });
    });
    expect(mocks.persistTurn).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalledWith(
      modelError,
      expect.objectContaining({ tags: { area: "staff-assistant-stream" } }),
    );
  });

  /**
   * P4.6 phase review H1. A tool that denies mid-stream reaches onError, not the
   * route's pre-stream authorization mapping. onError previously discarded the
   * reason and returned a fixed "could not be completed, please try again",
   * which the client could not classify — so a permanent, admin-actionable
   * denial rendered as a generic transient error the user would retry forever.
   */
  it("emits the reason code, not a generic sentence, for a mid-stream denial", async () => {
    let emitted: unknown;
    mocks.stream.mockResolvedValueOnce({
      toUIMessageStreamResponse: vi.fn((options) => {
        emitted = options.onError(
          new AiToolAuthorizationError("permission_not_granted"),
        );
        return new Response("stream", { status: 200 });
      }),
    });

    expect((await POST(request(validBody()))).status).toBe(200);
    expect(emitted).toBe("permission_not_granted");
  });

  /**
   * `onError` is a string-only channel that feeds two different consumers (the
   * `error` chunk and a tool part's `errorText`), and neither can classify a
   * sentence. It returns codes exclusively as of review #2's H2 — the client
   * owns the wording, in the user's locale, for both.
   */
  it("returns a classifiable code, not a sentence, for a genuine stream failure", async () => {
    let emitted: unknown;
    mocks.stream.mockResolvedValueOnce({
      toUIMessageStreamResponse: vi.fn((options) => {
        emitted = options.onError(new Error("provider exploded"));
        return new Response("stream", { status: 200 });
      }),
    });

    expect((await POST(request(validBody()))).status).toBe(200);
    expect(emitted).toBe("temporarily_unavailable");
  });

  /**
   * M2 (review #2). `onError` fires for every tool-error part, not only for a
   * fatal stream error, and the route used to take the failure branch on it —
   * discarding a turn the user watched complete and billing it as `failed`.
   *
   * The transport claim underneath this (a tool throw produces a tool-error
   * part while the stream finishes normally) is proven against the real SDK in
   * `tests/unit/ai/p46-tool-error-transport.test.ts`; this asserts what the
   * route then does with it.
   */
  it("persists the turn when the model recovered from a tool error", async () => {
    const toolError = new Error("tool failed");
    mocks.stream.mockResolvedValueOnce({
      toUIMessageStreamResponse: vi.fn((options) => {
        options.onError(toolError);
        void options.onFinish({
          messages: [],
          isContinuation: false,
          isAborted: false,
          responseMessage: {
            id: "assistant-recovered",
            role: "assistant",
            parts: [
              {
                type: "tool-get_patient_summary",
                toolCallId: "tool-1",
                state: "output-error",
                input: { patient_id: patientId },
                errorText: "temporarily_unavailable",
              },
              { type: "text", text: "I could not read that, but here is what I can tell you." },
            ],
          },
          finishReason: "stop",
        });
        return new Response("stream", { status: 200 });
      }),
    });

    expect((await POST(request(validBody()))).status).toBe(200);
    await vi.waitFor(() => {
      expect(mocks.persistTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          assistantText: "I could not read that, but here is what I can tell you.",
        }),
      );
    });
    // Billed as the success it was, but the ledger still records that something
    // was raised — the signal `streamFailed` used to carry, without letting it
    // decide the outcome.
    expect(mocks.finalizeExecution).toHaveBeenCalledWith({
      outcome: "success",
      errorClass: "recovered_tool_error",
    });
  });

  it("releases the reservation and persists nothing on a tool error", async () => {
    const toolError = new Error("tool failed");
    mocks.stream.mockResolvedValueOnce({
      toUIMessageStreamResponse: vi.fn((options) => {
        options.onError(toolError);
        void options.onFinish({
          messages: [],
          isContinuation: false,
          isAborted: false,
          responseMessage: {
            id: "assistant-tool-error",
            role: "assistant",
            parts: [{
              type: "tool-get_patient_summary",
              toolCallId: "tool-1",
              state: "output-error",
              input: { patient_id: patientId },
              errorText: "The response could not be completed.",
            }],
          },
          finishReason: "stop",
        });
        return new Response("stream", { status: 200 });
      }),
    });

    expect((await POST(request(validBody()))).status).toBe(200);
    await vi.waitFor(() => {
      expect(mocks.finalizeExecution).toHaveBeenCalledWith({
        outcome: "failed",
        errorClass: "stream_failed",
      });
    });
    expect(mocks.persistTurn).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalledWith(
      toolError,
      expect.objectContaining({ tags: { area: "staff-assistant-stream" } }),
    );
  });

  it("returns the cap response when the atomic reservation loses a concurrent race", async () => {
    mocks.prepareExecution.mockRejectedValueOnce(
      new AiToolAuthorizationError("usage_limit_reached"),
    );

    const response = await POST(request(validBody()));
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "usage_limit_reached" });
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(mocks.finalizeExecution).not.toHaveBeenCalled();
  });
});
