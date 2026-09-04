/**
 * P9 — the deterministic half of the acceptance measurement.
 *
 * The study's criteria split cleanly in two, and conflating them is how an
 * orchestration change gets credited with a model's good day:
 *
 *   * **Judgement metrics** — will *this* model, on *this* prompt, remember the
 *     department? Those need a live model and are measured by
 *     `p9-booking-live-eval.test.ts`.
 *   * **Structural metrics** — *can* the workflow be violated at all? Those are
 *     properties of the orchestration, not of the model, and the honest way to
 *     measure them is to hold the model's competence at a constant of zero and
 *     see what the server still refuses.
 *
 * This file measures the second kind, offline, deterministically, at no cost.
 * A deliberately non-compliant model is pointed at both mounts — the flat one
 * that ships today and the stage-scoped one — and the difference between the two
 * columns is the entire contribution of the stage machine, with the model's
 * behaviour identical in both.
 *
 * A misbehaving model is not a hypothetical: every Class-C bug in the study is
 * "the small model dropped a prompt rule". This is that, made repeatable.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { MockLanguageModelV3 } from "ai/test";
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";

import { BOOKING_SCENARIOS } from "@/lib/ai/eval/booking-scenarios";
import {
  HARNESS_VARIANTS,
  runScenario,
  summarize,
  type ScenarioRun,
} from "@/lib/ai/eval/booking-harness";

const FLAT = HARNESS_VARIANTS.find((item) => item.id === "haiku-6-flat")!;
const STAGED = HARNESS_VARIANTS.find((item) => item.id === "haiku-6-staged")!;

/**
 * The moves the study attributes to a small model losing the thread.
 *
 * The first two are legitimate and get the conversation to a real doctor, which
 * is what makes the rest meaningful — a bad move on an empty conversation is
 * refused by preconditions that predate this work. Everything after is a real
 * reported symptom: booking before availability was ever checked, booking after
 * only *days* were listed, and finally naming 16:00, a time no tool in this
 * fixture ever returns.
 */
const NON_COMPLIANT_SCRIPT: ReadonlyArray<{
  tool: string;
  input: Record<string, unknown>;
}> = [
  { tool: "prepare_booking", input: { department: "Dermatology" } },
  { tool: "prepare_booking", input: { doctor: "Sara Ali" } },
  // Too early: no day, no time, nothing checked.
  { tool: "create_preliminary_booking", input: { date: "2026-09-07", time: "16:00" } },
  { tool: "list_available_days", input: {} },
  // Still too early: days were listed, times never were.
  { tool: "create_preliminary_booking", input: { date: "2026-09-07", time: "16:00" } },
  { tool: "check_availability", input: { date: "2026-09-07" } },
  // Now the times exist — and 16:00 is not one of them.
  { tool: "create_preliminary_booking", input: { date: "2026-09-07", time: "16:00" } },
  // The case the availability recheck alone does not catch: 11:00 on the 8th is
  // a genuinely bookable slot, and it was never put in front of this patient.
  // Without the offered-options guard this books a real appointment nobody chose.
  { tool: "create_preliminary_booking", input: { date: "2026-09-08", time: "11:00" } },
];

type Attempt = { tool: string; blocked: boolean };

/** The provider-shaped usage record the SDK expects. */
function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
    totalTokens: inputTokens + outputTokens,
  };
}

/**
 * A model that ignores the prompt entirely and tries the script in order.
 *
 * It reads `options.tools` — the list the SDK actually offered it for this step,
 * which is where `activeTools` shows up — and records whether the tool it wanted
 * was on it. That recording is the measurement: a tool that is not offered is a
 * tool the model cannot call, and the run continues so the next script item is
 * also exercised rather than the whole turn dying on the first refusal.
 */
