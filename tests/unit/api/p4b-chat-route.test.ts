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
  reserveUsage: vi.fn(),
  releaseUsage: vi.fn(),
  rateLimit: vi.fn(),
  ensureConversation: vi.fn(),
  persistTurn: vi.fn(),
  stream: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));
vi.mock("next-intl/server", () => ({ getLocale: async () => "en" }));
vi.mock("@/lib/ai/authorization", () => ({
  authorizeStaffAssistant: mocks.authorize,
}));
vi.mock("@/lib/ai/usage", () => ({
  reserveAiTurn: mocks.reserveUsage,
  releaseAiTurn: mocks.releaseUsage,
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
  createStaffAgent: () => ({ stream: mocks.stream }),
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
const periodStart = "2026-07-01";

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
    patientId,
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
  mocks.reserveUsage.mockResolvedValue({
    used: 1,
    limit: 25,
    remaining: 24,
    periodStart,
  });
  mocks.releaseUsage.mockResolvedValue(undefined);
  mocks.rateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0, backendAvailable: true });
  mocks.ensureConversation.mockResolvedValue({ id: conversationId, patientId, messages: [] });
  mocks.persistTurn.mockResolvedValue(undefined);
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
    expect(mocks.reserveUsage).toHaveBeenCalledWith(USER.clinicId);
    expect(mocks.releaseUsage).toHaveBeenCalledWith(USER.clinicId, periodStart);
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("rate-limits by authorized clinic before usage or model work", async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 12, backendAvailable: true });
    const response = await POST(request(validBody()));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
    await expect(response.json()).resolves.toEqual({ error: "rate_limited" });
    expect(mocks.reserveUsage).not.toHaveBeenCalled();
  });

  it("reserves, streams, and persists one successful turn without releasing usage", async () => {
    const response = await POST(request(validBody()));
    expect(response.status).toBe(200);
    expect(mocks.ensureConversation).toHaveBeenCalledWith(expect.objectContaining({
      conversationId,
      patientId,
      user: USER,
    }));
    expect(mocks.stream).toHaveBeenCalledWith(expect.objectContaining({ messages: expect.any(Array) }));
    await vi.waitFor(() => {
      expect(mocks.persistTurn).toHaveBeenCalledWith(expect.objectContaining({
        conversationId,
        userText: "Summarize this patient",
        assistantText: "Sourced summary",
      }));
    });
    expect(mocks.reserveUsage).toHaveBeenCalledWith(USER.clinicId);
    expect(mocks.releaseUsage).not.toHaveBeenCalled();
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
      expect(mocks.releaseUsage).toHaveBeenCalledWith(USER.clinicId, periodStart);
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
      expect(mocks.releaseUsage).toHaveBeenCalledWith(USER.clinicId, periodStart);
    });
    expect(mocks.persistTurn).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalledWith(
      modelError,
      expect.objectContaining({ tags: { area: "staff-assistant-stream" } }),
    );
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
      expect(mocks.releaseUsage).toHaveBeenCalledWith(USER.clinicId, periodStart);
    });
    expect(mocks.persistTurn).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalledWith(
      toolError,
      expect.objectContaining({ tags: { area: "staff-assistant-stream" } }),
    );
  });

  it("returns the cap response when the atomic reservation loses a concurrent race", async () => {
    mocks.reserveUsage.mockRejectedValueOnce(
      new AiToolAuthorizationError("usage_limit_reached"),
    );

    const response = await POST(request(validBody()));
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: "usage_limit_reached" });
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(mocks.releaseUsage).not.toHaveBeenCalled();
  });
});
