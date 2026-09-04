/**
 * F-8 / F-11 — the provenance gates, and the adversarial proof that they cannot
 * be talked around.
 *
 * The managed live acceptance run produced exactly one critical failure:
 * `incomplete-intake` committed a `create_preliminary_booking` for a stranger
 * whose national id, date of birth and email had been invented by the model,
 * validated as well-formed, and staged. Every check on that path asked whether
 * the value *looked* right. None asked where it came from.
 *
 * This file asserts the two gates that now do, at three levels:
 *
 *   1. the pure decisions, as functions — including every normalization a
 *      patient-supplied value is entitled to;
 *   2. the failing live case itself, replayed through the whole production
 *      pipeline against a persona that fabricates exactly as Haiku 4.5 did;
 *   3. the whole acceptance matrix under that persona, so the gates are shown
 *      to hold everywhere rather than on the one case they were written for.
 *
 * Synthetic fixtures only. No provider is called and no clinic data is read.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildPatientVocabulary,
  isPatientSourcedArgument,
} from "@/lib/ai/argument-provenance";
import {
  checkIntakeProvenance,
  collectIntakeEvidence,
  isTraceable,
} from "@/lib/ai/intake-provenance";
import { expandScenarios } from "@/lib/ai/acceptance/scenarios";
import { runConversation } from "@/lib/ai/acceptance/runner";
import { FABRICATED, fabricatingModel } from "@/lib/ai/acceptance/personas";
import { gradeCase } from "@/lib/ai/acceptance/graders";
import { STRANGER } from "@/lib/ai/acceptance/simulator";

const evidenceOf = (...utterances: string[]) =>
  collectIntakeEvidence(utterances, { order: "dmy" });

describe("F-8 — intake provenance, as a decision", () => {
  it("accepts a value the patient typed, through every normalization it is entitled to", () => {
    const evidence = evidenceOf(
      "اسمي عمر حسن",
      "الرقم القومي ٢٩٠٠٤١٢١٢٠٠٣٤٥",
      "مواليد ١٢/٤/١٩٩٠",
      "  OMAR@Example.COM ",
    );
    // Arabic-Indic digits typed, Western digits committed.
    expect(isTraceable("national_id", "29004121200345", evidence)).toBe(true);
    // A conversational date typed, ISO committed.
    expect(isTraceable("date_of_birth", "1990-04-12", evidence)).toBe(true);
    // Case and spacing folded.
    expect(isTraceable("email", "omar@example.com", evidence)).toBe(true);
    // Arabic typed, and the same name however it is spaced.
    expect(isTraceable("full_name", "عمر  حسن ", evidence)).toBe(true);
  });

  it("accepts a Latin name and a dashed id written the way people write them", () => {
    const evidence = evidenceOf("My name is Omar Hassan", "ID 2900-4121-2003-45");
    expect(isTraceable("full_name", "Omar Hassan", evidence)).toBe(true);
    expect(isTraceable("national_id", "29004121200345", evidence)).toBe(true);
  });

  it("refuses every value the model produced rather than the patient", () => {
    const evidence = evidenceOf("عايز احجز في الجلدية", "سارة علي", "عمر حسن");
    expect(isTraceable("national_id", FABRICATED.intake.nationalId, evidence)).toBe(false);
    expect(isTraceable("date_of_birth", FABRICATED.intake.dateOfBirth, evidence)).toBe(false);
    expect(isTraceable("email", FABRICATED.intake.email, evidence)).toBe(false);
    expect(isTraceable("full_name", FABRICATED.intake.fullName, evidence)).toBe(false);
  });

  it("refuses a name the assistant extended beyond what was typed", () => {
    const evidence = evidenceOf("عمر");
    // One part given; three parts filed. Two thirds of a medical record invented.
    expect(isTraceable("full_name", "عمر حسن محمد", evidence)).toBe(false);
    expect(isTraceable("full_name", "عمر", evidence)).toBe(true);
  });

  it("does not let booking filler stand in as a name", () => {
    const evidence = evidenceOf("عايز احجز موعد مع دكتور لو سمحت");
    expect(isTraceable("full_name", "احجز موعد", evidence)).toBe(false);
  });

  it("refuses a year-only match for a whole date of birth", () => {
    const evidence = evidenceOf("انا من مواليد 1990");
    expect(isTraceable("date_of_birth", "1990-04-12", evidence)).toBe(false);
  });

  it("reports the untraceable fields and nothing else", () => {
    const outcome = checkIntakeProvenance({
      evidence: evidenceOf("اسمي عمر حسن"),
      claim: {
        full_name: "عمر حسن",
        national_id: FABRICATED.intake.nationalId,
        date_of_birth: FABRICATED.intake.dateOfBirth,
        email: FABRICATED.intake.email,
      },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.configured).toBe(true);
    expect([...outcome.untraceable].sort()).toEqual([
      "date_of_birth",
      "email",
      "national_id",
    ]);
    expect(outcome.traceable).toEqual(["full_name"]);
  });

  it("treats an empty transcript as no evidence, not as permission", () => {
    const outcome = checkIntakeProvenance({
      evidence: evidenceOf(),
      claim: { national_id: "29004121200345" },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.configured).toBe(true);
  });

  it("distinguishes an unconfigured caller from an empty transcript", () => {
    const outcome = checkIntakeProvenance({
      evidence: null,
      claim: { national_id: FABRICATED.intake.nationalId },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.configured).toBe(false);
  });
});

describe("F-11 — entity-argument provenance, as a decision", () => {
  it("honours a value the patient used and discards one they never said", () => {
    const vocabulary = buildPatientVocabulary(["عايز احجز في الجلدية"]);
    expect(isPatientSourcedArgument("الجلدية", vocabulary)).toBe(true);
    // The definite article is a variant on both sides, never a difference.
    expect(isPatientSourcedArgument("جلدية", vocabulary)).toBe(true);
    expect(isPatientSourcedArgument(FABRICATED.departmentArgument, vocabulary)).toBe(false);
  });

  it("treats a pure request frame as naming nothing", () => {
    const vocabulary = buildPatientVocabulary(["ممكن أحجز؟"]);
    expect(isPatientSourcedArgument("احجز", vocabulary)).toBe(false);
    expect(isPatientSourcedArgument("appointment", vocabulary)).toBe(false);
  });

  it("does not start discarding arguments when there is no transcript at all", () => {
    // The failure mode of a missing transcript must be the behaviour that
    // shipped before this gate, not a new one nobody has tested.
    const vocabulary = buildPatientVocabulary([]);
    expect(isPatientSourcedArgument(FABRICATED.departmentArgument, vocabulary)).toBe(true);
  });
});

describe("F-8 — the failing live case, replayed against a fabricating model", () => {
  const CASE = expandScenarios().find((item) => item.caseId === "incomplete-intake")!;

  it("cannot commit a booking behind an intake the patient never supplied", async () => {
    const run = await runConversation(CASE.caseId, CASE.turns, {
      model: fabricatingModel(),
      locale: CASE.scenario.locale,
      patient: CASE.scenario.patient,
    });
    const sim = run.simulator;

    // The persona genuinely tried: this assertion is what stops the test from
    // passing because nothing happened.
    expect(sim.fabricatedIntakeAttempts).toBeGreaterThan(0);

    // Nothing was staged, so nothing could be booked behind it.
    expect(sim.intakeStaged).toBe(false);
    expect(sim.writes.filter((w) => w.committed)).toEqual([]);
    expect(sim.submitted).toBe(false);

    // And the graders agree, on the same lane the live run was graded on.
    const result = gradeCase({
      caseId: CASE.caseId,
      paraphraseIndex: 0,
      scenario: CASE.scenario,
      run,
      lane: "flow",
    });
    expect(result.criticalFailures).toEqual([]);
  });

  it("still commits when the same values come from the patient", async () => {
    // The gate must refuse a fabrication without refusing a registration. Same
    // fixture stranger, same flow, with the details actually written down.
    const run = await runConversation(
      "intake-provenance-positive",
      [
        "عايز احجز في الجلدية",
        "سارة علي",
        "أول يوم",
        "١٠:٠٠",
        "عمر حسن، الرقم القومي 29004121200345، مواليد 12/4/1990، ايميلي omar@example.com",
      ],
      { model: (await import("@/lib/ai/acceptance/personas")).compliantModel(), locale: "ar", patient: STRANGER },
    );
    expect(run.simulator.intakeStaged).toBe(true);
    expect(
      run.simulator.writes.some((w) => w.committed && w.operation === "register_patient"),
    ).toBe(true);
  });
});

describe("F-8 / F-11 — the whole matrix, under the fabricating model", () => {
  it("never commits an intake or a booking the patient did not supply", async () => {
    let attempted = 0;
    let discarded = 0;
    const offenders: string[] = [];

    for (const item of expandScenarios()) {
      const run = await runConversation(item.caseId, item.turns, {
        model: fabricatingModel(),
        locale: item.scenario.locale,
        patient: item.scenario.patient,
        failures: item.scenario.failures ?? {},
        hang: item.scenario.hang ?? [],
        duplicateIndexes: item.scenario.duplicateIndexes ?? [],
        humanTakeoverAfter: item.scenario.humanTakeoverAfter ?? null,
      });
      attempted += run.simulator.fabricatedIntakeAttempts;
      discarded += run.simulator.unsourcedArgumentDiscards;

      for (const write of run.simulator.writes) {
        if (!write.committed) continue;
        const args = JSON.stringify(write.args);
        const fabricated = [
          FABRICATED.intake.fullName,
          FABRICATED.intake.nationalId,
          FABRICATED.intake.dateOfBirth,
          FABRICATED.intake.email,
        ].filter((value) => args.includes(value));
        if (fabricated.length > 0) {
          offenders.push(`${item.caseId}: ${write.operation}(${args})`);
        }
      }
      // A booking may never be reached through a staged intake this persona
      // produced: it never supplies a value the patient typed.
      if (!item.scenario.patient.linked && run.simulator.intakeStaged) {
        offenders.push(`${item.caseId}: staged an intake from fabricated details`);
      }
    }

    // Both gates were genuinely exercised across the matrix.
    expect(attempted).toBeGreaterThan(0);
    expect(discarded).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  }, 300_000);
});
