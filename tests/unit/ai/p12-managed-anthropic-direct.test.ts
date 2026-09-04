/**
 * P12 — ClinicFlow-managed AI calls Anthropic directly.
 *
 * The subject here is the TRANSPORT, and only the transport. Nothing in this
 * file touches prompts, tools, authorization or model policy, because the whole
 * point of the change is that none of those can tell which transport ran.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAnthropic: vi.fn(),
  anthropicModel: vi.fn((modelId: string) => ({ modelId, provider: "anthropic" })),
  gateway: vi.fn((modelId: string) => ({ modelId, provider: "gateway" })),
  wrapLanguageModel: vi.fn(({ model }: { model: unknown }) => model),
}));

vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: mocks.createAnthropic }));
vi.mock("ai", () => ({
  gateway: mocks.gateway,
  wrapLanguageModel: mocks.wrapLanguageModel,
  APICallError: { isInstance: () => false },
}));

import {
  AiManagedCredentialError,
  MANAGED_ANTHROPIC_KEY_ENV,
  hasManagedAnthropicKey,
  managedAnthropicProvider,
  resolveManagedAnthropicKey,
} from "@/lib/ai/platform/managed-anthropic";
import { managedGatewayProvider } from "@/lib/ai/platform/managed-gateway";
import { resolveManagedProvider } from "@/lib/ai/platform/managed-provider";
import {
  DEFAULT_MANAGED_TRANSPORT,
  MANAGED_TRANSPORTS,
  managedTransportIsDirect,
  resolveManagedTransport,
  transportForCredentialMode,
} from "@/lib/ai/platform/transport";
import { getCertifiedModelRoute, getTaskPolicy, listCertifiedModelRoutes } from "@/lib/ai/platform/registry";

const CLINIC = "00000000-0000-4000-8000-000000000002";
const ACTOR = "00000000-0000-4000-8000-000000000001";

function request(task: "staff_clinical_summary" | "patient_booking" = "staff_clinical_summary") {
  const persona = task === "patient_booking" ? ("patient" as const) : ("doctor" as const);
  return {
    route: getCertifiedModelRoute(getTaskPolicy(task, persona)),
    task,
    surface: task === "patient_booking" ? ("patient_messaging" as const) : ("staff_assistant" as const),
    clinicId: CLINIC,
    actorId: ACTOR,
    policyVersion: "p12-test-policy-v1",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AI_MANAGED_TRANSPORT;
  process.env[MANAGED_ANTHROPIC_KEY_ENV] = "sk-ant-managed-test-key";
  mocks.createAnthropic.mockImplementation(() => mocks.anthropicModel);
  mocks.wrapLanguageModel.mockImplementation(({ model }: { model: unknown }) => model);
});

describe("managed transport selection", () => {
  it("defaults to direct Anthropic", () => {
    expect(DEFAULT_MANAGED_TRANSPORT).toBe("anthropic_direct");
    expect(resolveManagedTransport({} as unknown as NodeJS.ProcessEnv)).toBe("anthropic_direct");
    expect(managedTransportIsDirect({} as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it("keeps the Vercel gateway registered but reachable only by explicit opt-in", () => {
    expect(MANAGED_TRANSPORTS).toContain("vercel_ai_gateway");
    // The adapter still exists and still works — it is an alternate transport,
    // not dead code.
    expect(managedGatewayProvider.mode).toBe("managed");
    expect(
      resolveManagedTransport({ AI_MANAGED_TRANSPORT: "vercel_ai_gateway" } as unknown as NodeJS.ProcessEnv),
    ).toBe("vercel_ai_gateway");
  });

  it("fails closed onto the direct default for an unrecognized or empty value", () => {
    for (const value of ["", "   ", "openai", "gateway", "VERCEL_AI_GATEWAY"]) {
      expect(
        resolveManagedTransport({ AI_MANAGED_TRANSPORT: value } as unknown as NodeJS.ProcessEnv),
      ).toBe("anthropic_direct");
    }
  });

  it("records the right transport per credential mode", () => {
    expect(transportForCredentialMode("managed", {} as unknown as NodeJS.ProcessEnv)).toBe("anthropic_direct");
    expect(transportForCredentialMode("byok_strict", {} as unknown as NodeJS.ProcessEnv)).toBe("anthropic_direct");
    expect(transportForCredentialMode("hybrid", {} as unknown as NodeJS.ProcessEnv)).toBe("anthropic_direct_hybrid");
    expect(
      transportForCredentialMode("managed", {
        AI_MANAGED_TRANSPORT: "vercel_ai_gateway",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe("vercel_ai_gateway");
  });

  it("resolves the direct adapter by default and the gateway only on opt-in", () => {
    expect(resolveManagedProvider({} as unknown as NodeJS.ProcessEnv)).toBe(managedAnthropicProvider);
    expect(
      resolveManagedProvider({ AI_MANAGED_TRANSPORT: "vercel_ai_gateway" } as unknown as NodeJS.ProcessEnv),
    ).toBe(managedGatewayProvider);
  });
});

describe("managed Anthropic credential", () => {
  it("uses the dedicated managed key, never an ambient ANTHROPIC_API_KEY", () => {
    managedAnthropicProvider.prepare(request());
    expect(mocks.createAnthropic).toHaveBeenCalledWith({ apiKey: "sk-ant-managed-test-key" });
  });

  it("fails closed when the managed key is absent, rather than falling back", () => {
    delete process.env[MANAGED_ANTHROPIC_KEY_ENV];
    expect(hasManagedAnthropicKey()).toBe(false);
    expect(() => resolveManagedAnthropicKey()).toThrow(AiManagedCredentialError);
    expect(() => managedAnthropicProvider.prepare(request())).toThrow(AiManagedCredentialError);
    // Critically: it does NOT quietly route to the gateway instead.
    expect(mocks.gateway).not.toHaveBeenCalled();
  });

  it("never leaks the managed key into prepared provider options", () => {
    const prepared = managedAnthropicProvider.prepare(request());
    expect(JSON.stringify(prepared.providerOptions)).not.toContain("sk-ant-managed-test-key");
    // F-14 — the options are no longer empty: the direct transport now carries
    // the prompt-cache directive. Enumerated exactly rather than loosened to a
    // substring check, so anything else appearing here still fails, and the
    // "no secret in the options" property this test exists for is unchanged.
    expect(prepared.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } },
    });
    // No gateway options: `zeroDataRetention` and serving-provider pinning are
    // gateway features and must never be implied on the direct transport.
    expect(prepared.providerOptions.gateway).toBeUndefined();
  });
});

describe("managed direct execution path", () => {
  it("makes no gateway call at all on a normal managed turn", () => {
    const prepared = managedAnthropicProvider.prepare(request());
    expect(prepared.transport).toBe("anthropic_direct");
    expect(mocks.gateway).not.toHaveBeenCalled();
  });

  it("sends the NATIVE Anthropic model id, not the gateway-qualified one", () => {
    managedAnthropicProvider.prepare(request());
    expect(mocks.anthropicModel).toHaveBeenCalledWith("claude-sonnet-4-5");
    managedAnthropicProvider.prepare(request("patient_booking"));
    expect(mocks.anthropicModel).toHaveBeenCalledWith("claude-haiku-4-5");
    for (const call of mocks.anthropicModel.mock.calls) {
      expect(call[0]).not.toContain("/");
    }
  });

  it("wraps the direct model in the platform resilience middleware", () => {
    managedAnthropicProvider.prepare(request());
    expect(mocks.wrapLanguageModel).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "anthropic", modelId: "claude-sonnet-4-5" }),
    );
  });

  it("keeps every certified route on the direct transport", () => {
    for (const route of listCertifiedModelRoutes()) {
      expect(route.transport).toBe("anthropic_direct");
      expect(route.provider).toBe("anthropic");
    }
  });
});

describe("privacy posture", () => {
  it("does not claim gateway ZDR on the direct transport", () => {
    const prepared = managedAnthropicProvider.prepare(request());
    // No `zeroDataRetention` is asserted anywhere on the direct path, because
    // there is no per-request control to assert it with.
    expect(JSON.stringify(prepared.providerOptions)).not.toContain("zeroDataRetention");
  });

  it("still sends the gateway ZDR flag when the gateway transport is chosen", () => {
    const prepared = managedGatewayProvider.prepare(request());
    expect(prepared.providerOptions.gateway).toMatchObject({ zeroDataRetention: true });
  });

  it("names the retention fields by the transport that can actually enforce them", () => {
    const route = getCertifiedModelRoute(getTaskPolicy("staff_clinical_summary", "doctor"));
    expect(route.privacy.gatewayZeroDataRetention).toBe(true);
    expect(route.privacy.directProviderRetention).toBe("contractual_only");
    // The old transport-neutral name is gone, so no caller can read it as a
    // guarantee that spans both transports.
    expect(route.privacy).not.toHaveProperty("zeroDataRetentionRequired");
  });
});
