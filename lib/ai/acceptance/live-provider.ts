import "server-only";

import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { managedAnthropicProvider } from "@/lib/ai/platform/managed-anthropic";
import { prepareTenantProvider } from "@/lib/ai/platform/tenant-provider";
import { getCertifiedModelRoute, getTaskPolicy } from "@/lib/ai/platform/registry";
import type {
  AiProviderOptions,
  AiProviderRequest,
  CertifiedModelRoute,
} from "@/lib/ai/platform/types";

/**
 * The LIVE acceptance lane's provider.
 *
 * This is the only place in the repository that deliberately makes real,
 * billable model calls, so the safety properties are built in rather than left
 * to the operator:
 *
 *  * **Off unless asked.** `AI_ACCEPTANCE_LIVE=1` is required; nothing here runs
 *    in CI or in an ordinary `pnpm test`.
 *  * **Hard call cap.** Every provider call is counted, and the (`maxCalls + 1`)th
 *    throws instead of dialling. A runaway tool loop cannot turn a certification
 *    run into an open-ended bill.
 *  * **Two credentials, certified separately.** The managed lane uses
 *    ClinicFlow's own key; the BYOK lane uses a SYNTHETIC fixture key supplied
 *    only for the test. A real clinic credential is never read: the BYOK lane
 *    takes its secret from the environment and never touches
 *    `ai_provider_connections`.
 *  * **Synthetic data only.** The caller supplies fixture scenarios; nothing in
 *    this module can reach clinic or patient data.
 *
 * It runs the SAME certified route, prompts, tools and graders as the offline
 * lanes. That is the point: the lane certifies the transport, not a new pipeline.
 */

export type LiveAcceptanceMode = "managed" | "byok";

export const LIVE_ACCEPTANCE_ENV = {
  enabled: "AI_ACCEPTANCE_LIVE",
  mode: "AI_ACCEPTANCE_LIVE_MODE",
  byokKey: "AI_ACCEPTANCE_BYOK_API_KEY",
  maxCalls: "AI_ACCEPTANCE_LIVE_MAX_CALLS",
  /**
   * F-13 — run only the named cases, in the real live lane.
   *
   * A full certification is 109 cases and ~380 provider calls. Re-running all
   * of it to re-check six is the reason a fix loop against live behaviour is
   * expensive enough to be skipped, which is the worst outcome available.
   *
   * The filter selects; it never substitutes. The same runner, the same
   * scenarios, the same graders and the same expectations are used, and the
   * artifact records the run as partial so a targeted pass can never be read
   * as a certification. See `selectLiveAcceptanceCases`.
   */
  cases: "AI_ACCEPTANCE_LIVE_CASES",
} as const;

/** Conservative default: a full lane must be opted into explicitly. */
export const DEFAULT_LIVE_MAX_CALLS = 40;

export class LiveAcceptanceCallCapError extends Error {
  constructor(public readonly cap: number) {
    super(
      `Live acceptance call cap reached (${cap}). The run was stopped before making another billable provider call.`,
    );
    this.name = "LiveAcceptanceCallCapError";
  }
}

export class LiveAcceptanceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveAcceptanceConfigurationError";
  }
}

export function liveAcceptanceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[LIVE_ACCEPTANCE_ENV.enabled] === "1";
}

/** `managed` (default), `byok`, or `both`. Anything else is a configuration error. */
export function resolveLiveAcceptanceModes(
  env: NodeJS.ProcessEnv = process.env,
): readonly LiveAcceptanceMode[] {
  const raw = env[LIVE_ACCEPTANCE_ENV.mode]?.trim().toLowerCase();
  if (!raw || raw === "managed") return ["managed"];
  if (raw === "byok") return ["byok"];
  if (raw === "both") return ["managed", "byok"];
  throw new LiveAcceptanceConfigurationError(
    `${LIVE_ACCEPTANCE_ENV.mode} must be one of: managed, byok, both.`,
  );
}

export function resolveLiveAcceptanceCallCap(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[LIVE_ACCEPTANCE_ENV.maxCalls]?.trim();
  if (!raw) return DEFAULT_LIVE_MAX_CALLS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new LiveAcceptanceConfigurationError(
      `${LIVE_ACCEPTANCE_ENV.maxCalls} must be a positive integer.`,
    );
  }
  return parsed;
}

/**
 * The case ids named by `AI_ACCEPTANCE_LIVE_CASES`, or `null` for the full run.
 *
 * Comma- and whitespace-separated. Exact case ids, as `expandScenarios()`
 * produces them: `cancellation-verified` is the canonical wording of that
 * scenario and `cancellation-verified#p3` is its third paraphrase — two
 * different cases, named separately, because they fail separately.
 */
export function resolveLiveAcceptanceCaseFilter(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] | null {
  const raw = env[LIVE_ACCEPTANCE_ENV.cases]?.trim();
  if (!raw) return null;
  const ids = raw
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (ids.length === 0) return null;
  return [...new Set(ids)];
}

