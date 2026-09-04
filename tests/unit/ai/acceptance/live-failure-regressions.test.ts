/**
 * The six cases the managed Haiku 4.5 live acceptance run failed, locked down
 * deterministically.
 *
 * `docs/reviews/artifacts/patient-assistant-live-acceptance.json` is the source
 * of truth for what failed and why. Every fix in this change is a **server-side
 * determinism** fix rather than a prompt change, which means each of these can
 * be asserted offline against a persona that reproduces the model behaviour
 * that produced the failure — and that is the point: if the fix depended on the
 * model cooperating, there would be nothing to assert here and nothing to stop
 * the regression coming back on the next model swap.
 *
 * The persona is `fabricatingModel`, which does what Haiku actually did: it
 * obeys the `toolChoice` pin and then fills the tool's arguments with values
 * nobody supplied. See `personas.ts`.
 *
 * Nothing here weakens an expectation. Each case is graded by `gradeCase` on
 * the `flow` lane — the same grader, the same scenario, the same checks the
 * live lane runs.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { expandScenarios } from "@/lib/ai/acceptance/scenarios";
import { runConversation, type ConversationRecord } from "@/lib/ai/acceptance/runner";
import { fabricatingModel } from "@/lib/ai/acceptance/personas";
import { gradeCase, type CaseResult } from "@/lib/ai/acceptance/graders";

/** Exactly the ids the live artifact lists under `managed.failures`. */
const PREVIOUSLY_FAILED = [
  "incomplete-intake",
  "doctors-roster#p1",
  "existing-patient-booking-ar#p1",
  "existing-patient-booking-ar#p2",
  "cancellation-verified",
  "cancellation-verified#p3",
] as const;

async function runCase(caseId: string): Promise<{
  run: ConversationRecord;
  result: CaseResult;
}> {
  const item = expandScenarios().find((entry) => entry.caseId === caseId);
  if (!item) throw new Error(`Unknown acceptance case: ${caseId}`);
  const run = await runConversation(item.caseId, item.turns, {
    model: fabricatingModel(),
    locale: item.scenario.locale,
    patient: item.scenario.patient,
    failures: item.scenario.failures ?? {},
    hang: item.scenario.hang ?? [],
    duplicateIndexes: item.scenario.duplicateIndexes ?? [],
    humanTakeoverAfter: item.scenario.humanTakeoverAfter ?? null,
  });
  return {
    run,
    result: gradeCase({
      caseId: item.caseId,
      paraphraseIndex: item.paraphraseIndex,
      scenario: item.scenario,
      run,
      lane: "flow",
    }),
  };
}

describe("the six previously-failed live cases", () => {
  it.each(PREVIOUSLY_FAILED)("%s passes its own scenario's checks", async (caseId) => {
    const { result } = await runCase(caseId);
    const failures = result.checks
      .filter((check) => !check.passed)
      .map((check) => `${check.id}: ${check.detail}`);
    expect(failures).toEqual([]);
  }, 60_000);
});

describe("and the mechanism behind each one", () => {
  it("incomplete-intake: no intake is staged from values the patient never gave", async () => {
    // Live failure (CRITICAL): committed create_preliminary_booking behind an
    // intake whose national id, date of birth and email the model invented.
    const { run } = await runCase("incomplete-intake");
    expect(run.simulator.fabricatedIntakeAttempts).toBeGreaterThan(0);
    expect(run.simulator.intakeStaged).toBe(false);
    expect(run.simulator.writes.filter((write) => write.committed)).toEqual([]);
  });

  it("doctors-roster#p1: a roster question continues the roster", async () => {
    // Live failure (CRITICAL): the reply asked which department the patient
    // wanted, on a turn where the department was already settled and the
    // patient had asked who else there was.
    const { run } = await runCase("doctors-roster#p1");
    const rosterTurn = run.turns[1]!;
    expect(rosterTurn.authority?.reason).toBe("needs_roster_continuation");
    expect(rosterTurn.authority?.operation).toBe("list_doctors");
    expect(rosterTurn.executedTools).toContain("list_doctors");
    // And the department the ladder had already settled is still settled.
    expect(typeof run.simulator.collected.department_id).toBe("string");
  });

  it.each(["existing-patient-booking-ar#p1", "existing-patient-booking-ar#p2"])(
    "%s: an invented department argument no longer suppresses the opening",
    async (caseId) => {
      // Live failure: the ladder never left `department` — four turns, four
      // department rungs — because a department the patient never mentioned was
      // passed to prepare_booking and read as an explicit choice.
      const { run } = await runCase(caseId);
      expect(run.simulator.unsourcedArgumentDiscards).toBeGreaterThan(0);
      const steps = run.turns.map((turn) => turn.step);
      expect(steps).toContain("day");
      expect(steps).toContain("time");
      expect(
        run.simulator.writes.some(
          (write) => write.committed && write.operation === "create_preliminary_booking",
        ),
      ).toBe(true);
    },
    60_000,
  );

  it.each(["cancellation-verified", "cancellation-verified#p3"])(
    "%s: a cancellation reads the patient's appointments instead of opening a booking",
    async (caseId) => {
      // Live failure: `list_my_appointments` never ran, because a thread that
      // had collected nothing resolved the `department` rung and pinned
      // `prepare_booking` on a message that was not about making an appointment.
      const { run } = await runCase(caseId);
      const turn = run.turns[0]!;
      expect(turn.authority?.reason).toBe("needs_appointments");
      expect(turn.authority?.operation).toBe("list_my_appointments");
      expect(turn.executedTools).toContain("list_my_appointments");
      // The read is all it is: nothing was cancelled without a confirmation.
      expect(
        run.simulator.writes.some(
          (write) => write.committed && write.operation === "cancel_my_appointment",
        ),
      ).toBe(false);
    },
    60_000,
  );
});
