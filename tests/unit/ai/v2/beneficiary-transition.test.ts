/**
 * The beneficiary → third-party transition, frozen as behaviour contracts.
 *
 * The live V2 session that produced these:
 *
 * ```
 *   patient:   اه عايز احجز موعد
 *   assistant: الحجز ده ليك إنت ولا لحد تاني؟      ← correct
 *   patient:   لحد تاني
 *   assistant: تقصد أنهي واحد في دول: self، other؟  ← the enum, to a patient
 *   patient:   Other
 *   assistant: Sorry — I couldn't match that…       ← unresolved, and in English
 *   patient:   ببساطة الحجز لشخص تاني
 * ```
 *
 * Three defects in one chain, and only the first is a cause: the offer carried
 * the canonical values as its *labels*, so a turn the engine could not settle
 * rendered them; the resolver's own lexicon did not know the token it had just
 * shown the patient; and «لحد تاني» reached the engine as `affirm_offer`, which
 * against a two-option offer is ambiguous by construction however unambiguous
 * the sentence was.
 *
 * Assertions are on the properties — a canonical value committed, a frame still
 * running, no internal token in any rendered sentence — never on the wording.
 * The tool layer is stubbed at the module boundary; the flow definitions, the
 * engine, the preconditions and the composer are the real ones.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const stubs = vi.hoisted(() => ({
  readDepartments: vi.fn(),
  readDoctors: vi.fn(),
  resolveDoctorSpoken: vi.fn(),
  resolveDepartmentSpoken: vi.fn(),
  resolveDepartmentNamed: vi.fn(),
  readAvailableDays: vi.fn(),
  readAvailableSlots: vi.fn(),
  readPatientPackages: vi.fn(),
  readPublicPackages: vi.fn(),
  readServices: vi.fn(),
  readPatientDocuments: vi.fn(),
  readDocumentLink: vi.fn(),
  readMyAppointments: vi.fn(),
  readTreatingDoctors: vi.fn(),
  readClinicInfo: vi.fn(),
  readClinicFaq: vi.fn(),
  readClinicInsurance: vi.fn(),
  readRescheduleTarget: vi.fn(),
  readKnownDepartments: vi.fn(),
  resolveIdentity: vi.fn(),
  stageIntake: vi.fn(),
  commitBooking: vi.fn(),
  commitCancellation: vi.fn(),
  commitReschedule: vi.fn(),
}));

vi.mock("@/lib/ai/v2/tools", () => stubs);

import type { Command } from "@/lib/ai/v2/commands";
import { EMPTY_FLOW_STATE, type FlowState } from "@/lib/ai/v2/flow-state";
import { runEngine, type Effect } from "@/lib/ai/v2/engine";
import { FLOW_REGISTRY } from "@/lib/ai/v2/flows";
import { composeDeterministic } from "@/lib/ai/v2/composer";
import type { TurnContext } from "@/lib/ai/v2/context";
import { normalizeBeneficiary } from "@/lib/ai/v2/normalize";

const NOW = new Date("2026-09-05T09:00:00.000Z");
const AT = NOW.toISOString();

const DEPARTMENTS = [
  { value: "dept-derma", label: "الجلدية", source: "clinic_directory" as const },
  { value: "dept-cardio", label: "القلب", source: "clinic_directory" as const },
];

/** The canonical tokens. None of them may appear in a sentence a patient reads. */
const INTERNAL_TOKENS = ["self", "other"] as const;

function context(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    clinicId: "clinic-1",
    conversationId: "conv-1",
    turn: { text: "", receivedAt: AT, locale: "ar", attachments: [] },
    episode: { turns: [] },
    flows: EMPTY_FLOW_STATE,
    durable: {
      treatingDoctors: async () => [],
      knownDepartments: async () => [],
      activePackages: async () => [],
      issuedDocuments: async () => [],
      appointments: async () => [],
      canonicalName: async () => null,
    },
    history: { search: async () => [] },
    identity: "linked",
    patientId: "patient-sender",
    clinic: {
      name: "عيادة الابتسامة",
      timeZone: "Africa/Cairo",
      locale: "ar",
      country: "EG",
      timeFormat: "24h",
    },
    style: {
      language: "ar",
      arabicStyle: "egyptian",
      tone: "friendly",
      styleInstruction: null,
    },
    now: NOW,
    ...overrides,
  };
}

