/**
 * Two manual-QA misreadings, as deterministic contracts.
 *
 * ```
 *   assistant: كتبت الاسم كده: Saad Ibrahim — صح كده؟
 *   patient:   اسمه Soad اما Ibrahim انت كاتبها صح   -> the whole name replaced
 *
 *   assistant: ممكن رقم تليفون المريض؟
 *   patient:   خلي رقمها رقمي لأنها مراتي            -> the same question again
 * ```
 *
 * Both are failures of *interpretation*, and every assertion below is about
 * interpretation: which value a sentence resolves to, and — at least as
 * important — which ones it must not. The flow definitions, the engine, the
 * preconditions and the resolvers are all the real ones; only the tool layer is
 * stubbed, so the ownership and identity invariants are asserted against the
 * arguments the real steps actually pass.
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
import {
  EMPTY_FLOW_STATE,
  activeFrame,
  newFrame,
  type FlowState,
  type Slot,
} from "@/lib/ai/v2/flow-state";
import { runEngine, type Effect } from "@/lib/ai/v2/engine";
import { FLOW_REGISTRY } from "@/lib/ai/v2/flows";
import type { TurnContext } from "@/lib/ai/v2/context";
import { readPartialNameCorrection } from "@/lib/ai/v2/name-correction";
import {
  participantPhone,
  readsAsOwnNumberReference,
} from "@/lib/ai/v2/self-phone-reference";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const AT = NOW.toISOString();

/** The number the requester is messaging the clinic from. */
const SENDER = "+905321112233";

function slotValue(value: string): Slot {
  return { value, provenance: "spoken", at: AT };
}

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
    patientId: "patient-requester",
    participantAddress: SENDER,
    clinic: {
      name: "Clinic",
      timeZone: "Europe/Istanbul",
      locale: "ar",
      country: "TR",
      timeFormat: "24h",
    },
    style: { language: "ar", arabicStyle: "egyptian", tone: "friendly", styleInstruction: null },
    now: NOW,
    ...overrides,
  };
}

function ctx(text: string, flows: FlowState, overrides: Partial<TurnContext> = {}) {
  return context({
    flows,
    turn: { text, receivedAt: AT, locale: "ar", attachments: [] },
    ...overrides,
  });
}

async function turn(commands: readonly Command[], on: TurnContext) {
  return runEngine({ context: on, commands, registry: FLOW_REGISTRY });
}

function askedSlot(effects: readonly Effect[]): string | null {
  const ask = effects.find((effect) => effect.kind === "ask");
  return ask && ask.kind === "ask" ? ask.slot : null;
}

/** A booking for somebody else, past the calendar and into the intake. */
function thirdPartyIntake(
  slots: Record<string, Slot> = {},
  extra: Record<string, unknown> = {},
): FlowState {
  return {
    version: 1,
    stack: [
      {
        ...newFrame({ flow: "book_appointment", at: AT }),
        slots: {
          beneficiary: slotValue("other"),
          department: slotValue("dept-pt"),
          doctor: slotValue("doc-nabil"),
          day: slotValue("2026-09-10"),
          time: slotValue("12:15"),
          ...slots,
        },
        ...extra,
      },
    ],
  };
}

