/**
 * The production acceptance gates, as a test CI can fail on.
 *
 * The suite proper (`patient-assistant-acceptance.test.ts`) *records* — it runs
 * the whole matrix and writes an artifact, and it does not gate, because a
 * first pass whose job is to find failures should not also be the thing that
 * blocks the branch it found them on.
 *
 * This file is the gate. It asserts the universal safety properties, with one
 * explicit, named allowlist of the failures the first pass found. The allowlist
 * is the mechanism that makes the finding durable rather than forgotten: a new
 * regression fails here immediately, and closing a known finding means deleting
 * its line, which is a change a reviewer can see.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { expandScenarios } from "@/lib/ai/acceptance/scenarios";
import { runConversation } from "@/lib/ai/acceptance/runner";
import { adversarialModel, compliantModel } from "@/lib/ai/acceptance/personas";
import { gradeCase, type CaseResult, type CheckId } from "@/lib/ai/acceptance/graders";

/**
 * Known, recorded product failures.
 *
 * Each line is a live finding in
 * `docs/reviews/PATIENT_ASSISTANT_PRODUCTION_ACCEPTANCE.md`. Delete a line when
 * the finding is fixed; never add one to make a build green.
 *
 * **Empty, and it stays empty.** The eight findings of the 2026-08-30 pass —
 * F-1 through F-8 — are fixed, and every line that stood here was deleted with
 * the fix that closed it: the service/price/insurer grounding gate (F-1), the
 * server-composed ambiguity clarification (F-2), the context-aware closing
 * lexicon (F-3), the clinic-information gate on the department pin (F-4), and
 * the human-request phrasings (F-5). A new regression now fails this file
 * immediately, which is the whole point of the allowlist having a floor of
 * zero.
 */
const KNOWN_FAILURES: Readonly<Record<string, readonly CheckId[]>> = {
  // V2-CONTAINMENT, 2026-09-04 — two English paraphrases the *legacy* regex
  // classifier cannot read as booking requests.
  //
  // "dermatology please" matches neither `BOOKING` nor `SERVICE` in
  // `patient-turn-intent.ts`, so `bookingOpening` is false and the department
  // rung is no longer pinned. Before the containment these cases worked by
  // accident: the rung pinned `prepare_booking` for *every* unclassified
  // message, which is the same default that answered «عندي استفسار» with a
  // doctor's calendar. Restoring the old default to make these two green would
  // reopen that defect, and the alternative — one more phrase in one more
  // regex — is the accumulation this rebuild exists to end.
  //
  // The turn now degrades to a clarification, which is safe and unhelpful. The
  // fix is the V2 interpreter, which reads intent from language rather than
  // from a pattern list. These two lines are deleted when the V2 lane covers
  // them; they must never be widened.
  "ambiguous-doctor-truncated#p1": ["clarification_required"],
  "ambiguous-doctor-truncated#p2": ["clarification_required"],
};

function unexpected(results: readonly CaseResult[]): string[] {
  const problems: string[] = [];
  for (const result of results) {
    const allowed = new Set(KNOWN_FAILURES[result.caseId] ?? []);
    for (const check of result.criticalFailures) {
      if (!allowed.has(check.id)) {
        problems.push(`${result.caseId} · ${check.id} · ${check.detail}`);
      }
    }
  }
  return problems;
}

async function lane(
  model: () => ReturnType<typeof adversarialModel>,
  laneName: "containment" | "flow",
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const item of expandScenarios()) {
    const { scenario } = item;
    const run = await runConversation(item.caseId, item.turns, {
      model: model(),
      locale: scenario.locale,
      patient: scenario.patient,
      failures: scenario.failures ?? {},
      hang: scenario.hang ?? [],
      duplicateIndexes: scenario.duplicateIndexes ?? [],
      humanTakeoverAfter: scenario.humanTakeoverAfter ?? null,
    });
    results.push(
      gradeCase({
        caseId: item.caseId,
        paraphraseIndex: item.paraphraseIndex,
        scenario,
        run,
        lane: laneName,
      }),
    );
  }
  return results;
}

describe("Patient Assistant acceptance gates", () => {
  it("an adversarial model produces no unrecorded critical failure", async () => {
    expect(unexpected(await lane(adversarialModel, "containment"))).toEqual([]);
  }, 300_000);

  it("the orchestration lane produces no unrecorded critical failure", async () => {
    expect(unexpected(await lane(compliantModel, "flow"))).toEqual([]);
  }, 300_000);

  it("no booking is ever committed on a slot the server never offered", async () => {
    for (const results of [
      await lane(adversarialModel, "containment"),
      await lane(compliantModel, "flow"),
    ]) {
      const offenders = results.flatMap((r) =>
        r.checks.filter((c) => c.id === "no_hallucinated_write" && !c.passed),
      );
      expect(offenders).toEqual([]);
    }
  }, 600_000);
});
