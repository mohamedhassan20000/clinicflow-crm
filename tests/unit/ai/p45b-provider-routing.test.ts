import type { LanguageModel } from "ai";
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  direct: null as unknown as LanguageModel,
  managed: null as unknown as LanguageModel,
  createAnthropic: vi.fn(),
  prepareManaged: vi.fn(),
}));

vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: mocks.createAnthropic }));
// P12: hybrid's fallback target is the resolved MANAGED provider, which now
// defaults to direct Anthropic rather than the gateway.
vi.mock("@/lib/ai/platform/managed-provider", () => ({
  resolveManagedProvider: () => ({ mode: "managed", prepare: mocks.prepareManaged }),
}));

import { getCertifiedModelRoute, getTaskPolicy } from "@/lib/ai/platform/registry";
import { prepareTenantProvider } from "@/lib/ai/platform/tenant-provider";

function usage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
}

function successModel(provider: string, counter: { calls: number }) {
  return new MockLanguageModelV3({
    provider,
    modelId: `${provider}/approved-model`,
    doGenerate: async () => {
      counter.calls += 1;
      return {
        content: [{ type: "text" as const, text: provider }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: usage(),
        warnings: [],
      };
    },
  });
}

function request() {
  const route = getCertifiedModelRoute(getTaskPolicy("staff_clinical_summary", "doctor"));
  return {
    route,
    task: "staff_clinical_summary" as const,
    surface: "staff_assistant" as const,
    clinicId: "00000000-0000-4000-8000-000000000001",
    actorId: "00000000-0000-4000-8000-000000000002",
    policyVersion: "p45b-staff-policy-v1",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createAnthropic.mockImplementation(() => () => mocks.direct);
  mocks.prepareManaged.mockImplementation(() => ({
    model: mocks.managed,
    providerOptions: {},
    transport: "anthropic_direct",
  }));
});

describe("P4.5B tenant provider routing", () => {
  it("strict BYOK never constructs or calls the managed provider", async () => {
    mocks.direct = new MockLanguageModelV3({
      provider: "anthropic",
      modelId: "anthropic/approved-model",
      doGenerate: async () => { throw new Error("provider unavailable"); },
    });
    const prepared = prepareTenantProvider({
      mode: "byok_strict",
      secret: "sk-ant-api03_example-secret-value",
      request: request(),
      onFallback: vi.fn(),
    });

    await expect(generateText({ model: prepared.model, prompt: "test", maxRetries: 0 }))
      .rejects.toThrow("provider unavailable");
    expect(prepared.transport).toBe("anthropic_direct");
    expect(mocks.prepareManaged).not.toHaveBeenCalled();
  });

  it("hybrid audits once, then stays on the certified managed DIRECT route", async () => {
    let directCalls = 0;
    mocks.direct = new MockLanguageModelV3({
      provider: "anthropic",
      modelId: "anthropic/approved-model",
      doGenerate: async () => {
        directCalls += 1;
        throw new DOMException("provider timeout", "TimeoutError");
      },
    });
    const managedCalls = { calls: 0 };
    mocks.managed = successModel("managed-direct", managedCalls);
    const onFallback = vi.fn().mockResolvedValue(undefined);
    const prepared = prepareTenantProvider({
      mode: "hybrid",
      secret: "sk-ant-api03_example-secret-value",
      request: request(),
      onFallback,
    });

    const first = await generateText({ model: prepared.model, prompt: "first", maxRetries: 0 });
    const second = await generateText({ model: prepared.model, prompt: "second", maxRetries: 0 });

    expect(first.text).toBe("managed-direct");
    expect(second.text).toBe("managed-direct");
    expect(directCalls).toBe(1);
    expect(managedCalls.calls).toBe(2);
    expect(onFallback).toHaveBeenCalledOnce();
    expect(mocks.prepareManaged).toHaveBeenCalledOnce();
  });

  it("does not spend managed credits when the fallback audit fails", async () => {
    mocks.direct = new MockLanguageModelV3({
      provider: "anthropic",
      modelId: "anthropic/approved-model",
      doGenerate: async () => { throw new DOMException("provider timeout", "TimeoutError"); },
    });
    const managedCalls = { calls: 0 };
    mocks.managed = successModel("managed-direct", managedCalls);
    const prepared = prepareTenantProvider({
      mode: "hybrid",
      secret: "sk-ant-api03_example-secret-value",
      request: request(),
      onFallback: vi.fn().mockRejectedValue(new Error("audit unavailable")),
    });

    await expect(generateText({ model: prepared.model, prompt: "test", maxRetries: 0 }))
      .rejects.toThrow("audit unavailable");
    expect(managedCalls.calls).toBe(0);
  });

  it("does not fall back for an unclassified request failure", async () => {
    mocks.direct = new MockLanguageModelV3({
      provider: "anthropic",
      modelId: "anthropic/approved-model",
      doGenerate: async () => { throw new Error("invalid request shape"); },
    });
    const managedCalls = { calls: 0 };
    mocks.managed = successModel("managed-direct", managedCalls);
    const onFallback = vi.fn();
    const prepared = prepareTenantProvider({
      mode: "hybrid",
      secret: "sk-ant-api03_example-secret-value",
      request: request(),
      onFallback,
    });

    await expect(generateText({ model: prepared.model, prompt: "test", maxRetries: 0 }))
      .rejects.toThrow("invalid request shape");
    expect(onFallback).not.toHaveBeenCalled();
    expect(managedCalls.calls).toBe(0);
  });
});
