/**
 * F-12 — the live artifact's failure diagnostics.
 *
 * Two things are asserted, and the second matters more than the first.
 *
 *   1. A failed case persists enough to be *diagnosed*: the patient's turns,
 *      the assistant's replies, the tool names and arguments, the deterministic
 *      gate decisions, the state progression and the grader's own reason.
 *      Every root cause in this change had to be reconstructed by reading the
 *      pipeline backwards from a one-line verdict, which is a billable run paid
 *      for twice.
 *
 *   2. It is confined to synthetic fixtures, mechanically. The builder refuses
 *      a patient that is not one of the three fixtures the suite defines, and
 *      nothing on this path is reachable from production logging — which stays
 *      content-free.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  NonSyntheticDiagnosticsError,
  buildCaseDiagnostic,
} from "@/lib/ai/acceptance/diagnostics";
import { expandScenarios } from "@/lib/ai/acceptance/scenarios";
import { runConversation } from "@/lib/ai/acceptance/runner";
import { adversarialModel, fabricatingModel } from "@/lib/ai/acceptance/personas";
import { gradeCase } from "@/lib/ai/acceptance/graders";

async function diagnose(caseId: string, model: () => ReturnType<typeof adversarialModel>) {
  const item = expandScenarios().find((entry) => entry.caseId === caseId)!;
  const run = await runConversation(item.caseId, item.turns, {
    model: model(),
    locale: item.scenario.locale,
    patient: item.scenario.patient,
  });
  const result = gradeCase({
    caseId: item.caseId,
    paraphraseIndex: item.paraphraseIndex,
    scenario: item.scenario,
    run,
    lane: "flow",
  });
  return { item, run, result };
}

describe("what a failed case now persists", () => {
  it("carries the whole conversation, the tools, the gates and the grader's reason", async () => {
    // The adversarial persona fails on purpose, which is what makes it a
    // realistic subject for a failure record.
    const { item, run, result } = await diagnose("existing-patient-booking-ar", adversarialModel);
    const diagnostic = buildCaseDiagnostic({ scenario: item.scenario, run, result });

    expect(diagnostic.caseId).toBe("existing-patient-booking-ar");
    expect(diagnostic.category).toBe("existing_patient");
    expect(diagnostic.register).toBe("egyptian_arabic");
    expect(diagnostic.intent.length).toBeGreaterThan(0);

    // Scenario / case, and what the scenario actually expected — so the verdict
    // reads on its own without opening `scenarios.ts`.
    expect(diagnostic.expected.steps).toEqual(["department", "day", "time", "confirm"]);
    expect(diagnostic.expected.tools).toContain("list_available_days");

    // The grader's failure reason, verbatim.
    expect(diagnostic.failures.length).toBeGreaterThan(0);
    for (const failure of diagnostic.failures) {
      expect(failure.detail.length).toBeGreaterThan(0);
      expect(typeof failure.critical).toBe("boolean");
    }

    // Patient turns and assistant replies, in order.
    expect(diagnostic.turns.map((turn) => turn.patient)).toEqual([...item.turns]);
    expect(diagnostic.turns.length).toBe(run.turns.length);

    // The state progression the failure has to be read against.
    for (const turn of diagnostic.turns) {
      expect(turn.step.before).toBeTruthy();
      expect(turn.step.after).toBeTruthy();
      expect(Array.isArray(turn.activeTools)).toBe(true);
      expect(Array.isArray(turn.gates)).toBe(true);
      expect(typeof turn.precommit).toBe("string");
    }
    expect(diagnostic.finalState.collected).toBeDefined();
    expect(Array.isArray(diagnostic.finalState.offeredDays)).toBe(true);
  });

  it("records tool arguments and deterministic gate decisions", async () => {
    const { item, run, result } = await diagnose("incomplete-intake", fabricatingModel);
    // This case now PASSES, so it is graded and then diagnosed deliberately —
    // the record has to be well-formed whether or not the case failed.
    const diagnostic = buildCaseDiagnostic({ scenario: item.scenario, run, result });

    const calls = diagnostic.turns.flatMap((turn) => turn.toolCalls);
    expect(calls.length).toBeGreaterThan(0);
    // The arguments, which is the half that was missing: "the model invented a
    // department" is not derivable from a tool NAME.
    const register = calls.find((call) => call.tool === "register_patient");
    expect(register).toBeDefined();
    expect(Object.keys(register!.input).length).toBeGreaterThan(0);
    expect(register!.outcome).toBe("unreadable_fields");

    // And the deterministic refusals, as counts, so a run can be read for
    // "did a gate fire?" without re-deriving it from the transcript.
    expect(diagnostic.deterministicRefusals.fabricatedIntakeAttempts).toBeGreaterThan(0);
    expect(diagnostic.writes.every((write) => write.committed === false)).toBe(true);
  });

  it("records the authority decision for every turn", async () => {
    const { item, run, result } = await diagnose("cancellation-verified", fabricatingModel);
    const diagnostic = buildCaseDiagnostic({ scenario: item.scenario, run, result });
    expect(diagnostic.turns[0]!.authority).toEqual({
      requirement: "read_authority",
      operation: "list_my_appointments",
      reason: "needs_appointments",
      satisfied: false,
    });
  });
});

describe("the confinement to synthetic fixtures", () => {
  it("refuses to build a record for a patient that is not a suite fixture", async () => {
    const { item, run, result } = await diagnose("cancellation-verified", fabricatingModel);
    expect(() =>
      buildCaseDiagnostic({
        scenario: {
          ...item.scenario,
          // Anything carrying an identifier that is not part of the fixture
          // shape. This cannot be pointed at a real conversation by accident.
          patient: {
            ...item.scenario.patient,
            patientId: "a-real-patient",
          } as never,
        },
        run,
        result,
      }),
    ).toThrow(NonSyntheticDiagnosticsError);
  });

  it("accepts a fixture patient that a scenario has spread to add a flag", async () => {
    const { item, run, result } = await diagnose("cancellation-verified", fabricatingModel);
    expect(() =>
      buildCaseDiagnostic({
        scenario: {
          ...item.scenario,
          patient: { ...item.scenario.patient, humanTakeover: true },
        },
        run,
        result,
      }),
    ).not.toThrow();
  });

  it("is reachable only from the acceptance lanes, never from production logging", async () => {
    // The rule this file exists to protect: `logAgentTool` records outcomes,
    // labels and counts — never a value, an argument or a reply. If the
    // diagnostics module ever became reachable from it, that would be a privacy
    // regression rather than a debugging convenience, so the import graph is
    // asserted rather than trusted.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const importers = [
      "lib/ai/audit.ts",
      "lib/ai/patient-reply.ts",
      "lib/ai/patient-agent.ts",
      "lib/ai/booking-stage-store.ts",
    ];
    for (const file of importers) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source, file).not.toContain("acceptance/diagnostics");
    }
  });
});

/**
 * F-15 — the three properties the live artifact has to hold before a 129-case
 * billable certification is worth starting.
 *
 * All non-billable: the personas below are deterministic local models, so this
 * file makes no provider call.
 */

