/**
 * F-15 — the prompt-cache configuration for the 129-case live certification.
 *
 * ## The measurement this file exists to explain
 *
 * The targeted six-case managed rerun billed:
 *
 *   calls 34 · uncached input 507 · output 2,624
 *   cache READ 10,420 · cache WRITE 310,732 · savedFraction −0.212
 *
 * Caching made that run ~21% more expensive on its input bill. Nearly every
 * call wrote a full-prefix entry at 1.25x and almost none read one back.
 *
 * ## Why, mechanically
 *
 * Anthropic renders a request as `tools` → `system` → `messages`, and a cache
 * entry is a **prefix match**: one changed byte at position N invalidates every
 * breakpoint at or after N. Two things change at or before the system block on
 * essentially every turn of a patient conversation, and both are asserted
 * below rather than asserted-by-comment:
 *
 *   1. **The tools block is not byte-stable across turns.** `prepareStep`
 *      returns a per-stage `activeTools`, and the AI SDK *filters the
 *      serialized tool array* by it (`ai/dist/index.mjs`: `filteredTools`).
 *      A booking that walks department → day → time → confirm therefore sends a
 *      different tool array at each stage — invalidating the prefix at the
 *      earliest possible position, position zero.
 *
 *   2. **The system block's tail changes every turn.** `patient-agent.ts`
 *      builds `system` as `buildPatientStagePrompt(locale, stage, style,
 *      briefing)`, appending the briefing after the stable sections. The
 *      briefing is a function of what the patient has settled so far, so turn
 *      2's system is not an extension of turn 1's — it is a different tail on
 *      the same head. A prefix match therefore gets as far as the head and
 *      stops, and the head is not where the breakpoint is.
 *
 * So the only prefix that ever repeats is the one *within a single turn*: a
 * tool-loop continuation, where tools and system are identical and only the
 * messages grow. That is exactly the ~10.4K of reads observed — on the order of
 * one call's prefix, against 34 calls' worth of writes.
 *
 * The breakpoint that WOULD have given cross-conversation reuse is the one on
 * the tool block, and on `claude-haiku-4-5` it is inert: the patient tool block
 * is ~1.8K tokens against a 4096-token floor. That is measured in
 * `tests/unit/ai/prompt-caching.test.ts`, not assumed here.
 *
 * ## The decision, and why it is not "turn caching off"
 *
 * Disabling caching for the certification is genuinely cheaper — the numbers
 * are computed below, and it is under a dollar. It is still the wrong trade:
 * the live lane exists to certify the configuration production actually sends,
 * and F-14 deliberately threads the prepared provider's own `providerOptions`
 * through for that reason. A lane that stripped them would report a cost the
 * product never pays and would leave the caching wiring uncertified — buying a
 * ~$1 saving with the one property the run is being paid for.
 *
 * The negative economics are a **production** finding, and the fix for them
 * (splitting the system prompt into a stable block and a volatile briefing
 * block, with the breakpoint between) is the optimization `prompt-cache.ts`
 * explicitly declines to make without a billable measurement. The 129-case run
 * is that measurement. Changing the thing being measured, to make the
 * measurement cheaper, would be the one move that wastes it.
 *
 * The bound below is what keeps this a decision rather than a shrug: if the
 * route, prefix or hit rate ever moves such that caching costs materially more
 * than it does today, this test fails and the decision is re-taken.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildLiveCacheReport } from "@/lib/ai/acceptance/live-provider";
import { getCertifiedModelRoute, getTaskPolicy } from "@/lib/ai/platform/registry";
import {
  PROMPT_CACHE_TTL,
  minimumCacheablePrefixTokens,
  promptCacheProviderOptions,
} from "@/lib/ai/platform/prompt-cache";
import { allowedToolsForStage } from "@/lib/ai/booking-stage";
import { buildPatientStagePrompt } from "@/lib/ai/prompts/patient";

const ROUTE = getCertifiedModelRoute(getTaskPolicy("patient_booking", "patient"));

/** The targeted six-case managed rerun, exactly as its artifact recorded it. */
const MEASURED = {
  calls: 34,
  inputTokens: 507,
  outputTokens: 2_624,
  cacheReadTokens: 10_420,
  cacheWriteTokens: 310_732,
  estimatedCostMicros: 403_099,
} as const;

