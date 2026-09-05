/**
 * F-14 — prompt caching: configuration and wiring, with zero provider calls.
 *
 * Nothing in this file dials Anthropic. What it asserts is that the request the
 * product *would* send carries the two cache breakpoints in the right places,
 * on the right transports and on no others — and that the invariants those
 * placements depend on actually hold in the mount.
 *
 * The behavioural claim ("caching changes nothing the model sees") is not a
 * matter of opinion here either: the marker is provider metadata attached to
 * content that is sent either way, and the tests below assert that the tool
 * set, tool names, descriptions and schemas are byte-identical with and
 * without it.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { tool } from "ai";
import { z } from "zod";

import {
  ANTHROPIC_MIN_CACHEABLE_PREFIX_TOKENS,
  PROMPT_CACHE_TTL,
  annotateToolsForPromptCache,
  minimumCacheablePrefixTokens,
  promptCacheProviderOptions,
  promptCacheToolProviderOptions,
  routeSupportsPromptCaching,
  transportSupportsPromptCaching,
} from "@/lib/ai/platform/prompt-cache";
import { getCertifiedModelRoute, getTaskPolicy } from "@/lib/ai/platform/registry";
import { STAGE_INDEPENDENT_TOOLS } from "@/lib/ai/booking-stage";
import { PATIENT_TOOL_NAMES } from "@/lib/ai/patient-tools";

const PATIENT_ROUTE = getCertifiedModelRoute(getTaskPolicy("patient_booking", "patient"));

function fixtureTools() {
  return {
    alpha: tool({ description: "a", inputSchema: z.object({}) }),
    beta: tool({ description: "b", inputSchema: z.object({}) }),
    gamma: tool({ description: "c", inputSchema: z.object({}) }),
  };
}

describe("which transports cache", () => {
  it("caches on both direct Anthropic transports and on no gateway transport", () => {
    expect(transportSupportsPromptCaching("anthropic_direct")).toBe(true);
    expect(transportSupportsPromptCaching("anthropic_direct_hybrid")).toBe(true);
    // The gateway has its own caching semantics. Guessing at them is how a
    // provider-independent orchestration acquires a provider assumption.
    expect(transportSupportsPromptCaching("vercel_ai_gateway")).toBe(false);
    expect(promptCacheProviderOptions("vercel_ai_gateway")).toEqual({});
    expect(promptCacheToolProviderOptions("vercel_ai_gateway")).toBeNull();
  });

  it("caches on the certified patient route", () => {
    expect(routeSupportsPromptCaching(PATIENT_ROUTE)).toBe(true);
    expect(PATIENT_ROUTE.transport).toBe("anthropic_direct");
    expect(PATIENT_ROUTE.providerModelId).toBe("claude-haiku-4-5");
  });
});

describe("the directive itself", () => {
  it("is an ephemeral breakpoint at the platform's chosen TTL", () => {
    expect(promptCacheProviderOptions("anthropic_direct")).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: PROMPT_CACHE_TTL } },
    });
    expect(promptCacheToolProviderOptions("anthropic_direct")).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: PROMPT_CACHE_TTL } },
    });
  });

  it("uses the 5-minute TTL, whose write premium is 1.25x and not 2x", () => {
    // A 1-hour entry costs 2x to write and needs three reads to pay for
    // itself; a 5-minute entry costs 1.25x and pays for itself on the second.
    // Patient turns arrive in bursts and a tool loop re-reads within one turn.
    expect(PROMPT_CACHE_TTL).toBe("5m");
    // The cost meter must already price the two cache token classes, or a
    // cached run would be reported at the wrong price.
    expect(PATIENT_ROUTE.pricing.cacheReadMicrosPerMillion).toBe(
      PATIENT_ROUTE.pricing.inputMicrosPerMillion / 10,
    );
    expect(PATIENT_ROUTE.pricing.cacheWriteMicrosPerMillion).toBe(
      PATIENT_ROUTE.pricing.inputMicrosPerMillion * 1.25,
    );
  });
});

describe("the minimum cacheable prefix", () => {
  it("records Haiku 4.5's unusually high 4096-token floor", () => {
    // Not folklore and not inferable from the model's tier: below this a
    // breakpoint caches nothing, silently, with no error and no warning.
    expect(minimumCacheablePrefixTokens(PATIENT_ROUTE)).toBe(4096);
    expect(ANTHROPIC_MIN_CACHEABLE_PREFIX_TOKENS["claude-haiku-4-5"]).toBe(4096);
  });

  it("reports an unknown model as unknown rather than as unlimited", () => {
    expect(
      minimumCacheablePrefixTokens({
        ...PATIENT_ROUTE,
        providerModelId: "some-future-model",
      }),
    ).toBeNull();
  });
});

describe("the tool-block breakpoint", () => {
  it("marks exactly one tool, and it is the last one mounted", () => {
    const annotated = annotateToolsForPromptCache(fixtureTools(), "anthropic_direct");
    const marked = Object.entries(annotated).filter(
      ([, value]) => value.providerOptions !== undefined,
    );
    expect(marked.map(([name]) => name)).toEqual(["gamma"]);
    expect(marked[0]![1].providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: PROMPT_CACHE_TTL } },
    });
  });

  it("marks the last ALWAYS-ACTIVE tool when an allow-list is given", () => {
    // A breakpoint on a tool the stage table can hide vanishes on exactly the
    // stages that make the most calls.
    const annotated = annotateToolsForPromptCache(fixtureTools(), "anthropic_direct", {
      alwaysActive: ["alpha", "beta"],
    });
    expect(annotated.beta.providerOptions).toBeDefined();
    expect(annotated.gamma.providerOptions).toBeUndefined();
  });

  it("does not mutate the tools it was given, and returns them unchanged off-transport", () => {
    const original = fixtureTools();
    annotateToolsForPromptCache(original, "anthropic_direct");
    expect(original.gamma.providerOptions).toBeUndefined();
    expect(annotateToolsForPromptCache(original, "vercel_ai_gateway")).toBe(original);
  });

  it("changes nothing the model reads: same tools, names, descriptions and schemas", () => {
    const before = fixtureTools();
    const after = annotateToolsForPromptCache(before, "anthropic_direct");
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const name of Object.keys(before) as (keyof typeof before)[]) {
      expect(after[name].description).toBe(before[name].description);
      expect(after[name].inputSchema).toBe(before[name].inputSchema);
      expect(after[name].execute).toBe(before[name].execute);
    }
  });
});

describe("the size claim the tool breakpoint's inertness rests on", () => {
  it("measures the patient tool block as well under Haiku 4.5's 4096-token floor", async () => {
    // `prompt-cache.ts` states that the tool-definition breakpoint is currently
    // inert on `claude-haiku-4-5` because the tool block is ~1.8K tokens against
    // a 4096-token minimum. That is a claim about this repository's own tool
    // descriptions and schemas, so it is measured rather than asserted in prose
    // — if the mount grows past the floor, this fails and the comment gets
    // corrected instead of quietly becoming wrong in the other direction.
    const { buildAcceptanceTools } = await import("@/lib/ai/acceptance/tools");
    const { AcceptanceSimulator, STRANGER } = await import("@/lib/ai/acceptance/simulator");
    const tools = buildAcceptanceTools(new AcceptanceSimulator(STRANGER, {}));

    let chars = 0;
    for (const [name, definition] of Object.entries(tools)) {
      chars += name.length + (definition.description ?? "").length;
      chars += JSON.stringify(
        z.toJSONSchema((definition as unknown as { inputSchema: z.ZodType }).inputSchema),
      ).length;
    }

    // Predominantly English prose and JSON: ~4 characters per token is the
    // conservative (token-overestimating) end of the usual range.
    const upperBoundTokens = Math.ceil(chars / 3);
    expect(chars).toBeGreaterThan(4_000);
    expect(upperBoundTokens).toBeLessThan(
      ANTHROPIC_MIN_CACHEABLE_PREFIX_TOKENS["claude-haiku-4-5"]!,
    );
  });
});

describe("the providers actually emit it", () => {
  it("puts the directive on the managed direct transport's prepared options", async () => {
    // Synthetic key: this constructs a client, it does not call one.
    vi.stubEnv("ANTHROPIC_MANAGED_API_KEY", "sk-ant-acceptance-not-a-real-key");
    const { managedAnthropicProvider } = await import("@/lib/ai/platform/managed-anthropic");
    const prepared = managedAnthropicProvider.prepare({
      route: PATIENT_ROUTE,
      task: "patient_booking",
      surface: "patient_messaging",
      clinicId: "00000000-0000-4000-8000-0000000ACCE01",
      actorId: "00000000-0000-4000-8000-0000000ACCE02",
      policyVersion: "prompt-cache-wiring-test",
    });
    expect(prepared.transport).toBe("anthropic_direct");
    expect(prepared.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: PROMPT_CACHE_TTL } },
    });
    vi.unstubAllEnvs();
  });

  it("gives a BYOK clinic the same caching as the managed key", async () => {
    const { prepareTenantProvider } = await import("@/lib/ai/platform/tenant-provider");
    const prepared = prepareTenantProvider({
      mode: "byok_strict",
      secret: "sk-ant-acceptance-not-a-real-key",
      request: {
        route: PATIENT_ROUTE,
        task: "patient_booking",
        surface: "patient_messaging",
        clinicId: "00000000-0000-4000-8000-0000000ACCE01",
        actorId: "00000000-0000-4000-8000-0000000ACCE02",
        policyVersion: "prompt-cache-wiring-test",
      },
      async onFallback() {},
    });
    expect(prepared.transport).toBe("anthropic_direct");
    expect(prepared.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: PROMPT_CACHE_TTL } },
    });
  });
});

describe("the mount invariant the breakpoint depends on", () => {
  it("ends the patient mount with a stage-independent tool", () => {
    // `annotateToolsForPromptCache` puts the marker on the last mounted tool
    // that survives `allowedToolsForStage`. If the mount stopped ending in a
    // stage-independent tool the marker would move, so the ordering is asserted
    // rather than left as a comment in the tool builder.
    const last = PATIENT_TOOL_NAMES[PATIENT_TOOL_NAMES.length - 1]!;
    expect(STAGE_INDEPENDENT_TOOLS as readonly string[]).toContain(last);
  });
});