/**
 * The cases to run, from the full expansion and the filter.
 *
 * An id that matches nothing is a **configuration error**, not an empty run: a
 * typo that silently certified zero cases and reported a green lane is exactly
 * the failure this filter would otherwise introduce.
 */
export function selectLiveAcceptanceCases<T extends { caseId: string }>(
  cases: readonly T[],
  filter: readonly string[] | null,
): readonly T[] {
  if (filter === null) return cases;
  const known = new Set(cases.map((item) => item.caseId));
  const unknown = filter.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new LiveAcceptanceConfigurationError(
      `${LIVE_ACCEPTANCE_ENV.cases} names ${unknown.length} case id(s) this suite does not ` +
        `define: ${unknown.join(", ")}. Case ids are exactly as expandScenarios() produces ` +
        "them, paraphrases included (for example: cancellation-verified#p3).",
    );
  }
  const wanted = new Set(filter);
  return cases.filter((item) => wanted.has(item.caseId));
}

export type LiveAcceptanceUsage = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostMicros: number;
};

/**
 * F-14 — what prompt caching actually saved on this run.
 *
 * Reported rather than estimated. The counterfactual is exact: every token
 * served from cache and every token written to cache would have been billed at
 * the full input rate had no breakpoint been set, so the comparison is between
 * what the run cost and what the identical run would have cost with caching
 * off. No model of hit rates, conversation shapes or briefing volatility is
 * involved — which is the point, because those are the parts an estimate gets
 * wrong.
 *
 * `cacheReadTokens === 0` on a run with a non-trivial prefix is the signal that
 * something is silently invalidating the cache (or that the prefix is under the
 * model's minimum), and is worth more than the savings figure itself.
 */
export type LiveAcceptanceCacheReport = {
  /** Tokens served from cache, at ~0.1x the input rate. */
  cacheReadTokens: number;
  /** Tokens written to cache, at 1.25x the input rate. */
  cacheWriteTokens: number;
  /** Tokens billed at the full input rate. */
  uncachedInputTokens: number;
  /** What the run's input actually cost, in micros. */
  inputCostMicros: number;
  /** What the same input would have cost with every breakpoint removed. */
  uncachedInputCostMicros: number;
  /** Saved micros; negative when the writes were never read back. */
  savedMicros: number;
  /** Saved fraction of the input bill, 0 when there was no input. */
  savedFraction: number;
  /** Share of input tokens that came from cache. */
  cacheHitFraction: number;
};

/** Builds the cache report for one lane's usage against its route's pricing. */
export function buildLiveCacheReport(
  usage: LiveAcceptanceUsage,
  pricing: CertifiedModelRoute["pricing"],
): LiveAcceptanceCacheReport {
  const total = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const inputCostMicros =
    costMicros(usage.inputTokens, pricing.inputMicrosPerMillion) +
    costMicros(usage.cacheReadTokens, pricing.cacheReadMicrosPerMillion) +
    costMicros(usage.cacheWriteTokens, pricing.cacheWriteMicrosPerMillion);
  const uncachedInputCostMicros = costMicros(total, pricing.inputMicrosPerMillion);
  const savedMicros = uncachedInputCostMicros - inputCostMicros;
  return {
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    uncachedInputTokens: usage.inputTokens,
    inputCostMicros,
    uncachedInputCostMicros,
    savedMicros,
    savedFraction: uncachedInputCostMicros === 0 ? 0 : savedMicros / uncachedInputCostMicros,
    cacheHitFraction: total === 0 ? 0 : usage.cacheReadTokens / total,
  };
}

type TokenCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Reads token counts from whatever shape the provider returned. The provider
 * protocol reports either flat numbers or a details object depending on the
 * model; the lane must not under-report a bill because of a shape mismatch.
 */
export function readLiveUsage(usage: unknown): TokenCounts {
  const value = (usage ?? {}) as Record<string, unknown>;
  const input = value.inputTokens as Record<string, unknown> | number | undefined;
  const output = value.outputTokens as Record<string, unknown> | number | undefined;
  if (typeof input === "object" && input !== null) {
    return {
      input: count(input.total) - count(input.cacheRead) - count(input.cacheWrite) > 0
        ? count(input.total) - count(input.cacheRead) - count(input.cacheWrite)
        : count(input.noCache),
      output: typeof output === "object" && output !== null ? count(output.total) : count(output),
      cacheRead: count(input.cacheRead),
      cacheWrite: count(input.cacheWrite),
    };
  }
  const details = (value.inputTokenDetails ?? {}) as Record<string, unknown>;
  const cacheRead = count(details.cacheReadTokens);
  const cacheWrite = count(details.cacheWriteTokens);
  const total = count(input);
  return {
    input: count(details.noCacheTokens) || Math.max(0, total - cacheRead - cacheWrite),
    output: count(output),
    cacheRead,
    cacheWrite,
  };
}