import {
  DIAGNOSTIC_REDACTION,
  scrubDeep,
  scrubSecrets,
  secretLiteralsFromEnv,
} from "@/lib/ai/acceptance/diagnostics";
import { compliantModel } from "@/lib/ai/acceptance/personas";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("a passing case does not bloat the artifact", () => {
  it("is never given a diagnostic record by the live lane", () => {
    // The lane's rule, asserted at its source rather than described. A future
    // edit that persisted every case — 129 transcripts instead of the handful
    // that failed — would bury the failures it exists to surface, and is the
    // regression this catches.
    const source = readFileSync(
      resolve(process.cwd(), "tests/unit/ai/acceptance/patient-assistant-live-acceptance.test.ts"),
      "utf8",
    );
    expect(source).toContain("if (!result.passed) {");
    expect(source).toContain("diagnostics.push(buildCaseDiagnostic({ scenario, run, result }))");
    // And the lane asserts the two counts agree, so a diagnostic can neither be
    // dropped for a failure nor added for a pass.
    expect(source).toContain("expect(lane.diagnostics.length).toBe(lane.failures.length);");
  });

  it("keeps the artifact proportional to the failures, not to the run", async () => {
    // The same selection rule, applied to a mixed run, measured rather than
    // argued: a lane whose cases nearly all pass must not pay artifact size for
    // the ones that did.
    const passing = await diagnose("cancellation-verified", compliantModel);
    const failing = await diagnose("existing-patient-booking-ar", adversarialModel);
    expect(failing.result.passed).toBe(false);

    const artifact = [passing, failing]
      .filter((entry) => !entry.result.passed)
      .map((entry) =>
        buildCaseDiagnostic({ scenario: entry.item.scenario, run: entry.run, result: entry.result }),
      );

    expect(artifact.length).toBe(1);
    expect(artifact[0]!.caseId).toBe("existing-patient-booking-ar");
    // The passing case contributes nothing at all — not a stub, not an id.
    expect(JSON.stringify(artifact)).not.toContain("cancellation-verified");
  });
});