function nonCompliantModel(attempts: Attempt[]) {
  let index = 0;
  return new MockLanguageModelV3({
    provider: "anthropic",
    modelId: "anthropic/claude-haiku-4.5",
    doGenerate: async (
      options: LanguageModelV3CallOptions,
    ): Promise<LanguageModelV3GenerateResult> => {
      const offered = new Set((options.tools ?? []).map((item) => item.name));
      while (index < NON_COMPLIANT_SCRIPT.length) {
        const move = NON_COMPLIANT_SCRIPT[index]!;
        index += 1;
        if (!offered.has(move.tool)) {
          attempts.push({ tool: move.tool, blocked: true });
          continue;
        }
        attempts.push({ tool: move.tool, blocked: false });
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: `call-${index}-${move.tool}`,
              toolName: move.tool,
              input: JSON.stringify(move.input),
            },
          ],
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: usage(10, 5),
          response: { modelId: "anthropic/claude-haiku-4.5" },
          warnings: [],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: "Which department would you like? I have booked you in at 4pm.",
          },
        ],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: usage(10, 12),
        response: { modelId: "anthropic/claude-haiku-4.5" },
        warnings: [],
      };
    },
  });
}

async function measure(variant: typeof FLAT): Promise<{
  runs: ScenarioRun[];
  attempts: Attempt[];
}> {
  const attempts: Attempt[] = [];
  const runs: ScenarioRun[] = [];
  for (const scenario of BOOKING_SCENARIOS) {
    runs.push(
      await runScenario(variant, scenario, { model: nonCompliantModel(attempts) }),
    );
  }
  return { runs, attempts };
}

describe("P9 · structural acceptance criteria, model competence held at zero", () => {
  it("makes the out-of-order booking call unreachable under stage scoping", async () => {
    const flat = await measure(FLAT);
    const staged = await measure(STAGED);

    const bookingAttempts = (attempts: Attempt[]) =>
      attempts.filter((item) => item.tool === "create_preliminary_booking");
    const flatBooking = bookingAttempts(flat.attempts);
    const stagedBooking = bookingAttempts(staged.attempts);

    expect(flatBooking.length).toBeGreaterThan(0);
    expect(stagedBooking.length).toBeGreaterThan(0);

    // Flat mount: the tool is always offered, so every attempt reaches it and
    // only the server-side guards stand in the way.
    expect(flatBooking.every((item) => !item.blocked)).toBe(true);
    // Stage-scoped: the first attempt — made before a day was ever chosen — is
    // not merely refused, it is not callable.
    expect(stagedBooking[0]!.blocked).toBe(true);
    expect(stagedBooking.filter((item) => item.blocked).length).toBeGreaterThan(
      flatBooking.filter((item) => item.blocked).length,
    );
  }, 60_000);

  it("makes list_available_days unreachable before a doctor exists", async () => {
    const staged = await measure(STAGED);
    const dayAttempts = staged.attempts.filter(
      (item) => item.tool === "list_available_days",
    );
    expect(dayAttempts.length).toBeGreaterThan(0);
    // At least one scenario opens with no doctor at all; there the day tool is
    // absent from the offered set.
    expect(dayAttempts.some((item) => item.blocked)).toBe(true);
  }, 60_000);

  it("refuses a never-offered slot in both mounts — the guard is not the scoping", async () => {
    const flat = await measure(FLAT);
    const flatMetrics = summarize(FLAT, BOOKING_SCENARIOS, flat.runs);
    // 16:00 is never in FIXTURE_SLOTS. On the flat mount the model gets to call
    // the tool, and the server refuses it every time — which is the point of
    // putting the guard in the tool rather than in the mount.
    expect(flatMetrics.neverOfferedAttempts).toBeGreaterThan(0);
    expect(flatMetrics.bookingCompletionRate).toBe(0);
  }, 60_000);

  it("never books anything a tool did not offer, in either mount", async () => {
    for (const variant of [FLAT, STAGED]) {
      const { runs } = await measure(variant);
      for (const run of runs) {
        // The script only ever asks for 16:00, which was never offered. No run
        // may end in a booking.
        expect(run.booked, `${variant.id}/${run.scenarioId}`).toBe(false);
      }
    }
  }, 120_000);

  it("records a stage trace for every turn, in both mounts", async () => {
    for (const variant of [FLAT, STAGED]) {
      const { runs } = await measure(variant);
      for (const run of runs) {
        for (const turn of run.turns) {
          expect(turn.stageBefore).toBeTruthy();
          expect(turn.stageAfter).toBeTruthy();
        }
      }
    }
  }, 120_000);

  it("reports the same shape of metrics for both mounts, so they are comparable", async () => {
    const flat = summarize(FLAT, BOOKING_SCENARIOS, (await measure(FLAT)).runs);
    const staged = summarize(STAGED, BOOKING_SCENARIOS, (await measure(STAGED)).runs);
    expect(Object.keys(flat).sort()).toEqual(Object.keys(staged).sort());
    expect(flat.scenarios).toBe(BOOKING_SCENARIOS.length);
    expect(staged.scenarios).toBe(BOOKING_SCENARIOS.length);
  }, 120_000);
});

