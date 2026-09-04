import { describe, expect, it, vi } from "vitest";

/**
 * P11G — the patient booking agent calls booking tools.
 *
 * ## What this file can and cannot prove
 *
 * It proves the parts of "the model calls the tool" that are **deterministic**:
 * that the tool is in the final provider request, that it is narrowed to the
 * right set for the stage, that the server states which authoritative operation
 * the turn needs, and that a turn whose requirement is unmet is pinned to that
 * one tool through `toolChoice` while a turn whose requirement is already
 * satisfied is not.
 *
 * It **cannot** prove that a live Claude Haiku 4.5 chooses to call a tool it was
 * merely offered. Nothing model-independent can, and faking a tool call in a
 * mock and calling that "the model behaviour is fixed" would be a lie about the
 * one thing this phase is about. The live measurement lives in
 * `p9-booking-live-eval.test.ts` behind `AI_EVAL_LIVE=1`; the mock model here is
 * a *recorder*, and every assertion below is about what ClinicFlow sent, never
 * about what a model decided.
 *
 * ## Generated data only
 *
 * No department name, no doctor name and no specialty appears anywhere in this
 * file. The authority contract is a function of the ladder step and the offered
 * lists, so there is nothing here for a hard-coded name to attach to — which is
 * itself the §11 genericity property, asserted rather than described.
 */

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: vi.fn() }));

import { MockLanguageModelV3 } from "ai/test";
import {
  createAuthorityObserver,
  createPatientAgent,
} from "@/lib/ai/patient-agent";
import {
  bookingAuthorityInstruction,
  resolveBookingAuthority,
  shouldForceAuthority,
  type BookingAuthority,
} from "@/lib/ai/booking-authority";
import {
  BOOKING_STAGES,
  allowedToolsForStage,
  nextBookingStep,
  type BookingStage,
} from "@/lib/ai/booking-stage";
import { PATIENT_TOOL_NAMES } from "@/lib/ai/patient-tools";
import { createGroundingLedger } from "@/lib/ai/patient-grounding";

const DAY = "2026-09-14";
const OTHER_DAY = "2026-09-21";
const DOCTOR = "aaaaaaaa-0000-4000-8000-0000000000d1";
const DEPARTMENT = "bbbbbbbb-0000-4000-8000-0000000000e1";

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------

type Capture = {
  tools: string[];
  toolChoice: unknown;
  system: string;
};