const SELECTED_CASES = 6;
const TOTAL_CASES = 129;

describe("the measurement the decision rests on", () => {
  it("reproduces the six-case run's negative saving from its own recorded tokens", () => {
    const report = buildLiveCacheReport({ ...MEASURED }, ROUTE.pricing);
    // Pinned to the artifact. If pricing or the report's arithmetic moves, the
    // diagnosis above stops being about the run it claims to be about.
    expect(report.inputCostMicros).toBe(389_964);
    expect(report.uncachedInputCostMicros).toBe(321_659);
    expect(report.savedMicros).toBe(-68_305);
    expect(report.savedFraction).toBeCloseTo(-0.2124, 4);
    // The number that IS the diagnosis: almost nothing was read back.
    expect(report.cacheHitFraction).toBeLessThan(0.05);
  });

  it("shows the writes, not the hit rate, as the thing being paid for", () => {
    // ~1 call's worth of reads against 34 calls' worth of writes. Stated as a
    // ratio so it survives a re-measurement that changes the absolute sizes.
    const perCallWrite = MEASURED.cacheWriteTokens / MEASURED.calls;
    expect(perCallWrite).toBeGreaterThan(4_000);
    expect(MEASURED.cacheReadTokens / perCallWrite).toBeLessThan(2);
  });
});

describe("why the prefix cannot be reused across turns", () => {
  it("sends a different tool array at different booking stages", () => {
    // Position zero of the request. If this ever became constant, cross-turn
    // reuse would become possible and the decision below would be re-taken.
    const mounted = [
      "list_clinic_departments",
      "list_doctors",
      "list_available_days",
      "list_available_slots",
      "create_preliminary_booking",
      "answer_faq",
    ];
    const day = allowedToolsForStage("selecting_day", mounted);
    const confirming = allowedToolsForStage("confirming", mounted);
    expect(day).not.toEqual(confirming);
    // And the narrowing is real, not cosmetic: the write tool is simply absent
    // until the booking has a day and a time.
    expect(day).not.toContain("create_preliminary_booking");
  });

  it("diverges the system block between two turns with different briefings", () => {
    // The briefing is APPENDED to the stage prompt, so the stable sections are
    // a common prefix and the divergence sits at the tail. That is the precise
    // shape of the problem: turn 2's system is not an extension of turn 1's,
    // it is a *different* tail on the same head, so a prefix match that got as
    // far as the head stops at the briefing.
    const stable = buildPatientStagePrompt("ar", "selecting_day", undefined, null);
    const turnOne = buildPatientStagePrompt(
      "ar",
      "selecting_day",
      undefined,
      "ما استقر عليه الحوار بالفعل: القسم.",
    );
    const turnTwo = buildPatientStagePrompt(
      "ar",
      "selecting_day",
      undefined,
      "ما استقر عليه الحوار بالفعل: القسم، الطبيب.",
    );

    // Both share the stable head...
    expect(turnOne.startsWith(stable)).toBe(true);
    expect(turnTwo.startsWith(stable)).toBe(true);
    // ...and neither contains the other, so no cross-turn prefix match survives
    // past it.
    expect(turnOne).not.toBe(turnTwo);
    expect(turnTwo.startsWith(turnOne)).toBe(false);
    expect(turnOne.startsWith(turnTwo)).toBe(false);

    // And this is exactly why the deferred fix is the shape it is: the stable
    // head is substantial and byte-identical across turns, so a breakpoint
    // placed BETWEEN the head and the briefing would be readable where the
    // current end-of-request breakpoint is not. Measuring whether it clears
    // Haiku's 4096-token floor is part of what the full run is being paid for.
    expect(stable.length).toBeGreaterThan(0);
    expect(turnOne.slice(stable.length).length).toBeGreaterThan(0);
  });

  it("cannot fall back to the tool-block breakpoint on this route", () => {
    // The breakpoint that would have survived a changing system block is the
    // one on the tools, and Haiku 4.5's floor is too high for it to bind. The
    // block's measured size is asserted in `prompt-caching.test.ts`.
    expect(ROUTE.providerModelId).toBe("claude-haiku-4-5");
    expect(minimumCacheablePrefixTokens(ROUTE)).toBe(4096);
  });
});

