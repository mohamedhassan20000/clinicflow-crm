import "server-only";

import type { Tool } from "ai";

import type {
  AiProviderOptions,
  AiTransport,
  CertifiedModelRoute,
} from "@/lib/ai/platform/types";

/**
 * F-14 — Anthropic prompt caching, decided by the transport rather than by the
 * orchestration.
 *
 * ## What is being paid for today
 *
 * The managed live acceptance run billed 381 provider calls and **3,210,764
 * input tokens** for 27,731 output tokens — an input:output ratio of 116:1. A
 * patient turn is a short WhatsApp message answered from a ~10 KB certified
 * system prompt, a stage prompt, a turn briefing and sixteen fully-described
 * tools. Almost none of what is paid for on each call is new.
 *
 * That is the exact shape prompt caching exists for: a large, byte-stable
 * prefix followed by a small volatile suffix.
 *
 * ## Why this lives in `platform/` and not in the agent
 *
 * Caching is a property of **who is being called**, not of what the assistant
 * is doing. `patient-agent.ts` and `staff-agent.ts` must not learn the word
 * "anthropic": they already receive `providerOptions` from the prepared
 * provider and pass them through opaquely, and this module extends that same
 * seam to tool definitions. Point a task at the Vercel AI Gateway transport and
 * every function here returns nothing, with no change to any agent.
 *
 * ## The two breakpoints, and why each one is where it is
 *
 * Anthropic renders a request as `tools` → `system` → `messages`, and a cache
 * entry is a **prefix match**: one changed byte at position N invalidates every
 * breakpoint at or after N.
 *
 *   1. **Top-level automatic placement**, via the call's `providerOptions`.
 *      Anthropic places this on the last cacheable block, so each request
 *      writes an entry covering tools + system + the conversation so far, and a
 *      later request whose prefix matches reads it. This is the breakpoint that
 *      does the work on the current route, and it is structural-change-free:
 *      the request body is byte-for-byte what it was, plus one directive.
 *
 *   2. **The last tool definition.** Marked because the tool block is the one
 *      region identical across *different conversations*, so on a route whose
 *      minimum prefix it clears it is read by every thread rather than only by
 *      the thread that wrote it.
 *
 *      **On `claude-haiku-4-5` today this breakpoint is inert, and that is
 *      stated rather than hidden.** The measured patient tool block is ~7.3 KB
 *      of names, descriptions and JSON schemas — on the order of 1.8K tokens —
 *      against a 4096-token minimum, so Anthropic silently declines to create
 *      the entry. It costs nothing (an under-minimum marker is ignored, not
 *      charged) and it starts paying the moment the route moves to a model with
 *      a lower floor — Sonnet 5 at 1024, Claude Opus 5 at 512. The size
 *      relationship is asserted in `tests/unit/ai/prompt-caching.test.ts` so
 *      this comment cannot quietly become false.
 *
 * Two client-side breakpoints, well inside Anthropic's limit of four.
 *
 * ## The optimization deliberately NOT taken
 *
 * The largest remaining win would be splitting the system prompt into a stable
 * block (`buildPatientStagePrompt` without the briefing — a pure function of
 * locale, stage and style, and therefore shared by every conversation sitting
 * at that stage) and a volatile block (the turn briefing and the authority
 * line), with the breakpoint between them. `prepareStep` accepts
 * `SystemModelMessage[]`, so it is expressible.
 *
 * It is not done here because it changes the *structure* of the system field
 * from one text block to two, and whether Anthropic renders two system blocks
 * byte-identically to their concatenation is not something this repository can
 * establish without a billable call. "Do not guess" outranks the saving. The
 * targeted live rerun reports `cacheReadTokens` / `cacheWriteTokens` in its
 * artifact, so the value of taking it can be measured from a run that is
 * happening anyway rather than estimated.
 *
 * ## Why this cannot change what the model does
 *
 * `cache_control` is a caching directive attached to content that is sent
 * either way. It adds no instruction, removes none, reorders nothing, and
 * changes no sampling parameter: the bytes the model reads are identical with
 * and without it. Nothing in this module touches the mount, the stage table,
 * the authority pin, a tool's behaviour or any gate. The only observable
 * differences are `usage.cache_read_input_tokens` / `cache_creation_input_tokens`
 * and the bill — both of which the cost meter already models
 * (`AiTokenPricing.cacheRead/cacheWrite`).
 *
 * ## The one thing that can make this a no-op
 *
 * Anthropic's **minimum cacheable prefix is model-dependent**, and for
 * `claude-haiku-4-5` — the certified patient route — it is **4096 tokens**,
 * which is unusually high. A shorter prefix is not an error: it silently caches
 * nothing and reports `cache_creation_input_tokens: 0`. The patient prefix is
 * comfortably over that (the live run averaged ~8.4K input tokens per call),
 * but the number is recorded here so the assumption is auditable rather than
 * folklore, and so a future route swap can be checked against it.
 */

/** Transports whose provider implements Anthropic's `cache_control`. */
const CACHING_TRANSPORTS: readonly AiTransport[] = [
  "anthropic_direct",
  "anthropic_direct_hybrid",
];

