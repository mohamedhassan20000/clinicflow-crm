/**
 * P12 — ordered provider resolution, and the managed/BYOK accounting split.
 *
 * G1: an exhausted ClinicFlow allowance hands over to the clinic's own key
 *     automatically instead of requiring a human to change a setting.
 * G2: a BYOK turn is never refused because ClinicFlow's monetary allowance is
 *     spent, and never consumes it.
 * G3: the ai_messages request unit is ClinicFlow's FUNDED-request meter, so a
 *     BYOK turn does not claim one — while concurrency and the fair-use ceiling
 *     still apply to every mode.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiToolAuthorizationError } from "@/lib/ai/errors";

const mocks = vi.hoisted(() => ({
  assertAllowed: vi.fn(),
  reserve: vi.fn(),
  reconcile: vi.fn(),
  resolveCredential: vi.fn(),
  byokFallback: vi.fn(),
  notifyThresholds: vi.fn(),
  prepareManaged: vi.fn(),
  prepareTenant: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));
vi.mock("@/lib/ai/usage", () => ({ assertAiTurnAllowed: mocks.assertAllowed }));
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: vi.fn().mockResolvedValue({ limits: {} }),
  hasFeature: vi.fn().mockReturnValue(true),
  hasAiProviderMode: vi.fn().mockReturnValue(true),
}));
vi.mock("@/lib/ai/platform/provider-connections", () => ({
  resolveAiProviderCredential: mocks.resolveCredential,
  resolveByokFallbackCredential: mocks.byokFallback,
}));
vi.mock("@/lib/ai/usage-notifications", () => ({
  notifyAiUsageThresholds: mocks.notifyThresholds,
}));
vi.mock("@/lib/supabase/admin", () => ({
  reserveAiBudget: mocks.reserve,
  reconcileAiBudget: mocks.reconcile,
  logAiProviderFallback: vi.fn().mockResolvedValue({ error: null }),
}));
vi.mock("@/lib/ai/platform/managed-provider", () => ({
  resolveManagedProvider: () => ({ mode: "managed", prepare: mocks.prepareManaged }),
}));
vi.mock("@/lib/ai/platform/tenant-provider", () => ({
  prepareTenantProvider: mocks.prepareTenant,
}));

import { prepareAiExecution } from "@/lib/ai/platform/execution";

const USER = {
  id: "00000000-0000-4000-8000-000000000001",
  clinicId: "00000000-0000-4000-8000-000000000002",
};
const REQUEST_ID = "00000000-0000-4000-8000-000000000010";
const RESERVATION_ID = "00000000-0000-4000-8000-000000000011";
const BYOK_SECRET = "sk-ant-clinic-owned-secret";

function acquired() {
  return {
    data: [
      {
        reservation_id: RESERVATION_ID,
        returned_lease_token: "lease",
        acquired: true,
        reservation_status: "reserved",
        legacy_used: 1,
        legacy_limit: 1000,
        reserved_cost_micros: 2_430_000,
        budget_limit_micros: 1_620_000_000,
        expires_at: new Date().toISOString(),
      },
    ],
    error: null,
  };
}

function denial(code: string) {
  return { data: null, error: { message: `db error: ${code}` } };
}

async function execute() {
  return prepareAiExecution({
    user: USER,
    requestId: REQUEST_ID,
    task: "staff_clinical_summary",
    persona: "doctor",
    surface: "staff_assistant",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertAllowed.mockResolvedValue({
    allowed: true,
    reason: "allowed",
    used: 0,
    limit: 1000,
    remaining: 1000,
  });
  mocks.resolveCredential.mockResolvedValue({ mode: "managed" });
  mocks.byokFallback.mockResolvedValue(null);
  mocks.notifyThresholds.mockResolvedValue({ notified: [] });
  mocks.reserve.mockResolvedValue(acquired());
  mocks.reconcile.mockResolvedValue({ data: true, error: null });
  mocks.prepareManaged.mockReturnValue({
    model: { id: "managed" },
    providerOptions: {},
    transport: "anthropic_direct",
  });
  mocks.prepareTenant.mockReturnValue({
    model: { id: "tenant" },
    providerOptions: {},
    transport: "anthropic_direct",
  });
});

describe("allowance available", () => {
  it("runs a managed clinic on ClinicFlow's managed Anthropic key", async () => {
    const execution = await execute();
    expect(execution.credentialMode).toBe("managed");
    expect(execution.resolutionReason).toBe("policy");
    expect(execution.transport).toBe("anthropic_direct");
    expect(mocks.prepareManaged).toHaveBeenCalledOnce();
    expect(mocks.prepareTenant).not.toHaveBeenCalled();
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ credentialMode: "managed", transport: "anthropic_direct" }),
    );
    // A funded turn claims a funded request unit.
    expect(mocks.assertAllowed).toHaveBeenCalledOnce();
  });
});

describe("allowance exhausted", () => {
  it("continues automatically on the clinic's own key when one is healthy", async () => {
    mocks.reserve
      .mockResolvedValueOnce(denial("AI_BUDGET_EXCEEDED"))
      .mockResolvedValueOnce(acquired());
    mocks.byokFallback.mockResolvedValue({
      provider: "anthropic",
      connectionId: "connection-1",
      secret: BYOK_SECRET,
    });

    const execution = await execute();

    expect(execution.credentialMode).toBe("byok_strict");
    expect(execution.resolutionReason).toBe("auto_byok_fallback");
    expect(mocks.reserve).toHaveBeenCalledTimes(2);
    expect(mocks.reserve.mock.calls[1][0]).toMatchObject({ credentialMode: "byok_strict" });
    expect(mocks.prepareTenant).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "byok_strict", secret: BYOK_SECRET }),
    );
    expect(mocks.prepareManaged).not.toHaveBeenCalled();
    // The handover is not announced as an exhaustion denial — nothing stopped.
    expect(mocks.notifyThresholds).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "denied_exhausted" }),
    );
  });

  it("also hands over when the FUNDED request pool, not the money, ran out", async () => {
    mocks.assertAllowed.mockRejectedValueOnce(
      new AiToolAuthorizationError("usage_limit_reached"),
    );
    mocks.byokFallback.mockResolvedValue({
      provider: "anthropic",
      connectionId: "connection-1",
      secret: BYOK_SECRET,
    });

    const execution = await execute();

    expect(execution.credentialMode).toBe("byok_strict");
    // The failed managed attempt never reached the database.
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ credentialMode: "byok_strict" }),
    );
  });

  it("denies cleanly and notifies the admins when there is no clinic key", async () => {
    mocks.reserve.mockResolvedValue(denial("AI_BUDGET_EXCEEDED"));

    await expect(execute()).rejects.toMatchObject({ reason: "usage_limit_reached" });

    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.prepareTenant).not.toHaveBeenCalled();
    expect(mocks.prepareManaged).not.toHaveBeenCalled();
    expect(mocks.notifyThresholds).toHaveBeenCalledWith(
      expect.objectContaining({ clinicId: USER.clinicId, reason: "denied_exhausted" }),
    );
  });

  it("does not hand over when the clinic disabled the automatic fallback", async () => {
    // `resolveByokFallbackCredential` returns null for a disabled policy, so the
    // decision stays in one place rather than being re-derived here.
    mocks.reserve.mockResolvedValue(denial("AI_BUDGET_EXCEEDED"));
    mocks.byokFallback.mockResolvedValue(null);

    await expect(execute()).rejects.toMatchObject({ reason: "usage_limit_reached" });
    expect(mocks.reserve).toHaveBeenCalledOnce();
  });

  it("degrades a hybrid clinic to direct-only rather than denying it", async () => {
    mocks.resolveCredential.mockResolvedValue({
      mode: "hybrid",
      provider: "anthropic",
      connectionId: "connection-1",
      secret: BYOK_SECRET,
    });
    mocks.reserve
      .mockResolvedValueOnce(denial("AI_BUDGET_EXCEEDED"))
      .mockResolvedValueOnce(acquired());

    const execution = await execute();

    expect(execution.credentialMode).toBe("byok_strict");
    expect(execution.resolutionReason).toBe("hybrid_degraded_to_byok");
    // The managed fallback leg is what has no allowance left, so it is removed.
    expect(mocks.prepareTenant).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "byok_strict" }),
    );
  });
});

describe("denials that must NOT trigger a handover", () => {
  it("never retries a concurrency denial on another credential", async () => {
    mocks.reserve.mockResolvedValue(denial("AI_BUDGET_CONCURRENCY_EXCEEDED"));
    mocks.byokFallback.mockResolvedValue({
      provider: "anthropic",
      connectionId: "connection-1",
      secret: BYOK_SECRET,
    });

    await expect(execute()).rejects.toMatchObject({ reason: "usage_limit_reached" });

    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.byokFallback).not.toHaveBeenCalled();
    expect(mocks.notifyThresholds).not.toHaveBeenCalled();
  });

  it("never retries a fair-use denial on another credential", async () => {
    mocks.reserve.mockResolvedValue(denial("AI_FAIR_USE_LIMIT_EXCEEDED"));
    mocks.byokFallback.mockResolvedValue({
      provider: "anthropic",
      connectionId: "connection-1",
      secret: BYOK_SECRET,
    });

    await expect(execute()).rejects.toMatchObject({ reason: "usage_limit_reached" });
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.byokFallback).not.toHaveBeenCalled();
  });

  it("rethrows an inactive subscription instead of spending a clinic's own key", async () => {
    mocks.assertAllowed.mockRejectedValue(
      new AiToolAuthorizationError("subscription_inactive"),
    );
    await expect(execute()).rejects.toMatchObject({ reason: "subscription_inactive" });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.byokFallback).not.toHaveBeenCalled();
  });
});

describe("BYOK is not gated on the managed allowance (G2/G3)", () => {
  beforeEach(() => {
    mocks.resolveCredential.mockResolvedValue({
      mode: "byok_strict",
      provider: "anthropic",
      connectionId: "connection-1",
      secret: BYOK_SECRET,
    });
  });

  it("claims no ClinicFlow-funded request unit", async () => {
    await execute();
    expect(mocks.assertAllowed).not.toHaveBeenCalled();
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ credentialMode: "byok_strict" }),
    );
  });

  it("runs even when the clinic has no funded request pool left at all", async () => {
    mocks.assertAllowed.mockRejectedValue(
      new AiToolAuthorizationError("usage_limit_reached"),
    );
    const execution = await execute();
    expect(execution.credentialMode).toBe("byok_strict");
    expect(execution.resolutionReason).toBe("policy");
  });

  it("books zero managed spend at reconciliation, whatever it actually cost", async () => {
    const execution = await execute();
    execution.observeStep({
      stepNumber: 0,
      model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      response: { modelId: "claude-sonnet-4-5" },
      finishReason: "stop",
      usage: {
        inputTokens: 10_000,
        outputTokens: 1_000,
        totalTokens: 11_000,
        inputTokenDetails: {
          noCacheTokens: 10_000,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: { textTokens: 1_000, reasoningTokens: undefined },
        raw: undefined,
      },
    });
    await execution.finalize({ outcome: "success" });

    const [reconciliation] = mocks.reconcile.mock.calls[0];
    expect(reconciliation.actualCostMicros).toBeGreaterThan(0);
    expect(reconciliation.managedCostMicros).toBe(0);
  });

  it("does not raise a managed threshold notice for a BYOK turn", async () => {
    const execution = await execute();
    await execution.finalize({ outcome: "success" });
    expect(mocks.notifyThresholds).not.toHaveBeenCalled();
  });
});

describe("an automatic handover keeps the managed books clean", () => {
  it("books zero managed spend for the fallen-back turn", async () => {
    mocks.reserve
      .mockResolvedValueOnce(denial("AI_BUDGET_EXCEEDED"))
      .mockResolvedValueOnce(acquired());
    mocks.byokFallback.mockResolvedValue({
      provider: "anthropic",
      connectionId: "connection-1",
      secret: BYOK_SECRET,
    });

    const execution = await execute();
    execution.observeStep({
      stepNumber: 0,
      model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      response: { modelId: "claude-sonnet-4-5" },
      finishReason: "stop",
      usage: {
        inputTokens: 5_000,
        outputTokens: 500,
        totalTokens: 5_500,
        inputTokenDetails: {
          noCacheTokens: 5_000,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: { textTokens: 500, reasoningTokens: undefined },
        raw: undefined,
      },
    });
    await execution.finalize({ outcome: "success" });

    const [reconciliation] = mocks.reconcile.mock.calls[0];
    // The clinic's policy still says "managed"; the EFFECTIVE mode is what the
    // ledger must agree with, or the database rejects the reconciliation.
    expect(reconciliation.managedCostMicros).toBe(0);
    expect(reconciliation.actualCostMicros).toBeGreaterThan(0);
  });
});

describe("managed turns still report usage thresholds", () => {
  it("evaluates thresholds after the ledger is authoritative", async () => {
    const execution = await execute();
    await execution.finalize({ outcome: "success" });
    expect(mocks.reconcile).toHaveBeenCalled();
    expect(mocks.notifyThresholds).toHaveBeenCalledWith(
      expect.objectContaining({ clinicId: USER.clinicId, reason: "reconciled" }),
    );
  });
});
