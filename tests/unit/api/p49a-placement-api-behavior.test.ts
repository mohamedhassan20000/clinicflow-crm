import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  clinicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "doctor@clinic.test",
  fullName: "Test Doctor",
  role: "doctor" as const,
  avatarUrl: null,
  departmentId: "22222222-2222-4222-8222-222222222222",
  mustChangePassword: false,
};

const state = vi.hoisted(() => ({ reservedTurns: 0 }));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("next-intl/server", () => ({ getLocale: async () => "en" }));
vi.mock("@/lib/ai/authorization", () => ({
  authorizeStaffAssistant: async () => USER,
  AI_STAFF_ANALYTICS_FEATURE: "ai.staff_analytics",
  AI_WORKFLOWS_FEATURE: "ai.workflows",
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({
    allowed: true,
    retryAfterSeconds: 0,
    backendAvailable: true,
  }),
}));
vi.mock("@/lib/ai/launchers", () => ({
  resolveAssistantLauncherSession: async () => null,
}));
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: async () => ({
    clinicId: USER.clinicId,
    planSlug: "pro_ai",
    features: { ai_assistant: true, "ai.staff_analytics": true },
    limits: {},
    subscriptionAllowed: true,
  }),
  hasFeature: (
    entitlements: { subscriptionAllowed: boolean; features: Record<string, boolean> },
    feature: string,
  ) => entitlements.subscriptionAllowed && entitlements.features[feature] === true,
}));
vi.mock("@/lib/ai/client", () => ({
  createAiRequestId: () => "33333333-3333-4333-8333-333333333333",
  staffTaskForRole: () => ({
    task: "staff_clinical_summary",
    persona: "doctor",
  }),
  prepareAiExecution: async () => {
    state.reservedTurns += 1;
    return {
      model: {},
      providerOptions: {},
      transport: "vercel_ai_gateway",
      requestId: "33333333-3333-4333-8333-333333333333",
      taskPolicy: { maxSteps: 8, temperature: 0.2, maxOutputTokens: 1_500 },
      route: { alias: "staff-sonnet-bootstrap-v1" },
      legacyUsage: { used: 1, limit: 20, remaining: 19 },
      beginStep: () => undefined,
      observeStep: () => undefined,
      finalize: async () => undefined,
    };
  },
}));
vi.mock("@/lib/ai/conversations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/conversations")>();
  return {
    ...actual,
    ensureDoctorConversation: async () => ({
      id: "44444444-4444-4444-8444-444444444444",
      patientId: null,
      messages: [],
    }),
    persistDoctorTurn: async () => undefined,
  };
});
vi.mock("@/lib/ai/staff-agent", () => ({
  createStaffAgent: async () => ({
    stream: async () => ({
      toUIMessageStreamResponse: () => new Response("stream", { status: 200 }),
    }),
  }),
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

import { POST as sendChat } from "@/app/api/agent/chat/route";
import { POST as hydrateLauncher } from "@/app/api/agent/launcher-session/route";

function post(path: string, body: unknown) {
  return new Request(`https://clinicflow.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.reservedTurns = 0;
});

describe("P49A-M2 — disabled launcher API behavior", () => {
  it("fails closed without reserving usage while the independent chat API remains usable and billable", async () => {
    const launcherResponse = await hydrateLauncher(
      post("/api/agent/launcher-session", {
        context: { type: "dashboard" },
      }),
    );

    expect(launcherResponse.status).toBe(503);
    await expect(launcherResponse.json()).resolves.toEqual({
      error: "temporarily_unavailable",
    });
    expect(state.reservedTurns).toBe(0);

    const chatResponse = await sendChat(
      post("/api/agent/chat", {
        id: "44444444-4444-4444-8444-444444444444",
        context: { type: "dashboard" },
        message: {
          id: "message-1",
          role: "user",
          parts: [{ type: "text", text: "What can I do today?" }],
        },
      }),
    );

    expect(chatResponse.status).toBe(200);
    expect(await chatResponse.text()).toBe("stream");
    expect(state.reservedTurns).toBe(1);
  });
});