/** The same booking, for the sender themselves. */
function selfIntake(slots: Record<string, Slot> = {}): FlowState {
  return {
    version: 1,
    stack: [
      {
        ...newFrame({ flow: "book_appointment", at: AT }),
        slots: {
          beneficiary: slotValue("self"),
          department: slotValue("dept-pt"),
          doctor: slotValue("doc-nabil"),
          day: slotValue("2026-09-10"),
          time: slotValue("12:15"),
          ...slots,
        },
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stubs.readDepartments.mockResolvedValue([]);
  stubs.readDoctors.mockResolvedValue([]);
  stubs.resolveDoctorSpoken.mockResolvedValue({ kind: "unresolved" });
  stubs.resolveDepartmentSpoken.mockResolvedValue([]);
  stubs.resolveDepartmentNamed.mockResolvedValue({ kind: "unresolved" });
  stubs.readServices.mockResolvedValue({ groups: [], currency: "TRY", total: 0 });
  stubs.readPublicPackages.mockResolvedValue([]);
  stubs.readPatientPackages.mockResolvedValue([]);
  stubs.readPatientDocuments.mockResolvedValue([]);
  stubs.readMyAppointments.mockResolvedValue([]);
  stubs.readKnownDepartments.mockResolvedValue([]);
  stubs.readTreatingDoctors.mockResolvedValue([]);
  stubs.readAvailableDays.mockResolvedValue({
    ok: true,
    windowStart: "2026-09-05",
    windowEnd: "2026-09-11",
    days: [{ value: "2026-09-10", label: "2026-09-10", source: "clinic_directory" }],
  });
  stubs.readAvailableSlots.mockResolvedValue({
    ok: true,
    times: [{ value: "12:15", label: "12:15", source: "clinic_directory" }],
  });
  stubs.resolveIdentity.mockResolvedValue({ kind: "none" });
  stubs.stageIntake.mockResolvedValue({ ok: true });
  stubs.commitBooking.mockResolvedValue({
    ok: true,
    appointmentId: "appt-1",
    packageSessionNumber: null,
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — a partial correction of a multi-part name
// ---------------------------------------------------------------------------

describe("the reading itself, in isolation", () => {
  it("replaces the one component the patient did not confirm", () => {
    expect(
      readPartialNameCorrection({
        current: "Saad Ibrahim",
        spoken: "اسمه Soad اما Ibrahim انت كاتبها صح",
      }),
    ).toEqual({ kind: "corrected", value: "Soad Ibrahim" });
  });

  it("replaces a second component the same way", () => {
    expect(
      readPartialNameCorrection({
        current: "Saad Ibrahim",
        spoken: "Saad صح بس التاني Ibrahiem",
      }),
    ).toEqual({ kind: "corrected", value: "Saad Ibrahiem" });
  });

  it("replaces one middle component of a four-part name", () => {
    expect(
      readPartialNameCorrection({
        current: "Mohamed Ahmed Hassan Ali",
        spoken: "Ahmed غلط، هو Ahmad والباقي صح",
      }),
    ).toEqual({ kind: "corrected", value: "Mohamed Ahmad Hassan Ali" });
  });

  it("replaces one middle component of a five-part name", () => {
    expect(
      readPartialNameCorrection({
        current: "Mohamed Ahmed Hassan Ali Farouk",
        spoken: "Hassan wrong, it is Hasan",
      }),
    ).toEqual({ kind: "corrected", value: "Mohamed Ahmed Hasan Ali Farouk" });
  });

  it("reads the same shape in English", () => {
    expect(
      readPartialNameCorrection({
        current: "Saad Ibrahim",
        spoken: "Ibrahim is correct, but it's Soad",
      }),
    ).toEqual({ kind: "corrected", value: "Soad Ibrahim" });
  });

  it("reads the same shape in an all-Arabic name", () => {
    expect(
      readPartialNameCorrection({
        current: "سعاد ابراهيم",
        spoken: "اسمه سعد مش سعاد",
      }),
    ).toEqual({ kind: "corrected", value: "سعد ابراهيم" });
  });

  it("refuses to guess when more than one component is unaccounted for", () => {
    expect(
      readPartialNameCorrection({
        current: "Saad Ibrahim Khalil",
        spoken: "اسمه Soad اما Ibrahim انت كاتبها صح",
      }),
    ).toEqual({ kind: "ambiguous" });
  });

  it("declines a full restatement, leaving the existing reading to it", () => {
    expect(
      readPartialNameCorrection({ current: "Ali Alzahrani", spoken: "لا خليه Ali Al Zahrani" }),
    ).toEqual({ kind: "none" });
    expect(
      readPartialNameCorrection({ current: "Ali Alzahrani", spoken: "Ali Al Zahrani" }),
    ).toEqual({ kind: "none" });
  });

  it("declines a sentence that names none of the stored components", () => {
    expect(
      readPartialNameCorrection({ current: "Saad Ibrahim", spoken: "مش عارف" }),
    ).toEqual({ kind: "none" });
    expect(
      readPartialNameCorrection({ current: "Saad Ibrahim", spoken: "Omar Khaled" }),
    ).toEqual({ kind: "none" });
  });

  it("declines a bare confirmation, which replaces nothing", () => {
    expect(
      readPartialNameCorrection({ current: "Saad Ibrahim", spoken: "Saad Ibrahim صح" }),
    ).toEqual({ kind: "none" });
  });
});

describe("a partial name correction, through the engine", () => {
  it("corrects one component of the proposal it is confirming", async () => {
    const named = await turn(
      [{ kind: "set_slot", slot: "full_name", value: "سعد ابراهيم" }],
      ctx("سعد ابراهيم", thirdPartyIntake()),
    );
    const offer = activeFrame(named.state)!.offer!;
    expect(offer.slot).toBe("full_name_latin");
    const proposed = String(offer.options[0]!.value);
    const [first, second] = proposed.split(" ");
    expect(first && second).toBeTruthy();

    // Only the first component is wrong; the second is confirmed by name.
    const text = `اسمه Soad اما ${second} انت كاتبها صح`;
    const corrected = await turn(
      [{ kind: "correct_slot", slot: "full_name_latin", value: text }],
      ctx(text, named.state),
    );
    expect(activeFrame(corrected.state)?.slots.full_name_latin?.value).toBe(`Soad ${second}`);
    // The Arabic name it is a spelling of is untouched, and the intake moves on.
    expect(activeFrame(corrected.state)?.slots.full_name?.value).toBe("سعد ابراهيم");
    expect(askedSlot(corrected.effects)).toBe("national_id");
  });

  it("corrects one middle component of a committed four-part name", async () => {
    const state = thirdPartyIntake({
      full_name: slotValue("محمد احمد حسن علي"),
      full_name_latin: slotValue("Mohamed Ahmed Hassan Ali"),
    });
    const text = "Ahmed غلط، هو Ahmad والباقي صح";
    const corrected = await turn(
      [{ kind: "correct_slot", slot: "full_name_latin", value: text }],
      ctx(text, state),
    );
    expect(activeFrame(corrected.state)?.slots.full_name_latin?.value).toBe(
      "Mohamed Ahmad Hassan Ali",
    );
  });

  it("does not mutate the name when the correction is ambiguous", async () => {
    const state = thirdPartyIntake({
      full_name: slotValue("سعد ابراهيم خليل"),
      full_name_latin: slotValue("Saad Ibrahim Khalil"),
    });
    const text = "اسمه Soad اما Ibrahim انت كاتبها صح";
    const result = await turn(
      [{ kind: "set_slot", slot: "full_name_latin", value: text }],
      ctx(text, state),
    );
    // The existing clarification, and the name exactly as it was.
    expect(activeFrame(result.state)?.slots.full_name_latin?.value).toBe("Saad Ibrahim Khalil");
    expect(
      result.effects.some(
        (effect) => effect.kind === "ask" && effect.key === "clarify.value_not_recognised",
      ),
    ).toBe(true);
  });

  it("still takes a whole replacement spelling out of «لا خليه ...»", async () => {
    const named = await turn(
      [{ kind: "set_slot", slot: "full_name", value: "علي الزهراني" }],
      ctx("علي الزهراني", thirdPartyIntake()),
    );
    const corrected = await turn(
      [{ kind: "set_slot", slot: "full_name_latin", value: "لا خليه Ali Al Zahrani" }],
      ctx("لا خليه Ali Al Zahrani", named.state),
    );
    expect(activeFrame(corrected.state)?.slots.full_name_latin?.value).toBe("Ali Al Zahrani");
    expect(askedSlot(corrected.effects)).toBe("national_id");
  });

  it("still keeps the Arabic name and proposes the English one", async () => {
    const named = await turn(
      [{ kind: "set_slot", slot: "full_name", value: "علي الزهراني" }],
      ctx("علي الزهراني", thirdPartyIntake()),
    );
    expect(activeFrame(named.state)?.slots.full_name?.value).toBe("علي الزهراني");
    // Proposed, never filed — the P10 behaviour, unchanged.
    expect(activeFrame(named.state)?.slots.full_name_latin).toBeUndefined();
    const offer = named.effects.find((effect) => effect.kind === "offer");
    expect(offer && offer.kind === "offer" ? offer.offer.slot : null).toBe("full_name_latin");
  });

  it("still files a name the patient wrote in English without asking", async () => {
    const named = await turn(
      [{ kind: "set_slot", slot: "full_name", value: "Ali Alzahrani" }],
      ctx("Ali Alzahrani", thirdPartyIntake()),
    );
    expect(activeFrame(named.state)?.slots.full_name_latin?.value).toBe("Ali Alzahrani");
  });

  it("still re-asks rather than filing a refusal as a name", async () => {
    const named = await turn(
      [{ kind: "set_slot", slot: "full_name", value: "علي الزهراني" }],
      ctx("علي الزهراني", thirdPartyIntake()),
    );
    const refused = await turn(
      [{ kind: "set_slot", slot: "full_name_latin", value: "مش عارف" }],
      ctx("مش عارف", named.state),
    );
    expect(activeFrame(refused.state)?.slots.full_name_latin).toBeUndefined();
  });

  it("reads a first name given for the first time as a name, not a correction", async () => {
    const named = await turn(
      [{ kind: "set_slot", slot: "full_name", value: "جهاد محمد" }],
      ctx("جهاد محمد", thirdPartyIntake()),
    );
    expect(activeFrame(named.state)?.slots.full_name?.value).toBe("جهاد محمد");
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — "use my number", for a third party
// ---------------------------------------------------------------------------

describe("the own-number reference, in isolation", () => {
  it.each([
    "استخدم رقم تلفوني",
    "خليها نفس رقمي",
    "خلي رقمها رقمي لأنها مراتي",
    "حط رقمي أنا",
    "معندهاش رقم، استخدم رقمي",
    "نفس الرقم اللي بكلمك منه",
    "use my number",
    "just use this number please",
  ])("reads %s as the number this thread is on", (text) => {
    expect(readsAsOwnNumberReference(text)).toBe(true);
  });

  it.each([
    "استخدم الرقم",
    "رقمها",
    "خلي رقم جوزها",
    "her number",
    "رقم تاني",
    "معرفش",
  ])("does not read %s as one", (text) => {
    expect(readsAsOwnNumberReference(text)).toBe(false);
  });

  it("refuses an address that is not a phone number", () => {
    expect(participantPhone(null)).toBeNull();
    expect(participantPhone("")).toBeNull();
    expect(participantPhone("12345")).toBeNull();
    expect(participantPhone("+905321112233")).toBe("+905321112233");
  });
});

describe("«استخدم رقمي», through the engine", () => {
  /** A third-party intake standing on its own phone question. */
  const atThePhoneQuestion = async () => {
    const state = thirdPartyIntake({
      full_name: slotValue("سعاد ابراهيم"),
      full_name_latin: slotValue("Soad Ibrahim"),
      national_id: slotValue("707030001655"),
      date_of_birth: slotValue("1990-03-15"),
      email: slotValue("soad@example.com"),
    });
    const asked = await turn([], ctx("", state));
    expect(askedSlot(asked.effects)).toBe("phone");
    return asked.state;
  };

  it.each([
    "استخدم رقمي",
    "خليها نفس رقمي",
    "خلي رقمها رقمي لأنها مراتي",
    "نفس الرقم اللي بكلمك منه",
  ])("resolves %s to the conversation's own number", async (text) => {
    const state = await atThePhoneQuestion();
    // The clarification the interpreter produced for this sentence in the live
    // session. The deterministic reading outranks it.
    const result = await turn(
      [{ kind: "ask_clarification", reason: "ambiguous_value" }],
      ctx(text, state),
    );
    expect(activeFrame(result.state)?.slots.phone?.value).toBe(SENDER);
    expect(askedSlot(result.effects)).not.toBe("phone");
  });

  it("resolves it from a set_slot the interpreter got right on its own", async () => {
    const state = await atThePhoneQuestion();
    const result = await turn(
      [{ kind: "set_slot", slot: "phone", value: "استخدم رقمي" }],
      ctx("استخدم رقمي", state),
    );
    expect(activeFrame(result.state)?.slots.phone?.value).toBe(SENDER);
  });

  it("keeps the beneficiary the third party and the thread the requester's", async () => {
    const state = await atThePhoneQuestion();
    const result = await turn(
      [{ kind: "ask_clarification", reason: "ambiguous_value" }],
      ctx("خلي رقمها رقمي لأنها مراتي", state),
    );
    const frame = activeFrame(result.state)!;
    // B is still the beneficiary; A is still who the conversation belongs to.
    expect(frame.slots.beneficiary?.value).toBe("other");
    expect(frame.slots.full_name?.value).toBe("سعاد ابراهيم");
    expect(result.state.stack[0]!.flow).toBe("book_appointment");
    // Nothing here confirms an identity or a booking.
    expect(frame.memo.confirmed).toBeUndefined();
    expect(stubs.commitBooking).not.toHaveBeenCalled();
  });

  it("carries the number to staging as contact data, for a third party", async () => {
    const state = await atThePhoneQuestion();
    const phoned = await turn(
      [{ kind: "ask_clarification", reason: "ambiguous_value" }],
      ctx("استخدم رقمي", state),
    );
    const typed = await turn(
      [{ kind: "set_slot", slot: "blood_type", value: "O+" }],
      ctx("O+", phoned.state),
    );
    expect(stubs.stageIntake).toHaveBeenCalledWith(
      expect.objectContaining({ forThirdParty: true, phone: SENDER }),
    );
    expect(activeFrame(typed.state)?.memo.intake_staged).toBe(true);
  });

  it("does not let a shared number match anybody: discovery is id plus name", async () => {
    const state = await atThePhoneQuestion();
    const phoned = await turn(
      [{ kind: "ask_clarification", reason: "ambiguous_value" }],
      ctx("استخدم رقمي", state),
    );
    await turn([{ kind: "set_slot", slot: "blood_type", value: "O+" }], ctx("O+", phoned.state));
    expect(stubs.resolveIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ nationalId: "707030001655", fullName: "سعاد ابراهيم" }),
    );
    // The one call, and no phone anywhere in it.
    const [call] = stubs.resolveIdentity.mock.calls.at(-1) as [Record<string, unknown>];
    expect(Object.keys(call)).not.toContain("phone");
  });

  it("still takes an explicit literal number, and prefers it over any reference", async () => {
    const state = await atThePhoneQuestion();
    const result = await turn(
      [{ kind: "set_slot", slot: "phone", value: "رقمها 05321119988" }],
      ctx("رقمها 05321119988", state),
    );
    expect(activeFrame(result.state)?.slots.phone?.value).toBe("05321119988");
  });

  it("leaves a message that carries a number alone even when it says «رقمي»", async () => {
    const state = await atThePhoneQuestion();
    const result = await turn(
      [{ kind: "set_slot", slot: "phone", value: "مش رقمي، رقمها 05321119988" }],
      ctx("مش رقمي، رقمها 05321119988", state),
    );
    expect(activeFrame(result.state)?.slots.phone?.value).toBe("05321119988");
  });

  it.each(["استخدم الرقم", "رقمها", "خلي رقم جوزها"])(
    "does not silently pick a number for %s",
    async (text) => {
      const state = await atThePhoneQuestion();
      const result = await turn(
        [{ kind: "set_slot", slot: "phone", value: text }],
        ctx(text, state),
      );
      expect(activeFrame(result.state)?.slots.phone).toBeUndefined();
    },
  );

  it("resolves nothing when the conversation carries no usable address", async () => {
    const state = await atThePhoneQuestion();
    const result = await turn(
      [{ kind: "set_slot", slot: "phone", value: "استخدم رقمي" }],
      ctx("استخدم رقمي", state, { participantAddress: null }),
    );
    expect(activeFrame(result.state)?.slots.phone).toBeUndefined();
  });

  it("never asks a self-booking for a phone, and reads no reference for one", async () => {
    const self = selfIntake({
      full_name: slotValue("علي الزهراني"),
      full_name_latin: slotValue("Ali Alzahrani"),
      national_id: slotValue("707030001655"),
      date_of_birth: slotValue("1990-03-15"),
      email: slotValue("ali@example.com"),
    });
    const asked = await turn([], ctx("", self, { identity: "anonymous", patientId: null }));
    // Blood type, never phone: the sender's own thread already carries theirs.
    expect(askedSlot(asked.effects)).toBe("blood_type");
    const result = await turn(
      [{ kind: "set_slot", slot: "phone", value: "استخدم رقمي" }],
      ctx("استخدم رقمي", asked.state, { identity: "anonymous", patientId: null }),
    );
    expect(activeFrame(result.state)?.slots.phone).toBeUndefined();
  });
});
