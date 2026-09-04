import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiToolAuthorizationError } from "@/lib/ai/errors";

const mocks = vi.hoisted(() => ({
  gateway: vi.fn((modelId: string) => ({ modelId, provider: "gateway" })),
  anthropicModel: vi.fn((modelId: string) => ({ modelId, provider: "anthropic" })),
  createAnthropic: vi.fn(),
  notifyThresholds: vi.fn(),
  byokFallback: vi.fn(),
  assertAllowed: vi.fn(),
  reserve: vi.fn(),
  reconcile: vi.fn(),
  resolveCredential: vi.fn(),
  captureException: vi.fn(),
  hasFeature: vi.fn(),
  getEntitlements: vi.fn(),
}));

vi.mock("ai", () => ({
  gateway: mocks.gateway,
  // The direct transport wraps its model in the platform resilience middleware.
  // Identity here: this suite asserts accounting, not concurrency behaviour.
  wrapLanguageModel: vi.fn(({ model }: { model: unknown }) => model),
  APICallError: { isInstance: () => false },
}));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: mocks.createAnthropic }));
vi.mock("@/lib/ai/usage-notifications", () => ({
  notifyAiUsageThresholds: mocks.notifyThresholds,
}));
vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));
vi.mock("@/lib/ai/usage", () => ({ assertAiTurnAllowed: mocks.assertAllowed }));
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: mocks.getEntitlements,
  hasFeature: mocks.hasFeature,
  hasAiProviderMode: vi.fn().mockReturnValue(true),
}));
vi.mock("@/lib/ai/platform/provider-connections", () => ({
  resolveAiProviderCredential: mocks.resolveCredential,
  resolveByokFallbackCredential: mocks.byokFallback,
}));
vi.mock("@/lib/supabase/admin", () => ({
  reserveAiBudget: mocks.reserve,
  reconcileAiBudget: mocks.reconcile,
  logAiProviderFallback: vi.fn(),
}));