describe("the configuration chosen for the 129-case certification", () => {
  it("keeps caching enabled, unchanged, on the production provider options", () => {
    // The lane certifies what production sends. This is the assertion that the
    // certification run is not quietly a different configuration.
    expect(promptCacheProviderOptions(ROUTE.transport)).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: PROMPT_CACHE_TTL } },
    });
    expect(PROMPT_CACHE_TTL).toBe("5m");
  });

  it("keeps the 5m TTL, because a 1h TTL is strictly worse at this hit rate", () => {
    // A 1h entry costs 2x to write instead of 1.25x. With reads this rare, the
    // longer TTL buys nothing and doubles the premium — so the cheap TTL is the
    // right one, and this is the arithmetic rather than the intuition.
    const write5m = MEASURED.cacheWriteTokens * 1.25;
    const write1h = MEASURED.cacheWriteTokens * 2;
    expect(write1h).toBeGreaterThan(write5m);
    // Even granting a 1h TTL a generous tenfold improvement in reads, it does
    // not overtake: the writes dominate by two orders of magnitude.
    const optimistic1hReads = MEASURED.cacheReadTokens * 10;
    expect(write1h - optimistic1hReads * 0.9).toBeGreaterThan(write5m);
  });

  it("bounds what keeping caching costs for the full run", () => {
    // Projected from the measured per-case rates. Not a promise about the bill:
    // a bound, so that a route or prefix change that makes caching materially
    // worse fails here instead of surfacing as a surprise invoice.
    const scale = TOTAL_CASES / SELECTED_CASES;
    const projected = {
      calls: Math.round(MEASURED.calls * scale),
      inputTokens: Math.round(MEASURED.inputTokens * scale),
      outputTokens: Math.round(MEASURED.outputTokens * scale),
      cacheReadTokens: Math.round(MEASURED.cacheReadTokens * scale),
      cacheWriteTokens: Math.round(MEASURED.cacheWriteTokens * scale),
      estimatedCostMicros: 0,
    };
    const report = buildLiveCacheReport(projected, ROUTE.pricing);
    const outputMicros = Math.ceil(
      (projected.outputTokens * ROUTE.pricing.outputMicrosPerMillion) / 1_000_000,
    );

    const withCaching = report.inputCostMicros + outputMicros;
    const withoutCaching = report.uncachedInputCostMicros + outputMicros;

    // Caching costs more, and the premium is the thing being bounded.
    expect(withCaching).toBeGreaterThan(withoutCaching);
    // Under $12 either way, and the premium under $2. Certifying the real
    // production configuration is worth that; if it ever stops being worth it,
    // this fails.
    expect(withCaching).toBeLessThan(12_000_000);
    expect(withCaching - withoutCaching).toBeLessThan(2_000_000);
  });

  it("still reports the counterfactual, so the full run measures the fix", () => {
    // The run is being paid for anyway. The reason to keep caching ON is that
    // the artifact then carries the data that decides whether the deferred
    // system-prompt split is worth taking — which a caching-off run cannot.
    const report = buildLiveCacheReport({ ...MEASURED }, ROUTE.pricing);
    for (const key of [
      "cacheReadTokens",
      "cacheWriteTokens",
      "uncachedInputTokens",
      "inputCostMicros",
      "uncachedInputCostMicros",
      "savedMicros",
      "savedFraction",
      "cacheHitFraction",
    ] as const) {
      expect(typeof report[key]).toBe("number");
    }
  });
});