function costMicros(tokens: number, ratePerMillion: number): number {
  return tokens <= 0 ? 0 : Math.ceil((tokens * ratePerMillion) / 1_000_000);
}

function acceptanceProviderRequest(route: CertifiedModelRoute): AiProviderRequest {
  return {
    route,
    task: "patient_booking",
    surface: "patient_messaging",
    // Synthetic fixture identifiers. No real clinic or actor is referenced.
    clinicId: "00000000-0000-4000-8000-0000000ACCE01",
    actorId: "00000000-0000-4000-8000-0000000ACCE02",
    policyVersion: "p12-live-acceptance-v1",
  };
}

export type LiveAcceptanceModel = {
  mode: LiveAcceptanceMode;
  model: LanguageModelV3;
  route: CertifiedModelRoute;
  /**
   * F-14 — the prepared provider's own call options, carried through unchanged.
   *
   * Dropping these would have made the lane certify a configuration production
   * does not run: prompt caching is enabled by the transport through exactly
   * this value, so a lane that discarded it would report a cost the product
   * never pays and would leave the caching wiring unexercised.
   */
  providerOptions: AiProviderOptions;
  usage(): LiveAcceptanceUsage;
};

/**
 * Builds the live model for one credential mode, metered and capped.
 *
 * Both modes go through the SAME certified route and the SAME direct Anthropic
 * transport, differing only in whose key pays — which is exactly the property
 * the lane exists to certify.
 */
export function createLiveAcceptanceModel(input: {
  mode: LiveAcceptanceMode;
  env?: NodeJS.ProcessEnv;
  maxCalls?: number;
}): LiveAcceptanceModel {
  const env = input.env ?? process.env;
  const maxCalls = input.maxCalls ?? resolveLiveAcceptanceCallCap(env);
  const route = getCertifiedModelRoute(getTaskPolicy("patient_booking", "patient"));
  const request = acceptanceProviderRequest(route);

  let base: LanguageModelV3;
  let providerOptions: AiProviderOptions;
  if (input.mode === "managed") {
    const prepared = managedAnthropicProvider.prepare(request);
    base = prepared.model;
    providerOptions = prepared.providerOptions;
  } else {
    const secret = env[LIVE_ACCEPTANCE_ENV.byokKey]?.trim();
    if (!secret) {
      throw new LiveAcceptanceConfigurationError(
        `${LIVE_ACCEPTANCE_ENV.byokKey} is required for the live BYOK lane. It must be a synthetic acceptance credential, never a clinic's stored key.`,
      );
    }
    const prepared = prepareTenantProvider({
      mode: "byok_strict",
      secret,
      request,
      async onFallback() {
        // Unreachable in strict mode, and deliberately fatal if it ever is:
        // the BYOK lane must never spend ClinicFlow's managed credential.
        throw new LiveAcceptanceConfigurationError(
          "The live BYOK lane attempted a managed fallback. Strict BYOK must never do this.",
        );
      },
    });
    base = prepared.model;
    providerOptions = prepared.providerOptions;
  }

  const totals: LiveAcceptanceUsage = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostMicros: 0,
  };

  function record(usage: unknown): void {
    const tokens = readLiveUsage(usage);
    totals.inputTokens += tokens.input;
    totals.outputTokens += tokens.output;
    totals.cacheReadTokens += tokens.cacheRead;
    totals.cacheWriteTokens += tokens.cacheWrite;
    totals.estimatedCostMicros +=
      costMicros(tokens.input, route.pricing.inputMicrosPerMillion) +
      costMicros(tokens.output, route.pricing.outputMicrosPerMillion) +
      costMicros(tokens.cacheRead, route.pricing.cacheReadMicrosPerMillion) +
      costMicros(tokens.cacheWrite, route.pricing.cacheWriteMicrosPerMillion);
  }

  const meter: LanguageModelMiddleware = {
    specificationVersion: "v3",
    async wrapGenerate({ doGenerate }) {
      // Counted BEFORE the call: the cap bounds calls attempted, not calls that
      // happened to succeed.
      if (totals.calls >= maxCalls) throw new LiveAcceptanceCallCapError(maxCalls);
      totals.calls += 1;
      const result = await doGenerate();
      record((result as { usage?: unknown }).usage);
      return result;
    },
    async wrapStream({ doStream }) {
      if (totals.calls >= maxCalls) throw new LiveAcceptanceCallCapError(maxCalls);
      totals.calls += 1;
      return doStream();
    },
  };

  return {
    mode: input.mode,
    route,
    providerOptions,
    model: wrapLanguageModel({
      model: base,
      middleware: meter,
      providerId: "anthropic",
      modelId: route.providerModelId,
    }),
    usage: () => ({ ...totals }),
  };
}