import {
  calculateUsageCostMicros,
  calculateWorstCaseCostMicros,
} from "@/lib/ai/platform/cost";
import { managedGatewayProvider } from "@/lib/ai/platform/managed-gateway";
import { MANAGED_ANTHROPIC_KEY_ENV } from "@/lib/ai/platform/managed-anthropic";
import {
  AiPolicyRegistryError,
  getCertifiedModelRoute,
  getTaskPolicy,
  listCertifiedModelRoutes,
} from "@/lib/ai/platform/registry";
import {
  assertAiInputWithinPolicy,
  createAiRequestId,
  prepareAiExecution,
  staffTaskForRole,
} from "@/lib/ai/platform/execution";

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
const REQUEST_ID = "00000000-0000-4000-8000-000000000010";
const RESERVATION_ID = "00000000-0000-4000-8000-000000000011";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AI_MODEL_DOCTOR;
  delete process.env.AI_MODEL_PATIENT;
  delete process.env.AI_TRACKING_HMAC_KEY;
  delete process.env.AI_MANAGED_TRANSPORT;
  process.env[MANAGED_ANTHROPIC_KEY_ENV] = "sk-ant-managed-test-key";
  mocks.createAnthropic.mockImplementation(() => mocks.anthropicModel);
  mocks.notifyThresholds.mockResolvedValue({ notified: [] });
  mocks.byokFallback.mockResolvedValue(null);
  mocks.assertAllowed.mockResolvedValue({
    allowed: true,
    reason: "allowed",
    used: 0,
    limit: 10,
    remaining: 10,
  });
  mocks.resolveCredential.mockResolvedValue({ mode: "managed" });
  mocks.getEntitlements.mockResolvedValue({ limits: {} });
  mocks.hasFeature.mockReturnValue(true);
  mocks.reserve.mockResolvedValue({
    data: [{
      reservation_id: RESERVATION_ID,
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

describe("P4.5A certified policy registry", () => {
  it("allows only the role-appropriate task/persona combinations", () => {
    expect(getTaskPolicy("staff_clinical_summary", "doctor").primaryModelAlias)
      .toBe("staff-sonnet-bootstrap-v1");
    expect(getTaskPolicy("staff_administrative", "administrative_staff").maxSteps).toBe(20);
    expect(() => getTaskPolicy("staff_clinical_summary", "administrative_staff"))
      .toThrow(new AiPolicyRegistryError("task_not_allowed"));
    expect(staffTaskForRole("receptionist")).toEqual({
      task: "staff_administrative",
      persona: "administrative_staff",
    });
  });

  it("contains only certified DIRECT Anthropic routes with explicit privacy posture", () => {
    // Three since P4.7A added the cheap `staff-haiku-bootstrap-v1` help route.
    expect(listCertifiedModelRoutes()).toHaveLength(3);
    for (const route of listCertifiedModelRoutes()) {
      // P12: the certified managed transport is a direct Anthropic call.
      expect(route.transport).toBe("anthropic_direct");
      // The ZDR flag is scoped to the gateway transport by name, and the direct
      // transport's retention posture is recorded as contractual rather than
      // claimed as an enforced per-request control.
      expect(route.privacy).toEqual({
        gatewayZeroDataRetention: true,
        directProviderRetention: "contractual_only",
        noTrainingRequired: true,
      });
      // A native Anthropic model id is required for the direct call, and the
      // gateway-qualified id must stay separate rather than being reused.
      expect(route.providerModelId).not.toContain("/");
      expect(route.modelId).toContain("/");
      // P4.7A's help route carries its own bootstrap version (`p47a-…`); all
      // remain bootstrap-approved, which is what this assertion guards.
      expect(route.certification.status).toBe("bootstrap_approved");
      expect(route.certification.version).toMatch(/^p4/);
    }
  });

  it("fails closed for an arbitrary model override", () => {
    process.env.AI_MODEL_DOCTOR = "provider/unreviewed-model";
    expect(() => getCertifiedModelRoute(getTaskPolicy("staff_clinical_summary", "doctor")))
      .toThrow(new AiPolicyRegistryError("model_not_certified"));
  });
});

describe("P4.5A managed Gateway provider", () => {
  it("enforces serving provider and zero-retention without exposing raw tenant identity", () => {
    const route = getCertifiedModelRoute(getTaskPolicy("staff_clinical_summary", "doctor"));
    const prepared = managedGatewayProvider.prepare({
      route,
      task: "staff_clinical_summary",
      surface: "staff_assistant",
      clinicId: USER.clinicId,
      actorId: USER.id,
      policyVersion: "p45a-staff-policy-v1",
    });
    expect(mocks.gateway).toHaveBeenCalledWith("anthropic/claude-sonnet-4.5");
    expect(prepared.providerOptions.gateway).toMatchObject({
      only: ["anthropic"],
      zeroDataRetention: true,
    });
    const serialized = JSON.stringify(prepared.providerOptions);
    expect(serialized).not.toContain(USER.clinicId);
    expect(serialized).not.toContain(USER.id);
    expect(prepared.providerOptions.gateway).not.toHaveProperty("user");
  });

  it("uses a one-way pseudonym when tracking is explicitly configured", () => {
    process.env.AI_TRACKING_HMAC_KEY = "test-key-with-sufficient-entropy";
    const route = getCertifiedModelRoute(getTaskPolicy("staff_clinical_summary", "doctor"));
    const prepared = managedGatewayProvider.prepare({
      route,
      task: "staff_clinical_summary",
      surface: "staff_assistant",
      clinicId: USER.clinicId,
      actorId: USER.id,
      policyVersion: "p45a-staff-policy-v1",
    });
    const user = prepared.providerOptions.gateway.user;
    expect(user).toMatch(/^[a-f0-9]{32}$/);
    expect(user).not.toBe(USER.id);
  });
});

describe("P4.5A cost and atomic execution accounting", () => {
  it("accounts P5A patient turns on the shared ledger without requiring the staff entitlement", async () => {
    mocks.hasFeature.mockImplementation(
      (_entitlements: unknown, feature: string) =>
        feature !== "ai.staff_assistant",
    );
    const patientActor = {
      id: "00000000-0000-4000-8000-000000000030",
      clinicId: USER.clinicId,
    };
    await prepareAiExecution({
      user: patientActor,
      requestId: REQUEST_ID,
      task: "patient_booking",
      persona: "patient",
      surface: "patient_messaging",
    });
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId: USER.clinicId,
        actorId: patientActor.id,
        surface: "patient_messaging",
        persona: "patient",
        task: "patient_booking",
      }),
    );
  });

  it("denies patient booking before spend when patient suggest or scheduling is disabled", async () => {
    for (const disabled of ["ai.patient_suggest", "ai.scheduling"]) {
      vi.clearAllMocks();
      mocks.hasFeature.mockImplementation(
        (_entitlements: unknown, feature: string) => feature !== disabled,
      );
      await expect(
        prepareAiExecution({
          user: {
            id: "00000000-0000-4000-8000-000000000030",
            clinicId: USER.clinicId,
          },
          requestId: REQUEST_ID,
          task: "patient_booking",
          persona: "patient",
          surface: "patient_messaging",
        }),
      ).rejects.toMatchObject({ reason: "feature_not_entitled" });
      expect(mocks.reserve).not.toHaveBeenCalled();
    }
  });

  it("rejects a patient task on the staff surface and a staff task on the patient surface", async () => {
    await expect(
      prepareAiExecution({
        user: USER,
        requestId: REQUEST_ID,
        task: "patient_faq",
        persona: "patient",
        surface: "staff_assistant",
      }),
    ).rejects.toMatchObject({ reason: "feature_not_entitled" });
    await expect(
      prepareAiExecution({
        user: USER,
        requestId: REQUEST_ID,
        task: "staff_administrative",
        persona: "administrative_staff",
        surface: "patient_messaging",
      }),
    ).rejects.toMatchObject({ reason: "feature_not_entitled" });
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("uses cache-aware actual cost and cache-free worst-case reservations", () => {
    const policy = getTaskPolicy("staff_clinical_summary", "doctor");
    const route = getCertifiedModelRoute(policy);
    expect(calculateUsageCostMicros(route.pricing, {
      inputTokens: 1_000,
      outputTokens: 100,
      totalTokens: 1_100,
      inputTokenDetails: {
        noCacheTokens: 700,
        cacheReadTokens: 200,
        cacheWriteTokens: 100,
      },
      outputTokenDetails: { textTokens: 90, reasoningTokens: 10 },
      raw: undefined,
    })).toBe(4_035);
    // maxSteps × (maxInputTokensPerStep × input price + maxOutputTokens × output
    // price). Raising `staff_clinical_summary.maxSteps` from 8 to 12 raises the
    // *reservation* by the same factor; actual spend is unchanged, because the
    // reservation is reconciled against real usage when the turn finalizes.
    expect(calculateWorstCaseCostMicros(policy, route)).toBe(2_430_000);
  });

  it("derives an idempotent content-free request id", () => {
    const input = {
      clinicId: USER.clinicId,
      actorId: USER.id,
      conversationId: "00000000-0000-4000-8000-000000000020",
      messageId: "client-message-7",
    };
    expect(createAiRequestId(input)).toBe(createAiRequestId(input));
    expect(createAiRequestId(input)).toMatch(/^[0-9a-f-]{36}$/);
    expect(createAiRequestId({ ...input, messageId: "client-message-8" }))
      .not.toBe(createAiRequestId(input));
  });

  it("requires a fresh message id for a new logical send", () => {
    const base = {
      clinicId: USER.clinicId,
      actorId: USER.id,
      conversationId: "00000000-0000-4000-8000-000000000020",
    };
    const transportRetry = createAiRequestId({ ...base, messageId: "message-1" });
    expect(createAiRequestId({ ...base, messageId: "message-1" })).toBe(transportRetry);
    expect(createAiRequestId({ ...base, messageId: "message-2" })).not.toBe(transportRetry);
  });

  it("blocks oversized step input before provider spend", () => {
    expect(() => assertAiInputWithinPolicy([{ text: "safe" }], 100)).not.toThrow();
    expect(() => assertAiInputWithinPolicy([{ text: "x".repeat(101) }], 100))
      .toThrow(expect.objectContaining({ name: "AiPolicyInputLimitError" }));
  });

  it("clamps the effective loop and reservation to ai_turn_steps_max", async () => {
    mocks.getEntitlements.mockResolvedValueOnce({
      limits: { ai_turn_steps_max: 7 },
    });
    const execution = await prepareAiExecution({
      user: USER,
      requestId: REQUEST_ID,
      task: "staff_composite",
      persona: "doctor",
      surface: "staff_assistant",
    });
    expect(execution.taskPolicy.maxSteps).toBe(7);
    const certified = getTaskPolicy("staff_composite", "doctor");
    const route = getCertifiedModelRoute(certified);
    expect(mocks.reserve).toHaveBeenCalledWith(expect.objectContaining({
      reservedCostMicros: calculateWorstCaseCostMicros(
        { ...certified, maxSteps: 7 },
        route,
      ),
    }));
  });

  it("meters and reconciles every observed step in a 12-step turn", async () => {
    const execution = await prepareAiExecution({
      user: USER,
      requestId: REQUEST_ID,
      task: "staff_administrative",
      persona: "administrative_staff",
      surface: "staff_assistant",
    });
    for (let stepNumber = 0; stepNumber < 12; stepNumber += 1) {
      execution.beginStep();
      execution.observeStep({
        stepNumber,
        model: { provider: "anthropic", modelId: "anthropic/claude-sonnet-4.5" },
        response: { modelId: "anthropic/claude-sonnet-4.5" },
        finishReason: stepNumber === 11 ? "stop" : "tool-calls",
        usage: {
          inputTokens: 1_000,
          outputTokens: 20,
          totalTokens: 1_020,
          inputTokenDetails: { noCacheTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokenDetails: { textTokens: 20, reasoningTokens: 0 },
          raw: undefined,
        },
      });
    }
    await execution.finalize({ outcome: "success" });
    expect(mocks.reconcile.mock.calls[0][0].attempts).toHaveLength(12);
  });

  it("reserves before provider construction and reconciles content-free usage", async () => {
    const execution = await prepareAiExecution({
      user: USER,
      requestId: REQUEST_ID,
      task: "staff_clinical_summary",
      persona: "doctor",
      surface: "staff_assistant",
      now: new Date("2026-07-19T00:00:00Z"),
    });
    expect(mocks.reserve).toHaveBeenCalledWith(expect.objectContaining({
      clinicId: USER.clinicId,
      actorId: USER.id,
      periodStart: "2026-07-01",
      expectedModel: "anthropic/claude-sonnet-4.5",
      modelAlias: "staff-sonnet-bootstrap-v1",
      reservedCostMicros: 2_430_000,
      // legacy turn limit × worst-case reservation, so it tracks the same
      // maxSteps change; the number of turns a clinic may take is unchanged.
      budgetLimitMicros: 24_300_000,
      credentialMode: "managed",
    }));
    execution.observeStep({
      stepNumber: 0,
      model: { provider: "anthropic", modelId: "anthropic/claude-sonnet-4.5" },
      response: { modelId: "anthropic/claude-sonnet-4.5" },
      finishReason: "stop",
      usage: {
        inputTokens: 1_000,
        outputTokens: 100,
        totalTokens: 1_100,
        inputTokenDetails: { noCacheTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 100, reasoningTokens: 0 },
        raw: undefined,
      },
    });
    await execution.finalize({ outcome: "success" });
    const reconciliation = mocks.reconcile.mock.calls[0][0];
    expect(reconciliation).toMatchObject({
      reservationId: RESERVATION_ID,
      outcome: "success",
      actualCostMicros: 4_500,
      errorClass: null,
    });
    expect(reconciliation.attempts).toHaveLength(1);
    expect(Object.keys(reconciliation.attempts[0]).sort()).toEqual([
      "attempt_id", "attempt_sequence", "cache_write_tokens", "cached_input_tokens",
      "error_class", "estimated_cost_micros", "fallback_parent_attempt_id",
      "final_cost_micros", "input_tokens", "latency_ms", "model", "model_alias",
      "output_tokens", "provider", "reasoning_tokens", "status",
    ].sort());
    expect(JSON.stringify(reconciliation.attempts)).not.toMatch(/prompt|completion|message|patient|tool|body/i);
  });

  it("measures the first attempt from provider-step preparation", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const execution = await prepareAiExecution({
      user: USER,
      requestId: REQUEST_ID,
      task: "staff_clinical_summary",
      persona: "doctor",
      surface: "staff_assistant",
    });
    now.mockReturnValue(5_000);
    execution.beginStep();
    now.mockReturnValue(5_037);
    execution.observeStep({
      stepNumber: 0,
      model: { provider: "anthropic", modelId: "anthropic/claude-sonnet-4.5" },
      response: { modelId: "anthropic/claude-sonnet-4.5" },
      finishReason: "stop",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
        raw: undefined,
      },
    });
    await execution.finalize({ outcome: "success" });
    expect(mocks.reconcile.mock.calls[0][0].attempts[0].latency_ms).toBe(37);
    now.mockRestore();
  });

  it("maps a concurrent budget race loss to the existing safe cap error", async () => {
    mocks.reserve.mockResolvedValueOnce({
      data: null,
      error: { message: "AI_BUDGET_EXCEEDED" },
    });
    await expect(prepareAiExecution({
      user: USER,
      requestId: REQUEST_ID,
      task: "staff_clinical_summary",
      persona: "doctor",
      surface: "staff_assistant",
    })).rejects.toEqual(expect.objectContaining<Partial<AiToolAuthorizationError>>({
      reason: "usage_limit_reached",
    }));
    expect(mocks.gateway).not.toHaveBeenCalled();
  });

  it("records a content-free terminal attempt and releases through reconciliation on failure", async () => {
    const execution = await prepareAiExecution({
      user: USER,
      requestId: REQUEST_ID,
      task: "staff_clinical_summary",
      persona: "doctor",
      surface: "staff_assistant",
    });
    await execution.finalize({ outcome: "failed", errorClass: "provider timeout: secret detail" });
    expect(mocks.reconcile).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      actualCostMicros: 0,
      errorClass: "execution_failed",
      attempts: [expect.objectContaining({
        status: "failed",
        error_class: "execution_failed",
      })],
    }));
  });

  it("retries reconciliation once through the idempotent lease boundary", async () => {
    mocks.reconcile
      .mockResolvedValueOnce({ data: null, error: { message: "temporary failure" } })
      .mockResolvedValueOnce({ data: true, error: null });
    const execution = await prepareAiExecution({
      user: USER,
      requestId: REQUEST_ID,
      task: "staff_clinical_summary",
      persona: "doctor",
      surface: "staff_assistant",
    });
    await expect(execution.finalize({ outcome: "success" })).resolves.toBeUndefined();
    expect(mocks.reconcile).toHaveBeenCalledTimes(2);
    expect(mocks.reconcile.mock.calls[1][0]).toEqual(mocks.reconcile.mock.calls[0][0]);
  });
});