function makeExecution(captures: Capture[], text = "ok") {
  return {
    requestId: "req",
    model: new MockLanguageModelV3({
      // The mock is a recorder, not a model. Its result shape is asserted by
      // the SDK at runtime and is deliberately typed loosely here so a provider
      // interface revision cannot break a test that is about ClinicFlow.
      doGenerate: (async (options: {
        prompt: unknown;
        tools?: unknown;
        toolChoice?: unknown;
      }) => {
        const prompt = options.prompt as Array<{ role: string; content: unknown }>;
        const tools = (options.tools ?? []) as Array<{ name: string }>;
        captures.push({
          tools: tools.map((item) => item.name),
          toolChoice: options.toolChoice,
          system: prompt
            .filter((message) => message.role === "system")
            .map((message) => String(message.content))
            .join("\n"),
        });
        return {
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          content: [{ type: "text", text }],
          warnings: [],
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    }),
    providerOptions: {},
    taskPolicy: {
      task: "patient_booking",
      maxSteps: 6,
      temperature: 0.2,
      maxOutputTokens: 800,
      maxInputTokensPerStep: 16_000,
    },
    beginStep: () => {},
    observeStep: () => {},
    finalize: async () => {},
  } as unknown as Parameters<typeof createPatientAgent>[0]["execution"];
}

async function runTurn(input: {
  stage: BookingStage;
  authority?: BookingAuthority | null;
  locale?: "ar" | "en";
  grounding?: ReturnType<typeof createGroundingLedger>;
}): Promise<{ capture: Capture; observer: ReturnType<typeof createAuthorityObserver> }> {
  const captures: Capture[] = [];
  const observer = createAuthorityObserver();
  const agent = createPatientAgent({
    clinicId: "11111111-1111-4111-8111-111111111111",
    conversationId: "22222222-2222-4222-8222-222222222222",
    locale: input.locale ?? "ar",
    execution: makeExecution(captures),
    bookingStage: input.stage,
    authority: input.authority ?? null,
    ...(input.grounding ? { grounding: input.grounding } : {}),
    observer,
  });
  await agent.generate({ messages: [{ role: "user", content: "..." }] });
  return { capture: captures[0]!, observer };
}

function authorityFor(overrides: Partial<Parameters<typeof resolveBookingAuthority>[0]>) {
  return resolveBookingAuthority({
    step: "day",
    collected: {},
    offeredDoctorIds: [],
    offeredDays: [],
    offeredSlots: [],
    closing: false,
    terminal: false,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// §2 — tool exposure in the FINAL model request
// ---------------------------------------------------------------------------

describe("P11G §2 — the expected tool reaches the provider request", () => {
  it("mounts every stage's allowed tools, and only those", async () => {
    for (const stage of BOOKING_STAGES) {
      const { capture } = await runTurn({ stage });
      expect(capture.tools.slice().sort()).toEqual(
        allowedToolsForStage(stage, [...PATIENT_TOOL_NAMES]).slice().sort(),
      );
    }
  });

  it("puts the authoritative read tool of each booking step in the request", async () => {
    const expected: ReadonlyArray<[BookingStage, string]> = [
      ["selecting_department", "prepare_booking"],
      ["selecting_doctor", "list_doctors"],
      ["selecting_day", "list_available_days"],
      ["selecting_time", "check_availability"],
      ["confirming", "create_preliminary_booking"],
      // The window the production trace spent eleven turns in.
      ["intake_collecting", "list_available_days"],
      ["intake_collecting", "check_availability"],
    ];
    for (const [stage, tool] of expected) {
      const { capture } = await runTurn({ stage });
      expect(capture.tools, `${stage} must expose ${tool}`).toContain(tool);
    }
  });

  /**
   * P11I-R — the narrowing above depends on the server having *proved* the
   * question's shape. This one does not: it keys on the directory read having
   * actually happened, so wording nobody enumerated gets the same protection.
   */
  it("drops every booking workflow tool after the directory is read, whatever the wording", async () => {
    const ledger = createGroundingLedger();
    ledger.record("list_clinic_departments", {
      scope: "clinic_directory",
      complete: true,
      departments: [{ id: DEPARTMENT, name: "Unit 1" }],
      department_count: 1,
    });
    // No `clinicDirectoryQuery`: the server could not prove the shape, exactly
    // as it cannot for a paraphrase, a dialect form, or a typo.
    const { capture } = await runTurn({
      stage: "selecting_time",
      authority: authorityFor({ step: "time", offeredSlots: [`${DAY}T09:00`] }),
      grounding: ledger,
    });
    for (const workflow of [
      "prepare_booking",
      "list_doctors",
      "check_availability",
      "list_available_days",
      "create_preliminary_booking",
      "register_patient",
    ]) {
      expect(capture.tools, `${workflow} must be gone after a directory read`).not.toContain(
        workflow,
      );
    }
    // Narrowing only — it never re-exposes anything the stage removed.
    expect(
      capture.tools.every((name) =>
        allowedToolsForStage("selecting_time", [...PATIENT_TOOL_NAMES]).includes(name),
      ),
    ).toBe(true);
  });

  it("leaves toolChoice on auto when no authority is required", async () => {
    const { capture } = await runTurn({ stage: "selecting_day", authority: null });
    expect(capture.toolChoice).toEqual({ type: "auto" });
  });

  it("narrows a clinic-directory turn to its read-only operation for every step", async () => {
    const directoryAuthority = authorityFor({
      step: "time",
      clinicDirectoryQuery: true,
    });
    const { capture } = await runTurn({
      stage: "intake_collecting",
      authority: directoryAuthority,
    });
    expect(capture.tools).toEqual(["list_clinic_departments"]);
    expect(capture.toolChoice).toEqual({
      type: "tool",
      toolName: "list_clinic_departments",
    });
  });
});

// ---------------------------------------------------------------------------
// §7 — the tool-necessity contract
// ---------------------------------------------------------------------------

describe("P11G §7 — tool necessity", () => {
  it("requires an authoritative roster when no roster has been offered", () => {
    const authority = authorityFor({ step: "doctor" });
    expect(authority.requirement).toBe("read_authority");
    expect(authority.operation).toBe("list_doctors");
    expect(authority.satisfied).toBe(false);
  });

  it("requires authoritative days when none have been offered", () => {
    const authority = authorityFor({ step: "day" });
    expect(authority.operation).toBe("list_available_days");
  });

  it("requires authoritative times when none have been offered", () => {
    const authority = authorityFor({ step: "time", collected: { appointment_date: DAY } });
    expect(authority.operation).toBe("check_availability");
  });

  it("waits at the confirm step until the patient explicitly approves the summary", () => {
    expect(authorityFor({ step: "confirm" })).toMatchObject({
      requirement: "none",
      operation: null,
      reason: "needs_booking_confirmation",
    });
    const authority = authorityFor({ step: "confirm", explicitBookingConfirmation: true });
    expect(authority.requirement).toBe("write_authority");
    expect(authority.operation).toBe("create_preliminary_booking");
  });

  // §7's second half: this must REDUCE calls, not create tool spam.
  it("requires nothing when a committed roster already answers the step", () => {
    const authority = authorityFor({ step: "doctor", offeredDoctorIds: [DOCTOR] });
    expect(authority.requirement).toBe("none");
    expect(authority.satisfied).toBe(true);
    expect(authority.reason).toBe("committed_roster");
  });

  it("requires nothing when committed days already answer the step", () => {
    const authority = authorityFor({ step: "day", offeredDays: [DAY] });
    expect(authority.requirement).toBe("none");
    expect(authority.satisfied).toBe(true);
  });

  it("requires nothing when committed slots for THIS day answer the step", () => {
    const authority = authorityFor({
      step: "time",
      collected: { appointment_date: DAY },
      offeredSlots: [`${DAY}T09:00`, `${DAY}T09:30`],
    });
    expect(authority.requirement).toBe("none");
    expect(authority.satisfied).toBe(true);
  });

  it("does NOT accept slots offered for a different day", () => {
    const authority = authorityFor({
      step: "time",
      collected: { appointment_date: DAY },
      offeredSlots: [`${OTHER_DAY}T09:00`],
    });
    expect(authority.requirement).toBe("read_authority");
    expect(authority.operation).toBe("check_availability");
  });

  // §3 — "شكراً" must not trigger a tool just because tools exist.
  it("requires nothing from a bare closing, at any step", () => {
    for (const step of ["department", "doctor", "day", "time", "confirm"] as const) {
      const authority = authorityFor({ step, closing: true });
      expect(authority.requirement, `${step} closing`).toBe("none");
      expect(authority.operation).toBeNull();
    }
  });

  it("requires nothing once the booking is submitted or escalated", () => {
    expect(authorityFor({ step: "confirm", terminal: true }).requirement).toBe("none");
    expect(authorityFor({ step: "done" }).requirement).toBe("none");
  });

  it("treats intake staging as write authority once the ladder reaches it", () => {
    const authority = authorityFor({ step: "intake" });
    expect(authority.requirement).toBe("write_authority");
    expect(authority.operation).toBe("register_patient");
    expect(authority.reason).toBe("needs_intake");
  });
});

// ---------------------------------------------------------------------------
// §3 / §8 — forcing is narrow, and can never widen the mount
// ---------------------------------------------------------------------------

describe("P11G §3/§8 — the pin is narrow", () => {
  it("pins toolChoice to the required tool on the first step", async () => {
    const authority = authorityFor({ step: "day" });
    const { capture, observer } = await runTurn({ stage: "selecting_day", authority });
    expect(capture.toolChoice).toEqual({
      type: "tool",
      toolName: "list_available_days",
    });
    expect(observer.forced).toBe(true);
  });

  it("does not pin when a committed offer already satisfies the step", async () => {
    const authority = authorityFor({ step: "day", offeredDays: [DAY] });
    const { capture, observer } = await runTurn({ stage: "selecting_day", authority });
    expect(capture.toolChoice).toEqual({ type: "auto" });
    expect(observer.forced).toBe(false);
  });

  it("never pins a tool the stage table has hidden", () => {
    // `create_preliminary_booking` is unmounted before `selecting_time`.
    const authority = authorityFor({ step: "confirm" });
    const mounted = allowedToolsForStage("selecting_department", [...PATIENT_TOOL_NAMES]);
    expect(mounted).not.toContain("create_preliminary_booking");
    expect(
      shouldForceAuthority({ authority, mountedTools: mounted, stepNumber: 0 }),
    ).toBe(false);
  });

  it("never pins after the first step, so the loop always terminates", () => {
    const authority = authorityFor({ step: "day" });
    const mounted = allowedToolsForStage("selecting_day", [...PATIENT_TOOL_NAMES]);
    expect(shouldForceAuthority({ authority, mountedTools: mounted, stepNumber: 0 })).toBe(true);
    for (const stepNumber of [1, 2, 3, 4, 5]) {
      expect(shouldForceAuthority({ authority, mountedTools: mounted, stepNumber })).toBe(false);
    }
  });

  it("only ever names a tool that is in the certified patient mount", () => {
    for (const step of ["department", "doctor", "day", "time", "intake", "confirm", "done"] as const) {
      const authority = authorityFor({ step, collected: { appointment_date: DAY } });
      if (!authority.operation) continue;
      expect(PATIENT_TOOL_NAMES as readonly string[]).toContain(authority.operation);
    }
  });
});

// ---------------------------------------------------------------------------
// §4 / §12 — the prompt contract, in the turn's language
// ---------------------------------------------------------------------------

describe("P11G §4/§12 — the authority line", () => {
  it("names the operation in the system prompt of the turn that needs it", async () => {
    const authority = authorityFor({ step: "day" });
    const { capture } = await runTurn({ stage: "selecting_day", authority, locale: "en" });
    expect(capture.system).toContain("list_available_days");
    expect(capture.system).toContain("live clinic data");
  });

  it("writes the Arabic line for an Arabic turn and no English into it", () => {
    const line = bookingAuthorityInstruction("ar", authorityFor({ step: "day" }))!;
    expect(line).toContain("list_available_days");
    // Tool names are identifiers, not prose. Everything else must be Arabic.
    expect(line.replace(/list_available_days/g, "")).not.toMatch(/[A-Za-z]/);
  });

  it("writes the English line for an English turn", () => {
    const line = bookingAuthorityInstruction("en", authorityFor({ step: "time" }))!;
    expect(line).toMatch(/check_availability/);
    expect(line).not.toMatch(/[؀-ۿ]/);
  });

  it("tells the model NOT to call again when the offer is already committed", () => {
    const satisfied = authorityFor({ step: "day", offeredDays: [DAY] });
    for (const locale of ["ar", "en"] as const) {
      const line = bookingAuthorityInstruction(locale, satisfied)!;
      expect(line).toBeTruthy();
      // P11I-R — the instruction is scoped to the *booking* step. It must not
      // tell the model to stop calling tools altogether, which would suppress
      // the read-only tool that answers a side question on the same turn.
      expect(line.toLowerCase()).toMatch(
        /do not call that booking tool again|لا تستدعِ أداة الحجز نفسها/,
      );
      expect(line.toLowerCase()).not.toMatch(
        /do not call a tool again|لا تستدعِ أداة من جديد/,
      );
    }
  });

  it("says nothing at all on a turn that needs nothing", () => {
    expect(bookingAuthorityInstruction("ar", authorityFor({ step: "done" }))).toBeNull();
    expect(bookingAuthorityInstruction("en", authorityFor({ step: "done" }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §5 — the stage/ladder disagreement the production trace lived in
// ---------------------------------------------------------------------------

describe("P11G §5 — intake_collecting spans the calendar window", () => {
  const ladder = (collected: Record<string, unknown>) =>
    nextBookingStep({
      collected,
      linked: false,
      bookingForOther: false,
      intakeStaged: false,
      submitted: false,
    });

  it("asks for the calendar, not the intake form, while the day is missing", () => {
    // Exactly the production state on turns 40–42: department and doctor
    // committed, no file yet, so `deriveStage` says `intake_collecting`.
    const step = ladder({ department_id: DEPARTMENT, doctor_id: DOCTOR });
    expect(step).toBe("day");
    expect(resolveBookingAuthority({
      step,
      collected: {},
      offeredDoctorIds: [DOCTOR],
      offeredDays: [],
      offeredSlots: [],
      closing: false,
      terminal: false,
    }).operation).toBe("list_available_days");
  });

  it("asks for times once the day is committed and no slots were offered", () => {
    const step = ladder({
      department_id: DEPARTMENT,
      doctor_id: DOCTOR,
      appointment_date: DAY,
    });
    expect(step).toBe("time");
  });

  it("the intake_collecting banner no longer forbids the calendar", async () => {
    const { capture } = await runTurn({ stage: "intake_collecting", locale: "en" });
    expect(capture.system).toMatch(/keep helping with the day and the time/);
  });
});

// ---------------------------------------------------------------------------
// §11 — genericity: no clinic-specific string can reach this contract
// ---------------------------------------------------------------------------

describe("P11G §11 — genericity", () => {
  it("resolves identically for any number of departments and any names", () => {
    // The contract takes ids and counts, never names. Three, twenty and a
    // hundred generated departments produce the same requirement because the
    // only thing that varies is which id is committed.
    for (const count of [3, 20, 100]) {
      const ids = Array.from({ length: count }, (_, index) => `dept-${index}`);
      for (const id of [ids[0]!, ids[ids.length - 1]!]) {
        const step = nextBookingStep({
          collected: { department_id: id },
          linked: false,
          bookingForOther: false,
          intakeStaged: false,
          submitted: false,
        });
        expect(step).toBe("doctor");
        expect(
          resolveBookingAuthority({
            step,
            collected: { department_id: id },
            offeredDoctorIds: [],
            offeredDays: [],
            offeredSlots: [],
            closing: false,
            terminal: false,
          }).operation,
        ).toBe("list_doctors");
      }
    }
  });

  it("contains no department or doctor name in the source of the contract", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile("lib/ai/booking-authority.ts", "utf8"),
    );
    // The only proper nouns permitted are tool names.
    for (const banned of ["Dermatology", "جلدية", "Cardiology", "علاج طبيعي"]) {
      expect(source).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// §6 / §14 — the model tool path is observable separately from the fallback
// ---------------------------------------------------------------------------

describe("P11G §6/§14 — MODEL_TOOL_PATH vs DETERMINISTIC_CONTINUATION_PATH", () => {
  it("records the tools the model asked for, so a prose turn is distinguishable", async () => {
    const observer = createAuthorityObserver();
    let step = 0;
    const model = new MockLanguageModelV3({
      doGenerate: (async () => {
        step += 1;
        if (step === 1) {
          return {
            finishReason: "tool-calls",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "get_clinic_info",
                input: "{}",
              },
            ],
            warnings: [],
          };
        }
        return {
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          content: [{ type: "text", text: "done" }],
          warnings: [],
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    });
    const execution = makeExecution([]);
    const agent = createPatientAgent({
      clinicId: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
      locale: "en",
      execution: { ...execution, model } as typeof execution,
      bookingStage: "selecting_day",
      observer,
    });
    await agent.generate({ messages: [{ role: "user", content: "..." }] });
    // The point is not which tool: it is that a turn with a tool call and a
    // turn without one are now different rows in the audit rather than two
    // identical `tool_called: "none"` lines.
    expect(observer.requested).toContain("get_clinic_info");
  });

  it("records an empty request list when the model answers in prose", async () => {
    const { observer } = await runTurn({ stage: "selecting_day" });
    expect(observer.requested).toEqual([]);
    expect(observer.forced).toBe(false);
  });
});