function turn(input: {
  commands: readonly Command[];
  text: string;
  flows?: FlowState;
  locale?: "ar" | "en";
}) {
  return runEngine({
    context: context({
      flows: input.flows ?? EMPTY_FLOW_STATE,
      turn: {
        text: input.text,
        receivedAt: AT,
        locale: input.locale ?? "ar",
        attachments: [],
      },
    }),
    commands: input.commands,
    registry: FLOW_REGISTRY,
  });
}

function reply(effects: readonly Effect[], locale: "ar" | "en" = "ar") {
  return composeDeterministic({ effects, locale }).text;
}

/** Turn 1 of the live session: the booking starts and the question is asked. */
async function bookingAwaitingBeneficiary(locale: "ar" | "en" = "ar") {
  const result = await turn({
    commands: [{ kind: "start_flow", flow: "book_appointment" }],
    text: locale === "ar" ? "اه عايز احجز موعد" : "I'd like to book an appointment",
    locale,
  });
  const frame = result.state.stack.find((entry) => entry.flow === "book_appointment");
  expect(frame?.offer?.slot).toBe("beneficiary");
  return result;
}

function bookingFrame(state: FlowState) {
  return state.stack.find(
    (frame) => frame.flow === "book_appointment" && frame.status === "active",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  stubs.readDepartments.mockResolvedValue(DEPARTMENTS);
  stubs.readDoctors.mockResolvedValue([]);
  stubs.readKnownDepartments.mockResolvedValue([]);
  stubs.resolveDepartmentSpoken.mockResolvedValue([]);
  stubs.resolveDepartmentNamed.mockResolvedValue({ kind: "unresolved" });
  stubs.readClinicInfo.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// 1. The lexicon
// ---------------------------------------------------------------------------

describe("reading who a booking is for", () => {
  const OTHER = [
    "لحد تاني",
    "لشخص تاني",
    "لحد آخر",
    "الحجز لشخص تاني",
    "ببساطة الحجز لشخص تاني",
    "مش ليا",
    "مش ليا انا",
    "مش لي",
    "مش انا",
    "مش لنفسي",
    "لمراتي",
    "لبنتي",
    "عايز احجز لصاحبي",
    "for someone else",
    "someone else",
    "for my wife",
    "it's for a friend",
    "not for me",
  ];
  const SELF = [
    "ليا",
    "لنفسي",
    "الحجز ليا",
    "لا قصدي ليا أنا",
    "أنا",
    "for me",
    "myself",
    "it's for me",
  ];

  it.each(OTHER)("reads «%s» as a third-party booking", (spoken) => {
    expect(normalizeBeneficiary(spoken)).toBe("other");
  });

  it.each(SELF)("reads «%s» as a booking for the sender", (spoken) => {
    expect(normalizeBeneficiary(spoken)).toBe("self");
  });

  /**
   * The tokens the server uses internally. A patient should never see one —
   * but one reached a patient in the live session, and refusing to understand
   * our own vocabulary after showing it is the worst of both worlds.
   */
  it.each([
    ["Other", "other"],
    ["other", "other"],
    ["Self", "self"],
    ["self", "self"],
  ])("accepts the canonical token «%s» it once leaked", (spoken, expected) => {
    expect(normalizeBeneficiary(spoken)).toBe(expected);
  });

  it("says nothing about a message that does not answer the question", () => {
    expect(normalizeBeneficiary("عندي استفسار")).toBeNull();
    expect(normalizeBeneficiary("")).toBeNull();
    expect(normalizeBeneficiary("مراتي تعبانة")).toBeNull();
    // «مشي» is a word, not a negation of «ي».
    expect(normalizeBeneficiary("مشي")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The live failure, turn by turn
// ---------------------------------------------------------------------------

describe("«لحد تاني» in answer to «الحجز ده ليك إنت ولا لحد تاني؟»", () => {
  /**
   * The command the model actually emitted. Against a two-option offer with no
   * primary, a bare affirmation is ambiguous by construction — which is how the
   * enum came to be rendered.
   */
  it("commits `other` even when the interpreter read it as a bare yes", async () => {
    const opened = await bookingAwaitingBeneficiary();
    const offerId = bookingFrame(opened.state)!.offer!.id;
    const result = await turn({
      commands: [{ kind: "affirm_offer", offerId }],
      text: "لحد تاني",
      flows: opened.state,
    });
    expect(bookingFrame(result.state)?.slots.beneficiary?.value).toBe("other");
    expect(result.trace).toContain("canonical_answer_reconciled");
  });

  it("commits `other` when the interpreter read it as the value it is", async () => {
    const opened = await bookingAwaitingBeneficiary();
    const result = await turn({
      commands: [{ kind: "set_slot", slot: "beneficiary", value: "لحد تاني" }],
      text: "لحد تاني",
      flows: opened.state,
    });
    expect(bookingFrame(result.state)?.slots.beneficiary?.value).toBe("other");
  });

  it("commits `other` when the interpreter gave up entirely", async () => {
    const opened = await bookingAwaitingBeneficiary();
    const result = await turn({
      commands: [{ kind: "ask_clarification", reason: "ambiguous_value" }],
      text: "لحد تاني",
      flows: opened.state,
    });
    expect(bookingFrame(result.state)?.slots.beneficiary?.value).toBe("other");
  });

  it("never shows the patient the canonical values", async () => {
    const opened = await bookingAwaitingBeneficiary();
    const offerId = bookingFrame(opened.state)!.offer!.id;
    for (const text of ["لحد تاني", "Other", "ببساطة الحجز لشخص تاني"]) {
      const result = await turn({
        commands: [{ kind: "affirm_offer", offerId }],
        text,
        flows: opened.state,
      });
      const said = `${reply(opened.effects)}\n${reply(result.effects)}`;
      for (const token of INTERNAL_TOKENS) {
        expect(said).not.toMatch(new RegExp(`\\b${token}\\b`, "i"));
      }
    }
  });

  /**
   * The offer is the only place the two options are ever written down, so it is
   * the only place the leak could come from. `value` stays canonical.
   */
  it("labels the two options in prose, never with the value beside them", async () => {
    for (const locale of ["ar", "en"] as const) {
      const opened = await bookingAwaitingBeneficiary(locale);
      const options = bookingFrame(opened.state)!.offer!.options;
      expect(options.map((option) => option.value)).toEqual(["self", "other"]);
      for (const option of options) {
        expect(option.label.toLowerCase()).not.toBe(String(option.value));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The transition
// ---------------------------------------------------------------------------

describe("once the beneficiary is settled", () => {
  it("keeps the booking frame it started, rather than beginning a new one", async () => {
    const opened = await bookingAwaitingBeneficiary();
    const result = await turn({
      commands: [{ kind: "affirm_offer", offerId: bookingFrame(opened.state)!.offer!.id }],
      text: "لحد تاني",
      flows: opened.state,
    });
    const frames = result.state.stack.filter((frame) => frame.flow === "book_appointment");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.status).toBe("active");
    expect(result.trace).not.toContain("start_flow_book_appointment");
  });

  /**
   * The next rung, and only the next rung. The intake that opens a file for the
   * third party is a later step of this same frame — it needs a department, a
   * doctor, a day and a time first — so what "transition" means here is that
   * the flow advances *within* the frame the beneficiary answer belongs to.
   */
  it("advances the same frame to the next unfilled slot", async () => {
    const opened = await bookingAwaitingBeneficiary();
    const result = await turn({
      commands: [{ kind: "affirm_offer", offerId: bookingFrame(opened.state)!.offer!.id }],
      text: "لحد تاني",
      flows: opened.state,
    });
    const frame = bookingFrame(result.state)!;
    expect(frame.slots.beneficiary?.value).toBe("other");
    expect(frame.offer?.slot).toBe("department");
  });

  it("does not offer the sender's own known departments to a third-party booking", async () => {
    const knownDepartments = vi.fn(async () => [
      { value: "dept-cardio", label: "القلب", source: "patient_history" as const },
    ]);
    const opened = await bookingAwaitingBeneficiary();
    const result = await runEngine({
      context: context({
        flows: opened.state,
        turn: { text: "لحد تاني", receivedAt: AT, locale: "ar", attachments: [] },
        durable: { ...context().durable, knownDepartments },
      }),
      commands: [{ kind: "set_slot", slot: "beneficiary", value: "لحد تاني" }],
      registry: FLOW_REGISTRY,
    });
    expect(bookingFrame(result.state)?.slots.beneficiary?.value).toBe("other");
    // The durable read is gated on `beneficiary === "self"`. A booking for
    // somebody else must not be seeded from the sender's own history.
    expect(knownDepartments).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Corrections
// ---------------------------------------------------------------------------

describe("changing who the booking is for", () => {
  it("«لا قصدي ليا أنا» moves it back to the sender, deterministically", async () => {
    const opened = await bookingAwaitingBeneficiary();
    const settled = await turn({
      commands: [{ kind: "set_slot", slot: "beneficiary", value: "لحد تاني" }],
      text: "لحد تاني",
      flows: opened.state,
    });
    const corrected = await turn({
      commands: [{ kind: "correct_slot", slot: "beneficiary", value: "لا قصدي ليا أنا" }],
      text: "لا قصدي ليا أنا",
      flows: settled.state,
    });
    expect(bookingFrame(corrected.state)?.slots.beneficiary?.value).toBe("self");
  });

  it("drops what the old beneficiary's answers decided", async () => {
    const opened = await bookingAwaitingBeneficiary();
    const settled = await turn({
      commands: [{ kind: "set_slot", slot: "beneficiary", value: "لحد تاني" }],
      text: "لحد تاني",
      flows: opened.state,
    });
    stubs.resolveDepartmentNamed.mockResolvedValue({
      kind: "resolved",
      value: DEPARTMENTS[0]!.value,
      label: DEPARTMENTS[0]!.label,
    });
    const withDepartment = await turn({
      commands: [{ kind: "set_slot", slot: "department", value: "الجلدية" }],
      text: "الجلدية",
      flows: settled.state,
    });
    expect(bookingFrame(withDepartment.state)?.slots.department?.value).toBe("dept-derma");
    const corrected = await turn({
      commands: [{ kind: "correct_slot", slot: "beneficiary", value: "لا قصدي ليا أنا" }],
      text: "لا قصدي ليا أنا",
      flows: withDepartment.state,
    });
    const frame = bookingFrame(corrected.state)!;
    expect(frame.slots.beneficiary?.value).toBe("self");
    // The declared cascade, unchanged: a booking for a different person is not
    // the same booking with one field edited.
    expect(frame.slots.department).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Language
// ---------------------------------------------------------------------------

describe("the language of the answer", () => {
  it("stays Arabic through the whole beneficiary exchange", async () => {
    const opened = await bookingAwaitingBeneficiary("ar");
    const answered = await turn({
      commands: [{ kind: "affirm_offer", offerId: bookingFrame(opened.state)!.offer!.id }],
      text: "لحد تاني",
      flows: opened.state,
    });
    const said = `${reply(opened.effects, "ar")}\n${reply(answered.effects, "ar")}`;
    expect(said).toMatch(/[ؠ-ي]/);
    // The English fallback sentence — the one the live session produced — has
    // no route into an Arabic turn.
    expect(said).not.toMatch(/[A-Za-z]{4,}/);
  });

  it("keeps a message it cannot read in the language of the turn", async () => {
    const opened = await bookingAwaitingBeneficiary("ar");
    const puzzled = await turn({
      commands: [{ kind: "set_slot", slot: "beneficiary", value: "؟؟؟" }],
      text: "؟؟؟",
      flows: opened.state,
    });
    expect(reply(puzzled.effects, "ar")).not.toMatch(/[A-Za-z]{4,}/);
  });
});

// ---------------------------------------------------------------------------
// 6. The blast radius
// ---------------------------------------------------------------------------

describe("slots that select a clinic record", () => {
  /**
   * The guard on `canonicalAnswer`. Re-reading the turn text for a slot that
   * selects a record would turn «لا مش الجلدية» into a booking in dermatology,
   * because the rejection contains the name of the thing being rejected.
   */
  it("still treats a rejection as a rejection", async () => {
    const opened = await bookingAwaitingBeneficiary();
    const settled = await turn({
      commands: [{ kind: "set_slot", slot: "beneficiary", value: "لحد تاني" }],
      text: "لحد تاني",
      flows: opened.state,
    });
    const departmentOffer = bookingFrame(settled.state)!.offer!;
    expect(departmentOffer.slot).toBe("department");
    const rejected = await turn({
      commands: [{ kind: "reject_offer", offerId: departmentOffer.id }],
      text: "لا مش الجلدية",
      flows: settled.state,
    });
    expect(bookingFrame(rejected.state)?.slots.department).toBeUndefined();
  });

  it("only reconciles while a canonical step's own offer is open", async () => {
    const opened = await bookingAwaitingBeneficiary();
    const settled = await turn({
      commands: [{ kind: "set_slot", slot: "beneficiary", value: "لحد تاني" }],
      text: "لحد تاني",
      flows: opened.state,
    });
    const later = await turn({
      commands: [{ kind: "ask_clarification", reason: "unspecified_request" }],
      // Words the beneficiary lexicon reads, arriving while the department
      // question is the open one. Nothing about the beneficiary may move.
      text: "لشخص تاني",
      flows: settled.state,
    });
    expect(later.trace).not.toContain("canonical_answer_reconciled");
    expect(bookingFrame(later.state)?.slots.beneficiary?.value).toBe("other");
  });
});
