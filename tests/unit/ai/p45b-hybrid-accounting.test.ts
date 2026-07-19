import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertAllowed: vi.fn(),
  reserve: vi.fn(),
  reconcile: vi.fn(),
  resolveCredential: vi.fn(),
  logFallback: vi.fn(),
  prepareTenant: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));
vi.mock("@/lib/ai/usage", () => ({ assertAiTurnAllowed: mocks.assertAllowed }));
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: vi.fn().mockResolvedValue({}),
  hasFeature: vi.fn().mockReturnValue(true),
  hasAiProviderMode: vi.fn().mockReturnValue(true),
}));
vi.mock("@/lib/ai/platform/provider-connections", () => ({
  resolveAiProviderCredential: mocks.resolveCredential,
}));
vi.mock("@/lib/ai/platform/tenant-provider", () => ({
  prepareTenantProvider: mocks.prepareTenant,
}));
vi.mock("@/lib/supabase/admin", () => ({
  reserveAiBudget: mocks.reserve,
  reconcileAiBudget: mocks.reconcile,
  logAiProviderFallback: mocks.logFallback,
}));

import { prepareAiExecution } from "@/lib/ai/platform/execution";

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

function step(finishReason: "stop" | "error") {
  return {
    stepNumber: 0,
    model: { provider: "anthropic", modelId: "anthropic/claude-sonnet-4.5" },
    response: { modelId: "anthropic/claude-sonnet-4.5" },
    finishReason,
    usage: {
      inputTokens: 10_000,
      outputTokens: 2_000,
      totalTokens: 12_000,
      inputTokenDetails: { noCacheTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 2_000, reasoningTokens: 0 },
      raw: undefined,
    },
  };
}

let capturedOnFallback: ((errorClass: string) => Promise<void>) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  capturedOnFallback = undefined;
  mocks.assertAllowed.mockResolvedValue({
    allowed: true, reason: "allowed", used: 0, limit: 10, remaining: 10,
  });
  mocks.resolveCredential.mockResolvedValue({
    mode: "hybrid", secret: "sk-ant-test", provider: "anthropic",
  });
  mocks.prepareTenant.mockImplementation((config: { onFallback: (errorClass: string) => Promise<void> }) => {
    capturedOnFallback = config.onFallback;
    return { model: {}, transport: "anthropic_direct_hybrid" };
  });
  mocks.logFallback.mockResolvedValue({ error: null });
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
});

describe("P4.5B hybrid managed-cost computation (L2 app/DB parity)", () => {
  it("counts only successful post-fallback attempts as managed, mirroring the DB trigger", async () => {
    const execution = await prepareAiExecution({
      user: USER,
      requestId: "00000000-0000-4000-8000-000000000010",
      task: "staff_clinical_summary",
      persona: "doctor",
      surface: "staff_assistant",
    });

    // Pre-fallback direct success (byok_provider_direct — excluded from managed).
    execution.observeStep(step("stop"));
    // Provider failure triggers the audited fallback to the managed route.
    expect(capturedOnFallback).toBeDefined();
    await capturedOnFallback!("provider_unavailable");
    expect(mocks.logFallback).toHaveBeenCalledOnce();
    // Post-fallback managed step that fails (nonbillable_failed — excluded).
    execution.observeStep(step("error"));
    // Post-fallback managed step that succeeds (managed_included — the only
    // attempt that should count toward the managed pool).
    execution.observeStep(step("stop"));

    await execution.finalize({ outcome: "success" });

    const reconciliation = mocks.reconcile.mock.calls[0][0];
    const attempts = reconciliation.attempts as {
      fallback_parent_attempt_id: string | null;
      status: string;
      final_cost_micros: number;
    }[];

    const expectedManaged = attempts
      .filter((a) => a.fallback_parent_attempt_id !== null && a.status === "success")
      .reduce((sum, a) => sum + a.final_cost_micros, 0);
    const expectedActual = attempts.reduce((sum, a) => sum + a.final_cost_micros, 0);

    // The failed post-fallback attempt must carry a real cost so the exclusion
    // is actually exercised (not vacuously true).
    const failedManaged = attempts.find(
      (a) => a.fallback_parent_attempt_id !== null && a.status === "failed",
    );
    expect(failedManaged?.final_cost_micros).toBeGreaterThan(0);

    expect(reconciliation.managedCostMicros).toBe(expectedManaged);
    expect(reconciliation.actualCostMicros).toBe(expectedActual);
    expect(reconciliation.managedCostMicros).toBeLessThan(reconciliation.actualCostMicros);
  });
});