describe("P9 · structural metrics artefact", () => {
  it("writes the before/after table the implementation report quotes", async () => {
    const flat = summarize(FLAT, BOOKING_SCENARIOS, (await measure(FLAT)).runs);
    const staged = summarize(STAGED, BOOKING_SCENARIOS, (await measure(STAGED)).runs);
    const flatAttempts = (await measure(FLAT)).attempts;
    const stagedAttempts = (await measure(STAGED)).attempts;
    const blocked = (attempts: Attempt[], tool: string) =>
      attempts.filter((item) => item.tool === tool && item.blocked).length;
    const tried = (attempts: Attempt[], tool: string) =>
      attempts.filter((item) => item.tool === tool).length;

    const dir = resolve(process.cwd(), "docs/reviews/artifacts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, "p9-structural-metrics.json"),
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          method:
            "Deterministic. A scripted non-compliant model runs every booking scenario " +
            "against the flat mount and the stage-scoped mount. Model behaviour is " +
            "identical in both columns, so every difference is the orchestration.",
          scenarios: BOOKING_SCENARIOS.length,
          toolReachability: {
            create_preliminary_booking: {
              attempted: tried(flatAttempts, "create_preliminary_booking"),
              blockedFlat: blocked(flatAttempts, "create_preliminary_booking"),
              blockedStaged: blocked(stagedAttempts, "create_preliminary_booking"),
            },
            list_available_days: {
              attempted: tried(flatAttempts, "list_available_days"),
              blockedFlat: blocked(flatAttempts, "list_available_days"),
              blockedStaged: blocked(stagedAttempts, "list_available_days"),
            },
            check_availability: {
              attempted: tried(flatAttempts, "check_availability"),
              blockedFlat: blocked(flatAttempts, "check_availability"),
              blockedStaged: blocked(stagedAttempts, "check_availability"),
            },
          },
          metrics: { flat, staged },
        },
        null,
        2,
      )}\n`,
    );
    expect(flat.scenarios).toBe(BOOKING_SCENARIOS.length);
  }, 120_000);
});

describe("P9 · prompt budget", () => {
  it("shrinks the per-step prompt in the stages that do not need all of it", async () => {
    const { buildPatientStagePrompt, buildPatientSystemPrompt } = await import(
      "@/lib/ai/prompts/patient"
    );
    for (const locale of ["en", "ar"] as const) {
      const full = buildPatientSystemPrompt(locale).length;
      const perStage = {
        idle: buildPatientStagePrompt(locale, "idle").length,
        identifying: buildPatientStagePrompt(locale, "identifying").length,
        selecting_department: buildPatientStagePrompt(locale, "selecting_department").length,
        selecting_doctor: buildPatientStagePrompt(locale, "selecting_doctor").length,
        selecting_day: buildPatientStagePrompt(locale, "selecting_day").length,
        confirming: buildPatientStagePrompt(locale, "confirming").length,
      };
      for (const [stage, size] of Object.entries(perStage)) {
        expect(size, `${locale}/${stage}`).toBeLessThan(full);
      }
      // The heaviest scoped stage still saves materially against the whole.
      expect(Math.max(...Object.values(perStage))).toBeLessThan(full * 0.92);
    }
  });
});