describe("a failed case is diagnosable from a single paid run", () => {
  it("carries every field needed to find the cause without re-running it", async () => {
    const { item, run, result } = await diagnose("existing-patient-booking-ar", adversarialModel);
    expect(result.passed).toBe(false);
    const d = buildCaseDiagnostic({ scenario: item.scenario, run, result });

    // Identity of the case.
    for (const value of [d.caseId, d.scenarioId, d.category, d.register, d.locale, d.intent]) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
    expect(typeof d.paraphraseIndex).toBe("number");

    // The exact grader failure, verbatim and attributed.
    expect(d.failures.length).toBeGreaterThan(0);
    for (const failure of d.failures) {
      expect(failure.id.length).toBeGreaterThan(0);
      expect(failure.detail.length).toBeGreaterThan(0);
      expect(typeof failure.critical).toBe("boolean");
    }
    // Readable against what was expected, without opening scenarios.ts.
    expect(d.expected.steps.length + d.expected.tools.length).toBeGreaterThan(0);

    // Patient turns and assistant replies, paired and ordered.
    expect(d.turns.length).toBeGreaterThan(0);
    expect(d.turns.map((turn) => turn.patient)).toEqual([...item.turns]);
    expect(d.turns.map((turn) => turn.index)).toEqual(d.turns.map((_, i) => i));
    for (const turn of d.turns) expect(typeof turn.assistant).toBe("string");

    // State progression, per turn and at the end.
    for (const turn of d.turns) {
      expect(turn.step.before.length).toBeGreaterThan(0);
      expect(turn.step.after.length).toBeGreaterThan(0);
      expect(turn.stage.before.length).toBeGreaterThan(0);
      expect(turn.stage.after.length).toBeGreaterThan(0);
    }
    expect(d.finalState.stage.length).toBeGreaterThan(0);
    expect(typeof d.finalState.submitted).toBe("boolean");

    // Deterministic gate decisions: the per-turn gate labels, the authority
    // decision, and the refusal counters.
    expect(d.turns.every((turn) => Array.isArray(turn.gates))).toBe(true);
    expect(d.turns.every((turn) => typeof turn.precommit === "string")).toBe(true);
    for (const key of [
      "fabricatedIntakeAttempts",
      "unsourcedArgumentDiscards",
      "neverOfferedSlotAttempts",
    ] as const) {
      expect(typeof d.deterministicRefusals[key]).toBe("number");
    }

    // Tool names AND their arguments — the half a tool name cannot supply.
    //
    // This particular failure is a case where NO tool ran, which is the most
    // common shape of a live failure and the one a tool-call list alone cannot
    // explain. So the record has to answer "why not": which tools the stage
    // left callable, and which the model actually asked for. Without both, "it
    // called nothing" is indistinguishable from "it was allowed nothing".
    for (const turn of d.turns) {
      expect(Array.isArray(turn.activeTools)).toBe(true);
      expect(Array.isArray(turn.requestedTools)).toBe(true);
    }
    expect(d.turns.some((turn) => turn.activeTools.length > 0)).toBe(true);

    // And where a tool did run, it carries the arguments it ran with. Proven
    // on a run that reaches the tools, since the arguments are the field whose
    // absence made "the model invented a department" undiagnosable.
    const withTools = await diagnose("incomplete-intake", fabricatingModel);
    const toolRecord = buildCaseDiagnostic({
      scenario: withTools.item.scenario,
      run: withTools.run,
      result: withTools.result,
    });
    const calls = toolRecord.turns.flatMap((turn) => turn.toolCalls);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.tool.length).toBeGreaterThan(0);
      expect(typeof call.input).toBe("object");
      expect(call.outcome.length).toBeGreaterThan(0);
    }
    expect(calls.some((call) => Object.keys(call.input).length > 0)).toBe(true);
    // Every write the server was asked for, with the reason it was or was not
    // committed.
    for (const write of d.writes) {
      expect(write.operation.length).toBeGreaterThan(0);
      expect(write.reason.length).toBeGreaterThan(0);
      expect(typeof write.committed).toBe("boolean");
    }

    // And the whole record survives JSON, which is how it reaches the artifact.
    expect(() => JSON.parse(JSON.stringify(d))).not.toThrow();
  });
});

