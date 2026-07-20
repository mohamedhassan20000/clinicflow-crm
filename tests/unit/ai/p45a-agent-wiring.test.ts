import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  model: null as unknown as LanguageModel,
  assertAllowed: vi.fn(),
  reserve: vi.fn(),
  reconcile: vi.fn(),
  resolveCredential: vi.fn(),
  toolExecute: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/ai/usage", () => ({ assertAiTurnAllowed: mocks.assertAllowed }));
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: vi.fn().mockResolvedValue({}),
  hasFeature: vi.fn().mockReturnValue(true),
  hasAiProviderMode: vi.fn().mockReturnValue(true),
}));
vi.mock("@/lib/ai/platform/provider-connections", () => ({
  resolveAiProviderCredential: mocks.resolveCredential,
}));
vi.mock("@/lib/supabase/admin", () => ({
  reserveAiBudget: mocks.reserve,
  reconcileAiBudget: mocks.reconcile,
  logAiProviderFallback: vi.fn(),
}));
vi.mock("@/lib/ai/platform/managed-gateway", () => ({
  managedGatewayProvider: {
    mode: "managed",
    prepare: () => ({
      model: mocks.model,
      providerOptions: {},
      transport: "vercel_ai_gateway",
    }),
  },
}));
vi.mock("@/lib/ai/tools", async () => {
  const [{ tool }, { z }] = await Promise.all([
    vi.importActual<typeof import("ai")>("ai"),
    vi.importActual<typeof import("zod")>("zod"),
  ]);
  return {
    buildStaffTools: async () => ({
      lookup: tool({
        description: "Return a deterministic test result.",
        inputSchema: z.object({ query: z.string() }),
        execute: mocks.toolExecute,
      }),
    }),
  };
});

import { prepareAiExecution } from "@/lib/ai/platform/execution";
import { createStaffAgent } from "@/lib/ai/staff-agent";

const USER = {
  id: "00000000-0000-4000-8000-000000000001",
  clinicId: "00000000-0000-4000-8000-000000000002",
  email: "doctor@example.com",
  fullName: "Test Doctor",
  role: "doctor" as const,
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
};

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: undefined,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  let call = 0;
  mocks.model = new MockLanguageModelV3({
    provider: "anthropic",
    modelId: "anthropic/claude-sonnet-4.5",
    doGenerate: async () => {
      call += 1;
      return call === 1
        ? {
            content: [{
              type: "tool-call" as const,
              toolCallId: "call-1",
              toolName: "lookup",
              input: JSON.stringify({ query: "today" }),
            }],
            finishReason: { unified: "tool-calls" as const, raw: undefined },
            usage: usage(10, 1),
            response: { modelId: "anthropic/claude-sonnet-4.5" },
            warnings: [],
          }
        : {
            content: [{ type: "text" as const, text: "Done" }],
            finishReason: { unified: "stop" as const, raw: undefined },
            usage: usage(20, 5),
            response: { modelId: "anthropic/claude-sonnet-4.5" },
            warnings: [],
          };
    },
  });
  mocks.assertAllowed.mockResolvedValue({
    allowed: true,
    reason: "allowed",
    used: 0,
    limit: 10,
    remaining: 10,
  });
  mocks.resolveCredential.mockResolvedValue({ mode: "managed" });
  mocks.reserve.mockResolvedValue({
    data: [{
      reservation_id: "00000000-0000-4000-8000-000000000011",
      returned_lease_token: "00000000-0000-4000-8000-000000000012",
      acquired: true,
      reservation_status: "reserved",
      legacy_used: 1,
      legacy_limit: 10,
      reserved_cost_micros: 1_620_000,
      budget_limit_micros: 16_200_000,
      expires_at: "2026-07-19T00:10:00Z",
    }],
    error: null,
  });
  mocks.reconcile.mockResolvedValue({ data: true, error: null });
  mocks.toolExecute.mockResolvedValue({ result: "available" });
});

describe("P4.5A real ToolLoopAgent accounting wiring", () => {
  it("maps every SDK step into an ordered content-free reconciliation", async () => {
    const execution = await prepareAiExecution({
      user: USER,
      requestId: "00000000-0000-4000-8000-000000000010",
      task: "staff_clinical_summary",
      persona: "doctor",
      surface: "staff_assistant",
    });
    const agent = await createStaffAgent({
      user: USER,
      locale: "en",
      clinicName: "Test Clinic",
      execution,
    });

    const result = await agent.generate({ prompt: "Check availability" });
    expect(result.text).toBe("Done");
    expect(mocks.toolExecute).toHaveBeenCalledWith(
      { query: "today" },
      expect.any(Object),
    );

    await execution.finalize({ outcome: "success" });
    const reconciliation = mocks.reconcile.mock.calls[0][0];
    expect(reconciliation.actualCostMicros).toBe(180);
    expect(reconciliation.attempts).toEqual([
      expect.objectContaining({
        attempt_sequence: 0,
        input_tokens: 10,
        output_tokens: 1,
        final_cost_micros: 45,
      }),
      expect.objectContaining({
        attempt_sequence: 1,
        input_tokens: 20,
        output_tokens: 5,
        final_cost_micros: 135,
      }),
    ]);
    expect(JSON.stringify(reconciliation.attempts)).not.toMatch(
      /prompt|completion|message|patient|tool|body/i,
    );
  });
});
