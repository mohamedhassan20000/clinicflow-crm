/**
 * P12 — the live acceptance lane's wiring, proven WITHOUT spending anything.
 *
 * The previous phase reported a live lane it had never actually run. These tests
 * exist so the opposite is true here: everything about the lane except the money
 * is verified offline — credential selection, the direct transport, the call
 * cap, the cost meter, and its refusal to reach for a real clinic credential.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAnthropic: vi.fn(),
  doGenerate: vi.fn(),
  gateway: vi.fn(),
  resolveCredential: vi.fn(),
}));

vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: mocks.createAnthropic }));
vi.mock("@/lib/ai/platform/provider-connections", () => ({
  // If the lane ever tried to read a stored clinic credential, this throws.
  resolveAiProviderCredential: mocks.resolveCredential,
  resolveByokFallbackCredential: mocks.resolveCredential,
}));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, gateway: mocks.gateway };
});

import {
  DEFAULT_LIVE_MAX_CALLS,
  LIVE_ACCEPTANCE_ENV,
  LiveAcceptanceCallCapError,
  LiveAcceptanceConfigurationError,
  createLiveAcceptanceModel,
  liveAcceptanceEnabled,
  readLiveUsage,
  resolveLiveAcceptanceCallCap,
  resolveLiveAcceptanceModes,
} from "@/lib/ai/acceptance/live-provider";
import { MANAGED_ANTHROPIC_KEY_ENV } from "@/lib/ai/platform/managed-anthropic";

const MANAGED_KEY = "sk-ant-managed-acceptance";
const SYNTHETIC_BYOK_KEY = "sk-ant-synthetic-acceptance-fixture";

function stubModel() {
  return {
    specificationVersion: "v3" as const,
    provider: "anthropic",
    modelId: "claude-haiku-4-5",
    supportedUrls: {},
    doGenerate: mocks.doGenerate,
    doStream: vi.fn(),
  };
}

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { [MANAGED_ANTHROPIC_KEY_ENV]: MANAGED_KEY, ...overrides } as unknown as NodeJS.ProcessEnv;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env[MANAGED_ANTHROPIC_KEY_ENV] = MANAGED_KEY;
  mocks.createAnthropic.mockImplementation(() => () => stubModel());
  mocks.resolveCredential.mockRejectedValue(
    new Error("the live lane must never read a stored clinic credential"),
  );
  mocks.doGenerate.mockResolvedValue({
    content: [{ type: "text", text: "ok" }],
    finishReason: { unified: "stop", raw: undefined },
    usage: {
      inputTokens: { total: 1_000, noCache: 800, cacheRead: 200, cacheWrite: 0 },
      outputTokens: { total: 100, text: 100, reasoning: undefined },
    },
    warnings: [],
  });
});

describe("the lane is off unless explicitly enabled", () => {
  it("requires AI_ACCEPTANCE_LIVE=1", () => {
    expect(liveAcceptanceEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(liveAcceptanceEnabled({ AI_ACCEPTANCE_LIVE: "true" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(liveAcceptanceEnabled({ AI_ACCEPTANCE_LIVE: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it("certifies managed by default and both modes only on request", () => {
    expect(resolveLiveAcceptanceModes({} as unknown as NodeJS.ProcessEnv)).toEqual(["managed"]);
    expect(resolveLiveAcceptanceModes(env({ [LIVE_ACCEPTANCE_ENV.mode]: "byok" }))).toEqual(["byok"]);
    expect(resolveLiveAcceptanceModes(env({ [LIVE_ACCEPTANCE_ENV.mode]: "both" }))).toEqual([
      "managed",
      "byok",
    ]);
    expect(() =>
      resolveLiveAcceptanceModes(env({ [LIVE_ACCEPTANCE_ENV.mode]: "everything" })),
    ).toThrow(LiveAcceptanceConfigurationError);
  });

  it("caps calls, defaulting conservatively and rejecting nonsense", () => {
    expect(resolveLiveAcceptanceCallCap({} as unknown as NodeJS.ProcessEnv)).toBe(DEFAULT_LIVE_MAX_CALLS);
    expect(resolveLiveAcceptanceCallCap(env({ [LIVE_ACCEPTANCE_ENV.maxCalls]: "5" }))).toBe(5);
    for (const bad of ["0", "-3", "lots"]) {
      expect(() =>
        resolveLiveAcceptanceCallCap(env({ [LIVE_ACCEPTANCE_ENV.maxCalls]: bad })),
      ).toThrow(LiveAcceptanceConfigurationError);
    }
  });
});

describe("credential selection", () => {
  it("uses ClinicFlow's managed key for the managed lane", () => {
    createLiveAcceptanceModel({ mode: "managed", env: env(), maxCalls: 2 });
    expect(mocks.createAnthropic).toHaveBeenCalledWith({ apiKey: MANAGED_KEY });
  });

  it("uses the synthetic fixture key for the BYOK lane, never a stored one", async () => {
    createLiveAcceptanceModel({
      mode: "byok",
      env: env({ [LIVE_ACCEPTANCE_ENV.byokKey]: SYNTHETIC_BYOK_KEY }),
      maxCalls: 2,
    });
    expect(mocks.createAnthropic).toHaveBeenCalledWith({ apiKey: SYNTHETIC_BYOK_KEY });
    expect(mocks.resolveCredential).not.toHaveBeenCalled();
  });

  it("refuses to run the BYOK lane without a synthetic key rather than borrowing one", () => {
    expect(() => createLiveAcceptanceModel({ mode: "byok", env: env(), maxCalls: 2 })).toThrow(
      LiveAcceptanceConfigurationError,
    );
  });

  it("uses the certified patient route and the direct transport in both modes", () => {
    for (const mode of ["managed", "byok"] as const) {
      const live = createLiveAcceptanceModel({
        mode,
        env: env({ [LIVE_ACCEPTANCE_ENV.byokKey]: SYNTHETIC_BYOK_KEY }),
        maxCalls: 2,
      });
      expect(live.route.alias).toBe("patient-haiku-bootstrap-v1");
      expect(live.route.providerModelId).toBe("claude-haiku-4-5");
      expect(live.route.transport).toBe("anthropic_direct");
    }
    // No gateway is constructed on either lane.
    expect(mocks.gateway).not.toHaveBeenCalled();
  });
});

describe("metering and the spend cap", () => {
  it("counts calls and refuses the one past the cap", async () => {
    const live = createLiveAcceptanceModel({ mode: "managed", env: env(), maxCalls: 2 });
    const params = { prompt: [], includeRawChunks: false } as never;
    await live.model.doGenerate(params);
    await live.model.doGenerate(params);
    await expect(live.model.doGenerate(params)).rejects.toThrow(LiveAcceptanceCallCapError);
    expect(live.usage().calls).toBe(2);
    // The refused call never reached the provider.
    expect(mocks.doGenerate).toHaveBeenCalledTimes(2);
  });

  it("accumulates tokens and an estimated cost from the certified pricing", async () => {
    const live = createLiveAcceptanceModel({ mode: "managed", env: env(), maxCalls: 4 });
    await live.model.doGenerate({ prompt: [], includeRawChunks: false } as never);
    const usage = live.usage();
    expect(usage.inputTokens).toBe(800);
    expect(usage.cacheReadTokens).toBe(200);
    expect(usage.outputTokens).toBe(100);
    // Haiku: 1.00/M input, 5.00/M output, 0.10/M cache read.
    // 800×1 + 100×5 + 200×0.1 = 800 + 500 + 20 = 1,320 micros.
    expect(usage.estimatedCostMicros).toBe(1_320);
  });

  it("reads either provider usage shape without under-reporting the bill", () => {
    expect(
      readLiveUsage({
        inputTokens: { total: 1_000, noCache: 700, cacheRead: 200, cacheWrite: 100 },
        outputTokens: { total: 50 },
      }),
    ).toEqual({ input: 700, output: 50, cacheRead: 200, cacheWrite: 100 });
    expect(
      readLiveUsage({
        inputTokens: 1_000,
        outputTokens: 50,
        inputTokenDetails: { cacheReadTokens: 200, cacheWriteTokens: 100 },
      }),
    ).toEqual({ input: 700, output: 50, cacheRead: 200, cacheWrite: 100 });
    expect(readLiveUsage(undefined)).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});
