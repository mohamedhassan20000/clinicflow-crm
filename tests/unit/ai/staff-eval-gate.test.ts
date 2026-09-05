/**
 * The scored Staff Assistant eval gate.
 *
 * The P6A suite next door grades *rubric consistency* — whether the corpus is
 * expressible inside the product's authorization model. Valuable, and not the
 * same question as "is the assistant getting worse". This suite scores twelve
 * dimensions of staff answer/tool-selection quality against a committed
 * baseline, and fails on regression.
 *
 * It is deterministic on purpose (see the module comment in
 * `lib/ai/eval/staff-scorecard.ts`): every number comes from the real tool,
 * action and resource registries, the real deterministic router, the real
 * certified task policies, and the real system prompt. No model, no network, no
 * database — so it can be a *required* job, which a live-graded gate could not
 * safely be.
 *
 * The live half of the same scorer (`scoreStaffObservedRun`) is exercised here
 * against synthetic observed turns, so the behavioural scoring logic is covered
 * in CI even though no model runs in CI.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  STAFF_EVAL_SCENARIOS,
  staffScenariosForRole,
} from "@/lib/ai/eval/staff-scenarios";
import {
  STAFF_SCORE_DIMENSIONS,
  gradeObservedStaffTurn,
  maximalStaffActions,
  maximalStaffResources,
  scoreStaffObservedRun,
  scoreStaffScenarios,
  type ObservedStaffTurn,
  type StaffScoreDimension,
} from "@/lib/ai/eval/staff-scorecard";
import { maximalStaffTools } from "@/lib/ai/eval/authorized-tools";

type BaselineEntry = { value: number; tolerance: number };
type Baseline = {
  scenarios: number;
  overall: BaselineEntry;
  dimensions: Record<StaffScoreDimension, BaselineEntry>;
  byRole: Record<string, BaselineEntry>;
};

const BASELINE: Baseline = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "docs/reviews/artifacts/staff-eval-baseline.json"),
    "utf8",
  ),
) as Baseline;

const CARD = scoreStaffScenarios();

function findingsFor(dimension: string): string {
  return CARD.findings
    .filter((finding) => finding.dimension === dimension)
    .map((finding) => finding.detail)
    .join(" | ");
}

describe("Staff eval gate · corpus composition", () => {
  it("covers all five staff roles with representative scenarios", () => {
    for (const role of ["admin", "manager", "receptionist", "doctor", "assistant"] as const) {
      expect(staffScenariosForRole(role).length, role).toBeGreaterThanOrEqual(5);
    }
  });

  it("is bilingual", () => {
    expect(STAFF_EVAL_SCENARIOS.some((s) => s.locale === "en")).toBe(true);
    expect(STAFF_EVAL_SCENARIOS.filter((s) => s.locale === "ar").length).toBeGreaterThanOrEqual(4);
  });

  it("has unique ids and does not shrink below the committed baseline size", () => {
    expect(new Set(STAFF_EVAL_SCENARIOS.map((s) => s.id)).size).toBe(
      STAFF_EVAL_SCENARIOS.length,
    );
    // A corpus that shrinks is a score that improves for the wrong reason.
    expect(STAFF_EVAL_SCENARIOS.length).toBeGreaterThanOrEqual(BASELINE.scenarios);
  });

  it("exercises every scored dimension", () => {
    for (const dimension of STAFF_SCORE_DIMENSIONS) {
      expect(CARD.counts[dimension].total, dimension).toBeGreaterThan(0);
    }
  });

  it("covers refusal, clarification, citation, multi-step and cross-turn behaviours", () => {
    expect(STAFF_EVAL_SCENARIOS.some((s) => s.expectRefusal)).toBe(true);
    expect(STAFF_EVAL_SCENARIOS.some((s) => s.expectClarify)).toBe(true);
    expect(STAFF_EVAL_SCENARIOS.some((s) => s.mustCite)).toBe(true);
    expect(STAFF_EVAL_SCENARIOS.some((s) => (s.expectedSteps ?? 0) >= 4)).toBe(true);
    expect(STAFF_EVAL_SCENARIOS.some((s) => s.followUp)).toBe(true);
  });
});

describe("Staff eval gate · scored regression thresholds", () => {
  for (const dimension of STAFF_SCORE_DIMENSIONS) {
    const baseline = BASELINE.dimensions[dimension];
    it(`${dimension} does not regress below ${baseline.value} (tolerance ${baseline.tolerance})`, () => {
      const score = CARD.dimensions[dimension];
      expect(score, `${dimension} has no scored scenarios`).not.toBeNull();
      expect(
        score!,
        `${dimension}: ${CARD.counts[dimension].hits}/${CARD.counts[dimension].total} — ${findingsFor(dimension)}`,
      ).toBeGreaterThanOrEqual(baseline.value - baseline.tolerance);
    });
  }

  it("overall score does not regress", () => {
    expect(
      CARD.overall,
      CARD.findings.map((f) => `${f.dimension}: ${f.detail}`).join(" | "),
    ).toBeGreaterThanOrEqual(BASELINE.overall.value - BASELINE.overall.tolerance);
  });

  for (const [role, baseline] of Object.entries(BASELINE.byRole)) {
    it(`no regression for role "${role}"`, () => {
      expect(CARD.byRole[role], role).toBeGreaterThanOrEqual(
        baseline.value - baseline.tolerance,
      );
    });
  }
});

describe("Staff eval gate · hard security invariants", () => {
  // These four are not quality dimensions. A regression in any of them means an
  // authorization fact changed, so they are asserted as absolutes rather than
  // against a tolerance.
  it("no scenario names a capability that is not registered", () => {
    expect(findingsFor("hallucinatedCapability")).toBe("");
    expect(CARD.dimensions.hallucinatedCapability).toBe(1);
  });

  it("every forbidden tool/action/resource is structurally contained", () => {
    expect(findingsFor("forbiddenContainment")).toBe("");
    expect(CARD.dimensions.forbiddenContainment).toBe(1);
  });

  it("no scenario is forced into a refusal by an unreachable capability", () => {
    expect(findingsFor("unnecessaryRefusal")).toBe("");
    expect(CARD.dimensions.unnecessaryRefusal).toBe(1);
  });

  it("every scenario's role boundary holds exactly", () => {
    expect(findingsFor("roleAuthorization")).toBe("");
    expect(CARD.dimensions.roleAuthorization).toBe(1);
  });

  it("keeps the role surfaces genuinely different, not merely differently worded", () => {
    // The gate's premise: the same request resolves differently per role
    // because of the authorization model. If these ever collapse into one
    // surface, every role-specific score above becomes meaningless.
    const admin = maximalStaffTools("admin");
    const doctor = maximalStaffTools("doctor");
    expect(doctor.size).toBeLessThan(admin.size);
    expect(admin.has("get_revenue_summary")).toBe(true);
    expect(doctor.has("get_revenue_summary")).toBe(false);

    expect(maximalStaffActions("assistant").has("staff.change_role")).toBe(false);
    expect(maximalStaffActions("admin").has("staff.change_role")).toBe(true);
    expect(maximalStaffResources("assistant").has("medical_notes")).toBe(false);
    expect(maximalStaffResources("doctor").has("medical_notes")).toBe(true);
  });
});

describe("Staff eval gate · the live grader (shared scorer, synthetic turns)", () => {
  const scenario = STAFF_EVAL_SCENARIOS.find((s) => s.id === "staff-gate-admin-01")!;
  const refusalScenario = STAFF_EVAL_SCENARIOS.find((s) => s.id === "staff-gate-doctor-02")!;

  it("passes a turn that used an expected tool and broke no rule", () => {
    const observed: ObservedStaffTurn = { toolsCalled: ["query_resource"], steps: 2 };
    expect(gradeObservedStaffTurn(scenario, observed).passed).toBe(true);
  });

  it("fails a turn that refused a request it was authorized to answer", () => {
    const grade = gradeObservedStaffTurn(scenario, {
      toolsCalled: [],
      refused: true,
    });
    expect(grade.passed).toBe(false);
    expect(grade.failures.join(" ")).toMatch(/refused a request/);
  });

  it("fails a turn that called a forbidden tool", () => {
    const grade = gradeObservedStaffTurn(refusalScenario, {
      toolsCalled: ["get_revenue_summary"],
      refused: true,
    });
    expect(grade.passed).toBe(false);
    expect(grade.failures.join(" ")).toMatch(/forbidden tool/);
  });

  it("fails a turn that invented a capability", () => {
    const grade = gradeObservedStaffTurn(scenario, {
      toolsCalled: ["query_resource"],
      unknownToolsAttempted: ["delete_all_patients"],
    });
    expect(grade.passed).toBe(false);
    expect(grade.failures.join(" ")).toMatch(/unregistered capability/);
  });

  it("aggregates a run into the metrics the improvement report quotes", () => {
    const summary = scoreStaffObservedRun(
      [scenario, refusalScenario],
      new Map<string, ObservedStaffTurn>([
        [
          scenario.id,
          {
            toolsCalled: ["query_resource"],
            steps: 2,
            failedToolCalls: 1,
            repairedToolCalls: 1,
            latencyMs: 1_200,
            inputTokens: 9_000,
          },
        ],
        [refusalScenario.id, { toolsCalled: [], refused: true, steps: 1 }],
      ]),
    );
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(2);
    expect(summary.toolSelectionAccuracy).toBe(1);
    expect(summary.repairedToolCallRate).toBe(1);
    expect(summary.failedToolCallRate).toBeCloseTo(1 / 2, 5);
    expect(summary.averageSteps).toBeCloseTo(1.5, 5);
    expect(summary.unnecessaryRefusalRate).toBe(0);
    expect(summary.forbiddenToolRate).toBe(0);
    expect(summary.p50LatencyMs).toBe(1_200);
    expect(summary.byRole.admin).toBe(1);
  });

  it("counts a missing observation as a failure rather than silently passing", () => {
    const summary = scoreStaffObservedRun([scenario], new Map());
    expect(summary.passed).toBe(0);
    expect(summary.failures[0]?.failures).toEqual(["no observed turn"]);
  });
});