describe("secrets can never appear in the artifact", () => {
  const MANAGED = "sk-ant-api03-LIVEMANAGEDKEYMATERIAL0000000000000000";
  const BYOK = "sk-ant-api03-BYOKACCEPTANCEKEYMATERIAL111111111111";

  it("redacts a managed key by its literal value, whatever shape it has", () => {
    // The rule that does the real work: the value is redacted because the
    // environment says it is a secret, NOT because it matched a pattern. An
    // opaque, rotated, or re-formatted key is covered by construction.
    const env = {
      ANTHROPIC_MANAGED_API_KEY: "totally-opaque-not-key-shaped-value",
      AI_ACCEPTANCE_BYOK_API_KEY: BYOK,
      SUPABASE_SERVICE_ROLE_KEY: "service-role-material-0000",
      NEXT_PUBLIC_APP_URL: "https://example.test",
    } as unknown as NodeJS.ProcessEnv;
    const literals = secretLiteralsFromEnv(env);

    expect(scrubSecrets("key=totally-opaque-not-key-shaped-value", literals)).not.toContain(
      "totally-opaque-not-key-shaped-value",
    );
    expect(scrubSecrets(`auth ${BYOK}`, literals)).not.toContain(BYOK);
    expect(scrubSecrets("service-role-material-0000", literals)).toBe(DIAGNOSTIC_REDACTION);
    // A non-secret env var is not swept up: the app URL stays readable.
    expect(scrubSecrets("https://example.test/x", literals)).toBe("https://example.test/x");
  });

  it("redacts credential shapes even when the environment holds nothing", () => {
    const none: readonly string[] = [];
    for (const secret of [
      MANAGED,
      "Bearer abcdefghijklmnopqrstuvwxyz012345",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2NlcHRhbmNlIn0.c2lnbmF0dXJlMDAw",
      'api_key: "abcdefghijklmnopqrst"',
    ]) {
      expect(scrubSecrets(secret, none)).toContain(DIAGNOSTIC_REDACTION);
      expect(scrubSecrets(secret, none)).not.toContain("abcdefghijklmnopqrst");
    }
    expect(scrubSecrets(MANAGED, none)).not.toContain("LIVEMANAGEDKEYMATERIAL");
  });

  it("reaches a secret nested anywhere in a tool argument", () => {
    const literals = [MANAGED];
    const scrubbed = scrubDeep(
      {
        tool: "register_patient",
        input: { notes: [{ body: `remember ${MANAGED}` }], depth: { deeper: MANAGED } },
        [`${MANAGED}`]: "a secret used as a key",
        count: 3,
        ok: true,
        nothing: null,
      },
      literals,
    );
    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(MANAGED);
    expect(serialized).not.toContain("LIVEMANAGEDKEYMATERIAL");
    // Structure and non-string values are preserved, so the record stays
    // readable as the argument the model actually sent.
    expect((scrubbed as { count: number }).count).toBe(3);
    expect((scrubbed as { ok: boolean }).ok).toBe(true);
    expect((scrubbed as { nothing: unknown }).nothing).toBeNull();
    expect((scrubbed as { tool: string }).tool).toBe("register_patient");
  });

  it("scrubs a real diagnostic record end to end", async () => {
    const previous = process.env.ANTHROPIC_MANAGED_API_KEY;
    process.env.ANTHROPIC_MANAGED_API_KEY = MANAGED;
    try {
      const { item, run, result } = await diagnose("existing-patient-booking-ar", adversarialModel);
      // Plant the key where a model could actually put it: a free-text reply
      // and a tool argument. Both are model output, and both are persisted.
      const contaminated = {
        ...run,
        turns: run.turns.map((turn, index) =>
          index === 0
            ? {
                ...turn,
                replyText: `${turn.replyText} ${MANAGED}`,
                toolCalls: [
                  { tool: "list_available_days", input: { note: MANAGED }, outcome: "ok" },
                  ...turn.toolCalls,
                ],
              }
            : turn,
        ),
      } as typeof run;

      const d = buildCaseDiagnostic({ scenario: item.scenario, run: contaminated, result });
      const serialized = JSON.stringify(d);
      expect(serialized).not.toContain(MANAGED);
      expect(serialized).not.toContain("LIVEMANAGEDKEYMATERIAL");
      expect(serialized).toContain(DIAGNOSTIC_REDACTION);
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_MANAGED_API_KEY;
      else process.env.ANTHROPIC_MANAGED_API_KEY = previous;
    }
  });

  it("leaves the scripted turns and the grader's reason readable", async () => {
    // Over-redaction would be a quieter failure than a leak: a record nobody
    // can read is a run paid for twice, which is the defect this file exists
    // for. The scenario's own Arabic text must survive verbatim.
    const { item, run, result } = await diagnose("existing-patient-booking-ar", adversarialModel);
    const d = buildCaseDiagnostic({ scenario: item.scenario, run, result });
    expect(d.turns.map((turn) => turn.patient)).toEqual([...item.turns]);
    expect(JSON.stringify(d)).not.toContain(DIAGNOSTIC_REDACTION);
    for (const failure of d.failures) expect(failure.detail.length).toBeGreaterThan(0);
  });
});
