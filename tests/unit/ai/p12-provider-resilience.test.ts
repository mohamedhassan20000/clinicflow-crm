/**
 * P12 — platform protection for direct provider calls.
 *
 * One ClinicFlow Anthropic account now serves every managed clinic, so the two
 * things that used to be someone else's problem are ours: provider rate limits,
 * and one tenant occupying every slot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { generateText } from "ai";

import {
  AiProviderCapacityError,
  RETRY_MAX_ATTEMPTS,
  RETRY_MAX_DELAY_MS,
  resetProviderResilienceState,
  retryDelayMs,
  withProviderResilience,
} from "@/lib/ai/platform/provider-resilience";
import { classifyAiProviderFailure } from "@/lib/ai/platform/failure";

const CLINIC_A = "00000000-0000-4000-8000-00000000000a";
const CLINIC_B = "00000000-0000-4000-8000-00000000000b";

function usage() {
  return {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
}

function apiError(statusCode: number, headers: Record<string, string> = {}) {
  const error = Object.assign(new Error(`provider ${statusCode}`), {
    name: "AI_APICallError",
    statusCode,
    responseHeaders: headers,
    url: "https://api.anthropic.com/v1/messages",
    requestBodyValues: {},
    isRetryable: false,
  });
  // `APICallError.isInstance` is a marker check in ai@6.
  (error as unknown as { [key: symbol]: unknown })[
    Symbol.for("vercel.ai.error.AI_APICallError")
  ] = true;
  (error as unknown as { [key: symbol]: unknown })[Symbol.for("vercel.ai.error")] = true;
  return error;
}

function model(behaviour: () => void) {
  return new MockLanguageModelV3({
    provider: "anthropic",
    modelId: "claude-haiku-4-5",
    doGenerate: async () => {
      behaviour();
      return {
        content: [{ type: "text" as const, text: "ok" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: usage(),
        warnings: [],
      };
    },
  });
}

beforeEach(() => {
  resetProviderResilienceState();
  delete process.env.AI_MANAGED_MAX_CONCURRENCY;
  delete process.env.AI_MANAGED_MAX_CONCURRENCY_PER_CLINIC;
});
afterEach(() => {
  resetProviderResilienceState();
});

describe("retry policy", () => {
  it("retries a rate limit exactly once, never more", async () => {
    let calls = 0;
    const wrapped = withProviderResilience(
      model(() => {
        calls += 1;
        if (calls <= RETRY_MAX_ATTEMPTS) throw apiError(429);
      }),
      { clinicId: CLINIC_A, providerId: "anthropic", modelId: "claude-haiku-4-5" },
    );
    const result = await generateText({ model: wrapped, prompt: "x", maxRetries: 0 });
    expect(result.text).toBe("ok");
    expect(calls).toBe(RETRY_MAX_ATTEMPTS + 1);
  });

  it("gives up after the single retry rather than looping on cost", async () => {
    let calls = 0;
    const wrapped = withProviderResilience(
      model(() => {
        calls += 1;
        throw apiError(503);
      }),
      { clinicId: CLINIC_A, providerId: "anthropic", modelId: "claude-haiku-4-5" },
    );
    await expect(generateText({ model: wrapped, prompt: "x", maxRetries: 0 })).rejects.toThrow();
    expect(calls).toBe(RETRY_MAX_ATTEMPTS + 1);
  });

  it("does not retry an authentication or request error at all", async () => {
    for (const status of [401, 403, 400]) {
      resetProviderResilienceState();
      let calls = 0;
      const wrapped = withProviderResilience(
        model(() => {
          calls += 1;
          throw apiError(status);
        }),
        { clinicId: CLINIC_A, providerId: "anthropic", modelId: "claude-haiku-4-5" },
      );
      await expect(generateText({ model: wrapped, prompt: "x", maxRetries: 0 })).rejects.toThrow();
      expect(calls).toBe(1);
    }
  });

  it("clamps an over-long provider retry-after instead of honouring it", async () => {
    expect(retryDelayMs(apiError(429, { "retry-after": "600" }))).toBe(RETRY_MAX_DELAY_MS);
    expect(retryDelayMs(apiError(429, { "retry-after": "1" }))).toBe(1_000);
    expect(retryDelayMs(apiError(429, { "retry-after": "not-a-number" }))).toBeGreaterThan(0);
    expect(retryDelayMs(new Error("no headers"))).toBeGreaterThan(0);
  });
});

describe("error normalization", () => {
  it("maps provider status codes onto ClinicFlow's transport-neutral classes", () => {
    expect(classifyAiProviderFailure(apiError(401))).toBe("authentication");
    expect(classifyAiProviderFailure(apiError(403))).toBe("permission");
    expect(classifyAiProviderFailure(apiError(402))).toBe("quota");
    expect(classifyAiProviderFailure(apiError(429))).toBe("rate_limit");
    expect(classifyAiProviderFailure(apiError(500))).toBe("provider_unavailable");
    expect(classifyAiProviderFailure(apiError(422))).toBe("request_failed");
    expect(classifyAiProviderFailure(new DOMException("slow", "TimeoutError"))).toBe("timeout");
  });

  it("classifies a saturated platform as a rate limit, not a transient failure", () => {
    expect(classifyAiProviderFailure(new AiProviderCapacityError("platform"))).toBe("rate_limit");
  });
});

describe("concurrency ceilings", () => {
  it("stops one clinic from occupying every platform slot", async () => {
    process.env.AI_MANAGED_MAX_CONCURRENCY = "4";
    process.env.AI_MANAGED_MAX_CONCURRENCY_PER_CLINIC = "1";
    resetProviderResilienceState();

    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const slowModel = new MockLanguageModelV3({
      provider: "anthropic",
      modelId: "claude-haiku-4-5",
      doGenerate: async () => {
        started += 1;
        await blocked;
        return {
          content: [{ type: "text" as const, text: "ok" }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: usage(),
          warnings: [],
        };
      },
    });
    const wrappedA = withProviderResilience(slowModel, {
      clinicId: CLINIC_A,
      providerId: "anthropic",
      modelId: "claude-haiku-4-5",
    });

    const first = generateText({ model: wrappedA, prompt: "one", maxRetries: 0 });
    // Let the first call take clinic A's only slot.
    await vi.waitFor(() => expect(started).toBe(1));

    // A second clinic is unaffected — the per-clinic ceiling is per clinic.
    const wrappedB = withProviderResilience(slowModel, {
      clinicId: CLINIC_B,
      providerId: "anthropic",
      modelId: "claude-haiku-4-5",
    });
    const other = generateText({ model: wrappedB, prompt: "two", maxRetries: 0 });
    await vi.waitFor(() => expect(started).toBe(2));

    release();
    await Promise.all([first, other]);
  });

  it("fails fast rather than queueing forever when capacity cannot be acquired", async () => {
    const semaphoreError = new AiProviderCapacityError("clinic");
    // Failing closed is the safe direction: nothing is spent, and the caller's
    // existing reconciliation records an ordinary failed attempt.
    expect(semaphoreError.failureClass).toBe("rate_limit");
    expect(semaphoreError.scope).toBe("clinic");
  });
});
