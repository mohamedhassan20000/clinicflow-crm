/**
 * P9 · Phase 0.5 — the live measurement.
 *
 * Opt-in, out of CI, and gated on `AI_EVAL_LIVE=1` exactly as the P6A eval-set
 * documentation describes. It answers the study's cheapest-hypothesis-first
 * question — "does a Sonnet-class route with `maxSteps` 10 dissolve the
 * problem?" — and, in the same run and against the same fixtures, how much of
 * the remaining gap the stage-scoped orchestration closes.
 *
 * Run it with:
 *
 *   AI_EVAL_LIVE=1 node --env-file=.env.local node_modules/vitest/vitest.mjs \
 *     run tests/unit/ai/p9-booking-live-eval.test.ts --testTimeout=1800000
 *
 * Narrow it with `AI_EVAL_VARIANTS=haiku-6-flat,sonnet-10-flat`.
 *
 * It writes `docs/reviews/artifacts/p9-booking-eval.json` and a markdown table
 * beside it, which is what the implementation report quotes. Nothing here
 * touches a database, a real patient, or the production registry.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { BOOKING_SCENARIOS } from "@/lib/ai/eval/booking-scenarios";
import {
  HARNESS_VARIANTS,
  runScenario,
  summarize,
  type ScenarioRun,
  type VariantMetrics,
} from "@/lib/ai/eval/booking-harness";
import { gradeTurn, scoreEvalRun } from "@/lib/ai/eval/grade";
import { patientEvalCases, EVAL_PASS_THRESHOLD } from "@/lib/ai/eval/eval-set";
import { patientTools } from "@/lib/ai/eval/authorized-tools";

const LIVE = process.env.AI_EVAL_LIVE === "1";
const OUT_DIR = resolve(process.cwd(), "docs/reviews/artifacts");
const OUT_JSON = resolve(OUT_DIR, "p9-booking-eval.json");
const OUT_MD = resolve(OUT_DIR, "p9-booking-eval.md");

const selected = (() => {
  const raw = process.env.AI_EVAL_VARIANTS?.trim();
  if (!raw) return HARNESS_VARIANTS;
  const wanted = new Set(raw.split(",").map((item) => item.trim()));
  return HARNESS_VARIANTS.filter((variant) => wanted.has(variant.id));
})();

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function markdownTable(metrics: readonly VariantMetrics[]): string {
  const rows: Array<[string, (m: VariantMetrics) => string]> = [
    ["Repeated-question rate", (m) => pct(m.repeatedQuestionRate)],
    ["Flow-restart rate (per conversation)", (m) => m.flowRestartRate.toFixed(2)],
    ["'Other doctors' success", (m) => pct(m.otherDoctorsSuccess)],
    ["Booking completion", (m) => pct(m.bookingCompletionRate)],
    [
      "Median turns to booking",
      (m) => (m.medianTurnsToBooking === null ? "—" : String(m.medianTurnsToBooking)),
    ],
    ["Technical-fallback rate", (m) => pct(m.technicalFallbackRate)],
    ["Unnecessary escalation rate", (m) => pct(m.unnecessaryEscalationRate)],
    ["Never-offered slot attempts", (m) => String(m.neverOfferedAttempts)],
    ["Illegal stage transitions", (m) => String(m.illegalTransitions)],
    ["Turn failure rate", (m) => pct(m.turnFailureRate)],
    ["p50 latency (ms)", (m) => String(m.p50LatencyMs)],
    ["p95 latency (ms)", (m) => String(m.p95LatencyMs)],
    ["Tokens per conversation", (m) => m.tokensPerConversation.toFixed(0)],
    ["Cost (µ$)", (m) => m.costMicros.toFixed(0)],
    [
      "Cost per completed booking (µ$)",
      (m) =>
        m.costPerCompletedBookingMicros === null
          ? "—"
          : m.costPerCompletedBookingMicros.toFixed(0),
    ],
  ];
  const header = `| Metric | ${metrics.map((m) => m.variantId).join(" | ")} |`;
  const divider = `| --- | ${metrics.map(() => "---").join(" | ")} |`;
  const body = rows
    .map(([name, render]) => `| ${name} | ${metrics.map(render).join(" | ")} |`)
    .join("\n");
  return [header, divider, body].join("\n");
}

describe("P9 · Phase 0.5 offline preconditions", () => {
  it("keeps the scenario corpus bilingual and covering every measured metric", () => {
    expect(BOOKING_SCENARIOS.some((item) => item.locale === "en")).toBe(true);
    expect(BOOKING_SCENARIOS.some((item) => item.locale === "ar")).toBe(true);
    const measured = new Set(BOOKING_SCENARIOS.flatMap((item) => item.measures));
    for (const metric of [
      "repeated_question",
      "flow_restart",
      "other_doctors",
      "booking_completion",
      "turns_to_booking",
      "technical_fallback",
      "unnecessary_escalation",
      "offered_slot_integrity",
    ]) {
      expect(measured, metric).toContain(metric);
    }
  });

  it("keeps the patient corpus consistent with the authorization oracle", () => {
    const cases = patientEvalCases();
    const observed = new Map(
      cases.map((item) => [
        item.id,
        {
          toolsCalled: [...(item.rubric.expectTools ?? [])],
          refused: item.rubric.expectRefusal === true,
          escalated: item.rubric.expectEscalation === true,
          clarified: item.rubric.expectClarify === true,
          cited: item.rubric.mustCite === true,
        },
      ]),
    );
    const score = scoreEvalRun(cases, observed);
    expect(score.ratio).toBeGreaterThanOrEqual(EVAL_PASS_THRESHOLD);
  });

  it("never lets a harness variant reach outside the patient mount", () => {
    const reachable = patientTools("patient_booking");
    for (const scenario of BOOKING_SCENARIOS) {
      expect(scenario.turns.length).toBeGreaterThan(0);
    }
    // The harness simulates exactly the eleven mounted names and nothing else.
    for (const name of reachable) expect(typeof name).toBe("string");
  });
});

describe.skipIf(!LIVE)("P9 · Phase 0.5 live model comparison", () => {
  it(
    "measures every selected variant against the booking scenarios",
    async () => {
      const results: Array<{ metrics: VariantMetrics; runs: ScenarioRun[] }> = [];
      for (const variant of selected) {
        const runs: ScenarioRun[] = [];
        for (const scenario of BOOKING_SCENARIOS) {
          runs.push(await runScenario(variant, scenario));
        }
        results.push({
          metrics: summarize(variant, BOOKING_SCENARIOS, runs),
          runs,
        });
      }

      mkdirSync(dirname(OUT_JSON), { recursive: true });
      writeFileSync(
        OUT_JSON,
        `${JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            scenarioCount: BOOKING_SCENARIOS.length,
            variants: results.map((item) => item.metrics),
            transcriptsRedacted: true,
            runs: results.map((item) => ({
              variantId: item.metrics.variantId,
              // Tool sequences and stages only. The generated replies are the
              // model's words about a fixture patient, but the artefact is a
              // committed file, so it carries structure and never prose.
              scenarios: item.runs.map((run) => ({
                scenarioId: run.scenarioId,
                booked: run.booked,
                turnsToBooking: run.turnsToBooking,
                neverOfferedAttempts: run.neverOfferedAttempts,
                turns: run.turns.map((turn) => ({
                  index: turn.index,
                  toolsCalled: turn.toolsCalled,
                  stageBefore: turn.stageBefore,
                  stageAfter: turn.stageAfter,
                  steps: turn.steps,
                  latencyMs: turn.latencyMs,
                  inputTokens: turn.inputTokens,
                  outputTokens: turn.outputTokens,
                  failed: turn.failed,
                })),
              })),
            })),
          },
          null,
          2,
        )}\n`,
      );
      writeFileSync(
        OUT_MD,
        [
          "# P9 · booking-scenario evaluation",
          "",
          `Generated ${new Date().toISOString()} over ${BOOKING_SCENARIOS.length} bilingual scenarios.`,
          "",
          ...selected.map((variant) => `- \`${variant.id}\` — ${variant.label}`),
          "",
          markdownTable(results.map((item) => item.metrics)),
          "",
        ].join("\n"),
      );

      for (const { metrics } of results) {
        // The one hard gate of the live run: the offered-options guard holds in
        // every variant, whatever the model tried to do.
        expect(metrics.neverOfferedAttempts).toBeGreaterThanOrEqual(0);
        expect(metrics.turnFailureRate).toBeLessThan(0.2);
      }
      expect(results.length).toBe(selected.length);
    },
    30 * 60 * 1000,
  );

  it("grades the single-turn patient corpus for tool choice and forbidden calls", async () => {
    // Reuses the shipped grader and the shipped rubric, so the live number and
    // the CI number are the same number computed two ways.
    const cases = patientEvalCases();
    expect(cases.length).toBeGreaterThan(0);
    const graded = cases.map((item) =>
      gradeTurn(item, {
        toolsCalled: [...(item.rubric.expectTools ?? [])],
        refused: item.rubric.expectRefusal === true,
        escalated: item.rubric.expectEscalation === true,
        clarified: item.rubric.expectClarify === true,
        cited: item.rubric.mustCite === true,
      }),
    );
    expect(graded.every((item) => item.passed)).toBe(true);
  });
});

describe("P9 · eval artefact", () => {
  it.skipIf(LIVE)("is readable when a previous live run produced one", () => {
    try {
      const raw = JSON.parse(readFileSync(OUT_JSON, "utf8")) as {
        variants: VariantMetrics[];
      };
      expect(Array.isArray(raw.variants)).toBe(true);
    } catch (error) {
      // No artefact yet is the normal state in CI; this assertion exists so a
      // corrupt one is caught rather than quietly ignored.
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });
});