/**
 * Anthropic's minimum cacheable prefix, in tokens, by native model id.
 *
 * Below the minimum a `cache_control` marker is ignored silently — no error, no
 * warning, just no cache entry. Recorded per model because the value is **not**
 * monotonic across generations and cannot be inferred from the model's tier.
 */
export const ANTHROPIC_MIN_CACHEABLE_PREFIX_TOKENS: Readonly<Record<string, number>> = {
  "claude-haiku-4-5": 4096,
  "claude-sonnet-4-5": 1024,
  "claude-sonnet-5": 1024,
  "claude-opus-4-5": 4096,
  "claude-opus-5": 512,
};

/**
 * The TTL this platform uses.
 *
 * `5m` deliberately, not `1h`. A 5-minute entry costs 1.25× to write and breaks
 * even on the second read; a 1-hour entry costs 2× and needs a third. Patient
 * turns arrive in bursts of seconds and a tool loop re-reads within one turn,
 * so the short TTL is both cheaper to write and long enough to be read. Raising
 * it is a pricing decision, not a code decision, which is why it is a named
 * constant rather than a parameter.
 */
export const PROMPT_CACHE_TTL = "5m" as const;

/** Does a turn on this transport support prompt caching? */
export function transportSupportsPromptCaching(transport: AiTransport): boolean {
  return CACHING_TRANSPORTS.includes(transport);
}

/** Does a turn on this certified route support prompt caching? */
export function routeSupportsPromptCaching(route: CertifiedModelRoute): boolean {
  return route.provider === "anthropic" && transportSupportsPromptCaching(route.transport);
}

/**
 * The minimum prefix this route must exceed for a breakpoint to do anything,
 * or `null` when the model is not in the table.
 *
 * `null` is "unknown", not "no minimum": a caller reporting on caching should
 * say so rather than imply the marker is guaranteed to bind.
 */
export function minimumCacheablePrefixTokens(
  route: CertifiedModelRoute,
): number | null {
  return ANTHROPIC_MIN_CACHEABLE_PREFIX_TOKENS[route.providerModelId] ?? null;
}

/**
 * The call-level provider options that enable automatic breakpoint placement,
 * or `{}` on a transport that does not support caching.
 *
 * Returned as the whole `providerOptions` value for a prepared provider, so a
 * provider that has other options merges rather than replaces.
 */
export function promptCacheProviderOptions(
  transport: AiTransport,
): AiProviderOptions {
  if (!transportSupportsPromptCaching(transport)) return {};
  return { anthropic: { cacheControl: { type: "ephemeral", ttl: PROMPT_CACHE_TTL } } };
}

/**
 * The same marker, for a single tool definition.
 *
 * Separate from the call-level options because it is attached to a different
 * thing: `Tool.providerOptions` travels with that tool into the provider's tool
 * serializer, where it becomes `cache_control` on that tool's entry.
 */
export function promptCacheToolProviderOptions(
  transport: AiTransport,
): Tool["providerOptions"] | null {
  if (!transportSupportsPromptCaching(transport)) return null;
  return { anthropic: { cacheControl: { type: "ephemeral", ttl: PROMPT_CACHE_TTL } } };
}

/**
 * Marks the tool block as cacheable, by annotating the last mounted tool.
 *
 * ## The ordering invariant
 *
 * A breakpoint caches the prefix **up to and including** the block it sits on,
 * so it has to sit on a tool that is actually sent. The mount is filtered per
 * stage by `allowedToolsForStage`, so the annotated tool must be one the filter
 * can never remove — otherwise the marker vanishes on exactly the stages that
 * make the most calls.
 *
 * `buildPatientTools` ends with the FAQ block, every member of which is in
 * `STAGE_INDEPENDENT_TOOLS`, so the last mounted tool is always active in both
 * patient task classes. That is a real invariant of the mount and not a
 * coincidence to be discovered later: it is asserted in
 * `tests/unit/ai/prompt-caching.test.ts`, and `alwaysActive` lets a caller
 * state it explicitly rather than trust the ordering.
 *
 * Returns a NEW object. The input tools are never mutated, so a caller that
 * mounts the same tool objects twice cannot accumulate markers.
 */
export function annotateToolsForPromptCache<T extends Record<string, Tool>>(
  tools: T,
  transport: AiTransport,
  options: { alwaysActive?: readonly string[] } = {},
): T {
  const marker = promptCacheToolProviderOptions(transport);
  if (marker === null) return tools;
  const names = Object.keys(tools);
  if (names.length === 0) return tools;

  const alwaysActive = options.alwaysActive;
  // The last mounted tool that is guaranteed to survive stage filtering. With
  // no allow-list supplied, the last mounted tool — which is the caller's
  // assertion that it is always sent.
  const target = alwaysActive
    ? [...names].reverse().find((name) => alwaysActive.includes(name)) ?? null
    : names[names.length - 1]!;
  if (target === null) return tools;

  const annotated: Record<string, Tool> = { ...tools };
  const tool = annotated[target]!;
  annotated[target] = {
    ...tool,
    providerOptions: { ...(tool.providerOptions ?? {}), ...marker },
  } as Tool;
  return annotated as T;
}
