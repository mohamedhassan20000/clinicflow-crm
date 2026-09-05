/**
 * Patient Assistant — LIVE production acceptance.
 *
 * This is the real thing: actual Anthropic calls, through the same certified
 * route, the same prompts, the same tools, the same stage machine and the same
 * graders as the deterministic lanes. It certifies the two shipped credential
 * paths SEPARATELY:
 *
 *   A. ClinicFlow Managed Anthropic Direct  (the platform's own key)
 *   B. Clinic Anthropic BYOK Direct         (a synthetic acceptance key)
 *
 * It is skipped unless `AI_ACCEPTANCE_LIVE=1`, so an ordinary test run — CI
 * included — never spends money. The call cap in `live-provider.ts` bounds the
 * spend even when it is enabled.
 *
 * Only synthetic fixtures are used. The scenarios run against
 * `lib/ai/acceptance/fixture-clinic.ts`; no clinic, patient, or stored
 * credential is read.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { expandScenarios } from "@/lib/ai/acceptance/scenarios";
import { runConversation } from "@/lib/ai/acceptance/runner";
import { gradeCase, summarize, type CaseResult } from "@/lib/ai/acceptance/graders";
import { buildCaseDiagnostic, type CaseDiagnostic } from "@/lib/ai/acceptance/diagnostics";
import {
  minimumCacheablePrefixTokens,
  routeSupportsPromptCaching,
} from "@/lib/ai/platform/prompt-cache";
import {
  buildLiveCacheReport,
  createLiveAcceptanceModel,
  liveAcceptanceEnabled,
  resolveLiveAcceptanceCaseFilter,
  resolveLiveAcceptanceModes,
  selectLiveAcceptanceCases,
  type LiveAcceptanceMode,
} from "@/lib/ai/acceptance/live-provider";

const OUT_DIR = resolve(process.cwd(), "docs/reviews/artifacts");
const OUT_JSON = resolve(OUT_DIR, "patient-assistant-live-acceptance.json");

const LIVE = liveAcceptanceEnabled();
const MODES: readonly LiveAcceptanceMode[] = LIVE ? resolveLiveAcceptanceModes() : [];
/**
 * F-13 — the targeted regression lane.
 *
 * `AI_ACCEPTANCE_LIVE_CASES=incomplete-intake,doctors-roster#p1` runs those two
 * cases and nothing else, through this exact runner, these exact scenarios and
 * these exact graders. It selects; it does not substitute, relax or replace
 * anything. `partial` is stamped on the artifact so a targeted pass is never
 * mistaken for a certification.
 */
const CASE_FILTER = LIVE ? resolveLiveAcceptanceCaseFilter() : null;
const SELECTED = selectLiveAcceptanceCases(expandScenarios(), CASE_FILTER);

async function runLiveLane(mode: LiveAcceptanceMode) {
  const live = createLiveAcceptanceModel({ mode });
  const results: CaseResult[] = [];
  const diagnostics: CaseDiagnostic[] = [];
  for (const item of SELECTED) {
    const { scenario } = item;
    const run = await runConversation(item.caseId, item.turns, {
      model: live.model,
      // F-14 — the prepared provider's own call options and transport, so the
      // lane certifies the configuration production actually sends (prompt
      // caching included) rather than a cheaper-looking imitation of it.
      providerOptions: live.providerOptions as never,
      transport: live.route.transport,
      locale: scenario.locale,
      patient: scenario.patient,
      failures: scenario.failures ?? {},
      hang: scenario.hang ?? [],
      duplicateIndexes: scenario.duplicateIndexes ?? [],
      humanTakeoverAfter: scenario.humanTakeoverAfter ?? null,
    });
    // Graded on the `flow` lane: a real model is being measured for whether it
    // can carry each declared flow, which is the same question the compliant
    // persona answers offline. The containment gates are asserted separately
    // and are model-independent by construction.
    const result = gradeCase({
      caseId: item.caseId,
      paraphraseIndex: item.paraphraseIndex,
      scenario,
      run,
      lane: "flow",
    });
    results.push(result);
    // F-12 — a failed case persists enough to be diagnosed without paying for
    // the run twice. Synthetic fixtures only; see `diagnostics.ts` for the
    // guard that enforces it and for why this is not production logging.
    if (!result.passed) {
      diagnostics.push(buildCaseDiagnostic({ scenario, run, result }));
    }
  }
  const usage = live.usage();
  return {
    summary: summarize(`live-${mode}`, results),
    usage,
    // F-14 — what prompt caching actually saved, measured against the exact
    // counterfactual rather than modelled.
    cache: buildLiveCacheReport(usage, live.route.pricing),
    model: {
      alias: live.route.alias,
      providerModelId: live.route.providerModelId,
      transport: "anthropic_direct",
      promptCaching: {
        enabled: routeSupportsPromptCaching(live.route),
        minimumCacheablePrefixTokens: minimumCacheablePrefixTokens(live.route),
        providerOptions: live.providerOptions,
      },
    },
    failures: results
      .filter((result) => !result.passed)
      .map((result) => ({
        caseId: result.caseId,
        category: result.category,
        critical: result.criticalFailures.map((check) => ({ id: check.id, detail: check.detail })),
        nonCritical: result.nonCriticalFailures.map((check) => ({
          id: check.id,
          detail: check.detail,
        })),
      })),
    diagnostics,
  };
}

describe.skipIf(!LIVE)("Patient Assistant LIVE acceptance", () => {
  const artifact: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    cases: SELECTED.length,
    totalCases: expandScenarios().length,
    modes: MODES,
    // A targeted rerun proves the named cases and nothing else. Stated in the
    // artifact so no reader has to infer it from a case count.
    partial: CASE_FILTER !== null,
    ...(CASE_FILTER ? { selectedCases: [...CASE_FILTER] } : {}),
  };

  for (const mode of MODES) {
    it(
      `certifies ${mode} Anthropic direct against the production acceptance matrix`,
      async () => {
        const lane = await runLiveLane(mode);
        artifact[mode] = lane;
        // The lane must actually have called a provider — a silently mocked or
        // short-circuited run must not be able to report a pass.
        expect(lane.usage.calls).toBeGreaterThan(0);
        expect(lane.summary.cases).toBe(SELECTED.length);
        // Every failure carries its own autopsy, so a billable run never has to
        // be repeated merely to be understood.
        expect(lane.diagnostics.length).toBe(lane.failures.length);
      },
      // Real network calls across the whole matrix.
      60 * 60_000,
    );
  }

  it("writes the live acceptance artifact", () => {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    for (const mode of MODES) expect(artifact[mode]).toBeDefined();
  });
});

describe.skipIf(LIVE)("live lane is off by default", () => {
  it("does not run, and reports why", () => {
    // A green ordinary test run is NOT evidence that the live lane passed. This
    // assertion exists so that fact is stated by the suite rather than assumed.
    expect(liveAcceptanceEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(MODES).toEqual([]);
    // And with the lane off, the case filter is not consulted at all: a stray
    // AI_ACCEPTANCE_LIVE_CASES in a shell must not narrow anything.
    expect(CASE_FILTER).toBeNull();
    expect(SELECTED.length).toBe(expandScenarios().length);
  });
});
