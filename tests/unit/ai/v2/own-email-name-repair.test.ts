/**
 * Three narrow interpretation/UX contracts, as tests.
 *
 * ```
 *   assistant: ممكن إيميل المريض؟
 *   patient:   نفس إيميلي                 -> the same question again
 *
 *   on file:   Omer Alfarooq Hassan
 *   patient:   عدل Omer لـ Omar           -> the whole name replaced
 *
 *   assistant: ممكن الرقم القومي للمريض؟
 *   patient:   <something unreadable>
 *   assistant: معلش، ما قدرتش أحدد اللي تقصده.   -> which "that"?
 * ```
 *
 * Every assertion below is about interpretation and copy: which value a
 * sentence resolves to, which ones it must not, and what the patient is told
 * when it resolves to none. The flow definitions, the engine, the preconditions
 * and the resolvers are the real ones; only the tool layer is stubbed, so the
 * ownership and identity invariants are asserted against the arguments the real
 * steps actually pass.
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
  readRequesterContactEmail: vi.fn(),
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
import { COMPOSER_COPY, composeDeterministic } from "@/lib/ai/v2/composer";
import type { TurnContext } from "@/lib/ai/v2/context";
import { readPartialNameCorrection } from "@/lib/ai/v2/name-correction";
import {
  contactEmailValue,
  readsAsOwnEmailReference,
} from "@/lib/ai/v2/self-email-reference";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const AT = NOW.toISOString();

/** The number the requester is messaging the clinic from. */
const SENDER = "+905321112233";
/** The address this clinic already holds on the requester's *own* file. */
const REQUESTER_EMAIL = "ahmed.father@example.com";

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
    requesterContactEmail: async () => REQUESTER_EMAIL,
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

function reply(effects: readonly Effect[], locale: "ar" | "en" = "ar"): string {
  return composeDeterministic({ effects, locale }).text;
}

/** A booking for somebody else, past the calendar and into the intake. */
function thirdPartyIntake(slots: Record<string, Slot> = {}): FlowState {
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
  stubs.readRequesterContactEmail.mockResolvedValue(REQUESTER_EMAIL);
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

// ===========================================================================
// 1 — "use my email", for a third party
// ===========================================================================

describe("the own-email reference, in isolation", () => {
  it.each([
    "نفس إيميلي",
    "استخدم إيميلي",
    "حط إيميلي",
    "حط إيميلي أنا",
    "خلي إيميله إيميلي",
    "خلي إيميلها إيميلي",
    "الإيميل بتاعي",
    "استخدم بريدي الإلكتروني",
    "نفس بريدي",
    "الإيميل اللي عندكم ليا",
    "use my email",
    "same as my email",
    "use my email address",
    "put my email",
    "use the email you have for me",
  ])("reads %s as the requester's own address", (text) => {
    expect(readsAsOwnEmailReference(text)).toBe(true);
  });

  it.each([
    "الإيميل",
    "استخدم الإيميل",
    "إيميله",
    "إيميلها",
    "her email",
    "his email address",
    "إيميل تاني",
    "زميلي هيبعتهولك",
    "معرفش",
  ])("does not read %s as one", (text) => {
    expect(readsAsOwnEmailReference(text)).toBe(false);
  });

  it("refuses a stored value that is not an address", () => {
    expect(contactEmailValue(null)).toBeNull();
    expect(contactEmailValue("")).toBeNull();
    expect(contactEmailValue("none")).toBeNull();
    expect(contactEmailValue("  Ahmed@Example.COM ")).toBe("ahmed@example.com");
  });

  it("is not the phone reference, and does not answer to it", () => {
    expect(readsAsOwnEmailReference("استخدم رقمي")).toBe(false);
    expect(readsAsOwnEmailReference("use my number")).toBe(false);
  });
});

describe("«نفس إيميلي», through the engine", () => {
  /** A third-party intake standing on its own email question. */
  const atTheEmailQuestion = async (overrides: Partial<TurnContext> = {}) => {
    const state = thirdPartyIntake({
      full_name: slotValue("سعاد ابراهيم"),
      full_name_latin: slotValue("Soad Ibrahim"),
      national_id: slotValue("707030001655"),
      date_of_birth: slotValue("1990-03-15"),
    });
    const asked = await turn([], ctx("", state, overrides));
    expect(askedSlot(asked.effects)).toBe("email");
    return asked.state;
  };

  it.each(["نفس إيميلي", "استخدم إيميلي", "use my email", "الإيميل اللي عندكم ليا"])(
    "resolves %s to the address on the requester's own file",
    async (text) => {
      const state = await atTheEmailQuestion();
      // The clarification the interpreter produces for a sentence with no
      // address in it. The deterministic reading outranks it.
      const result = await turn(
        [{ kind: "ask_clarification", reason: "ambiguous_value" }],
        ctx(text, state),
      );
      expect(activeFrame(result.state)?.slots.email?.value).toBe(REQUESTER_EMAIL);
      expect(askedSlot(result.effects)).not.toBe("email");
    },
  );

  it("resolves it from a set_slot the interpreter got right on its own", async () => {
    const state = await atTheEmailQuestion();
    const result = await turn(
      [{ kind: "set_slot", slot: "email", value: "نفس إيميلي" }],
      ctx("نفس إيميلي", state),
    );
    expect(activeFrame(result.state)?.slots.email?.value).toBe(REQUESTER_EMAIL);
  });

  it("keeps B the beneficiary and A the requester the conversation belongs to", async () => {
    const state = await atTheEmailQuestion();
    const result = await turn(
      [{ kind: "ask_clarification", reason: "ambiguous_value" }],
      ctx("خلي إيميلها إيميلي", state),
    );
    const frame = activeFrame(result.state)!;
    // B is still the beneficiary, and still a third party.
    expect(frame.slots.beneficiary?.value).toBe("other");
    expect(frame.slots.full_name?.value).toBe("سعاد ابراهيم");
    // A is still who the conversation belongs to, at the identity level it had.
    expect(result.state.stack[0]!.flow).toBe("book_appointment");
    // Nothing here confirms an identity or a booking.
    expect(frame.memo.confirmed).toBeUndefined();
    expect(stubs.commitBooking).not.toHaveBeenCalled();
  });

  it("carries the address to staging as contact data, for a third party", async () => {
    const state = await atTheEmailQuestion();
    const emailed = await turn(
      [{ kind: "ask_clarification", reason: "ambiguous_value" }],
      ctx("استخدم إيميلي", state),
    );
    const phoned = await turn(
      [{ kind: "set_slot", slot: "phone", value: "05321119988" }],
      ctx("05321119988", emailed.state),
    );
    await turn([{ kind: "set_slot", slot: "blood_type", value: "O+" }], ctx("O+", phoned.state));
    expect(stubs.stageIntake).toHaveBeenCalledWith(
      expect.objectContaining({ forThirdParty: true, email: REQUESTER_EMAIL }),
    );
  });

  it("does not let a shared address match anybody: discovery is id plus name", async () => {
    const state = await atTheEmailQuestion();
    const emailed = await turn(
      [{ kind: "ask_clarification", reason: "ambiguous_value" }],
      ctx("استخدم إيميلي", state),
    );
    const phoned = await turn(
      [{ kind: "set_slot", slot: "phone", value: "05321119988" }],
      ctx("05321119988", emailed.state),
    );
    await turn([{ kind: "set_slot", slot: "blood_type", value: "O+" }], ctx("O+", phoned.state));
    expect(stubs.resolveIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ nationalId: "707030001655", fullName: "سعاد ابراهيم" }),
    );
    const [call] = stubs.resolveIdentity.mock.calls.at(-1) as [Record<string, unknown>];
    expect(Object.keys(call)).not.toContain("email");
    expect(Object.keys(call)).not.toContain("phone");
  });

  it("asks normally, and invents nothing, when the requester has no address", async () => {
    const noEmail = { requesterContactEmail: async () => null };
    const state = await atTheEmailQuestion(noEmail);
    const result = await turn(
      [{ kind: "set_slot", slot: "email", value: "نفس إيميلي" }],
      ctx("نفس إيميلي", state, noEmail),
    );
    expect(activeFrame(result.state)?.slots.email).toBeUndefined();
  });

  it("resolves nothing when the context carries no loader at all", async () => {
    const none = { requesterContactEmail: undefined };
    const state = await atTheEmailQuestion(none);
    const result = await turn(
      [{ kind: "set_slot", slot: "email", value: "استخدم إيميلي" }],
      ctx("استخدم إيميلي", state, none),
    );
    expect(activeFrame(result.state)?.slots.email).toBeUndefined();
  });

  it("refuses a stored value that is not a usable address", async () => {
    const junk = { requesterContactEmail: async () => "not-an-address" };
    const state = await atTheEmailQuestion(junk);
    const result = await turn(
      [{ kind: "set_slot", slot: "email", value: "استخدم إيميلي" }],
      ctx("استخدم إيميلي", state, junk),
    );
    expect(activeFrame(result.state)?.slots.email).toBeUndefined();
  });

  it("still takes an explicit literal address, and prefers it over any reference", async () => {
    const state = await atTheEmailQuestion();
    const result = await turn(
      [{ kind: "set_slot", slot: "email", value: "مش إيميلي، إيميلها soad@example.com" }],
      ctx("مش إيميلي، إيميلها soad@example.com", state),
    );
    expect(activeFrame(result.state)?.slots.email?.value).toBe("soad@example.com");
  });

  it("does not mutate the email when the phrase arrives at another question", async () => {
    // Standing on the national id, two questions before the email.
    const state = thirdPartyIntake({
      full_name: slotValue("سعاد ابراهيم"),
      full_name_latin: slotValue("Soad Ibrahim"),
    });
    const asked = await turn([], ctx("", state));
    expect(askedSlot(asked.effects)).toBe("national_id");
    const result = await turn(
      [{ kind: "ask_clarification", reason: "ambiguous_value" }],
      ctx("استخدم إيميلي", asked.state),
    );
    expect(activeFrame(result.state)?.slots.email).toBeUndefined();
    expect(activeFrame(result.state)?.slots.national_id).toBeUndefined();
  });

  it("reads no such reference for a sender opening their own file", async () => {
    const self = selfIntake({
      full_name: slotValue("علي الزهراني"),
      full_name_latin: slotValue("Ali Alzahrani"),
      national_id: slotValue("707030001655"),
      date_of_birth: slotValue("1990-03-15"),
    });
    // A stranger opening their own file — the only shape in which the intake
    // asks a self-booking anything. The loader is deliberately still armed, so
    // this asserts the beneficiary gate and not merely a missing address.
    const anon = { identity: "anonymous", patientId: null } as const;
    const asked = await turn([], ctx("", self, anon));
    expect(askedSlot(asked.effects)).toBe("email");
    const result = await turn(
      [{ kind: "set_slot", slot: "email", value: "استخدم إيميلي" }],
      ctx("استخدم إيميلي", asked.state, anon),
    );
    expect(activeFrame(result.state)?.slots.email).toBeUndefined();
  });

  it("does not read «استخدم رقمي» as an answer to the email question", async () => {
    const state = await atTheEmailQuestion();
    const result = await turn(
      [{ kind: "set_slot", slot: "email", value: "استخدم رقمي" }],
      ctx("استخدم رقمي", state),
    );
    expect(activeFrame(result.state)?.slots.email).toBeUndefined();
  });
});

// ===========================================================================
// 2 — a partial correction that names its own target
// ===========================================================================

describe("a directed partial name correction, in isolation", () => {
  it("replaces one component with a two-word replacement", () => {
    expect(
      readPartialNameCorrection({
        current: "Omer Alfarooq Hassan",
        spoken: "Omer صح بس Alfarooq خليه Al Farouk",
      }),
    ).toEqual({ kind: "corrected", value: "Omer Al Farouk Hassan" });
  });

  it("reads «عدل X لـ Y», which carries no correction marker at all", () => {
    expect(
      readPartialNameCorrection({
        current: "Omer Alfarooq Hassan",
        spoken: "عدل Omer لـ Omar",
      }),
    ).toEqual({ kind: "corrected", value: "Omar Alfarooq Hassan" });
  });

  it("reads the same instruction inside a four-part Arabic name", () => {
    expect(
      readPartialNameCorrection({
        current: "محمد أحمد إبراهيم علي",
        spoken: "إبراهيم صح، بس أحمد خليه محمود",
      }),
    ).toEqual({ kind: "corrected", value: "محمد محمود إبراهيم علي" });
  });

  it("reads it in a five-part name, and preserves every untouched component", () => {
    expect(
      readPartialNameCorrection({
        current: "Mohamed Ahmed Hassan Ali Farouk",
        spoken: "غير Hassan لـ Hasan",
      }),
    ).toEqual({ kind: "corrected", value: "Mohamed Ahmed Hasan Ali Farouk" });
  });

  it("reads the English shapes", () => {
    expect(
      readPartialNameCorrection({
        current: "Mohamed Ahmed Hassan Ali",
        spoken: "change Ahmed to Ahmad",
      }),
    ).toEqual({ kind: "corrected", value: "Mohamed Ahmad Hassan Ali" });
    expect(
      readPartialNameCorrection({
        current: "Omer Alfarooq Hassan",
        spoken: "Alfarooq should be Al Farouk",
      }),
    ).toEqual({ kind: "corrected", value: "Omer Al Farouk Hassan" });
  });

  it("preserves the original spelling of every component it did not touch", () => {
    // The stored «أحمد» and «إبراهيم» carry hamza; the folding that matched
    // them must not be what gets written back.
    const result = readPartialNameCorrection({
      current: "محمد أحمد إبراهيم علي",
      spoken: "عدل علي لـ علاء",
    });
    expect(result).toEqual({ kind: "corrected", value: "محمد أحمد إبراهيم علاء" });
  });

  it("asks rather than guessing when the named component appears twice", () => {
    expect(
      readPartialNameCorrection({
        current: "Mohamed Ahmed Ahmed Ali",
        spoken: "غير Ahmed لـ Mahmoud",
      }),
    ).toEqual({ kind: "ambiguous" });
    expect(
      readPartialNameCorrection({
        current: "محمد أحمد أحمد علي",
        spoken: "أحمد خليه محمود",
      }),
    ).toEqual({ kind: "ambiguous" });
  });

  it("asks when an instruction names a target and supplies no replacement", () => {
    expect(
      readPartialNameCorrection({ current: "Omer Alfarooq Hassan", spoken: "عدل Alfarooq" }),
    ).toEqual({ kind: "ambiguous" });
  });

  it("still declines a restatement of the whole name, however it is phrased", () => {
    expect(
      readPartialNameCorrection({ current: "Ali Alzahrani", spoken: "لا خليه Ali Al Zahrani" }),
    ).toEqual({ kind: "none" });
    expect(
      readPartialNameCorrection({
        current: "Ali Alzahrani",
        spoken: "غير الاسم لـ Ali Al Zahrani",
      }),
    ).toEqual({ kind: "none" });
  });

  it("still declines a sentence that names none of the stored components", () => {
    expect(
      readPartialNameCorrection({ current: "Saad Ibrahim", spoken: "غير الاسم" }),
    ).toEqual({ kind: "none" });
  });
});

describe("a directed partial name correction, through the engine", () => {
  const named = (latin: string, arabic: string) =>
    thirdPartyIntake({
      full_name: slotValue(arabic),
      full_name_latin: slotValue(latin),
    });

  it("substitutes one component and leaves the rest exactly as they were", async () => {
    const text = "Omer صح بس Alfarooq خليه Al Farouk";
    const result = await turn(
      [{ kind: "correct_slot", slot: "full_name_latin", value: text }],
      ctx(text, named("Omer Alfarooq Hassan", "عمر الفاروق حسن")),
    );
    const frame = activeFrame(result.state)!;
    expect(frame.slots.full_name_latin?.value).toBe("Omer Al Farouk Hassan");
    // The bilingual counterpart is untouched, and the intake carries on rather
    // than restarting.
    expect(frame.slots.full_name?.value).toBe("عمر الفاروق حسن");
    expect(frame.slots.beneficiary?.value).toBe("other");
    expect(askedSlot(result.effects)).toBe("national_id");
  });

  it("corrects the Arabic name without disturbing the English spelling", async () => {
    const text = "إبراهيم صح، بس أحمد خليه محمود";
    const result = await turn(
      [{ kind: "correct_slot", slot: "full_name", value: text }],
      ctx(text, named("Mohamed Ahmed Ibrahim Ali", "محمد أحمد إبراهيم علي")),
    );
    const frame = activeFrame(result.state)!;
    expect(frame.slots.full_name?.value).toBe("محمد محمود إبراهيم علي");
    expect(frame.slots.beneficiary?.value).toBe("other");
  });

  it("does not mutate the name when the instruction is ambiguous", async () => {
    const text = "غير Ahmed لـ Mahmoud";
    const result = await turn(
      [{ kind: "set_slot", slot: "full_name_latin", value: text }],
      ctx(text, named("Mohamed Ahmed Ahmed Ali", "محمد أحمد أحمد علي")),
    );
    expect(activeFrame(result.state)?.slots.full_name_latin?.value).toBe(
      "Mohamed Ahmed Ahmed Ali",
    );
    expect(
      result.effects.some(
        (effect) => effect.kind === "ask" && effect.key === "clarify.value_not_recognised",
      ),
    ).toBe(true);
  });
});

// ===========================================================================
// 3 — a clarification that says what it is waiting for
// ===========================================================================

describe("the contextual repair message", () => {
  const unresolved = (slot: string, variant?: string): Effect[] => [
    { kind: "ask", key: "clarify.value_not_recognised", slot: slot as never, variant },
  ];

  it.each([
    ["full_name", "الاسم الكامل"],
    ["national_id", "الرقم المدني"],
    ["date_of_birth", "تاريخ ميلاد"],
    ["email", "إيميل المريض"],
    ["blood_type", "فصيلة دم"],
  ])("names the field it is waiting for — %s", (slot, fragment) => {
    const text = reply(unresolved(slot));
    expect(text).toContain(fragment);
    expect(text).not.toBe(COMPOSER_COPY["clarify.value_not_recognised"]!.ar);
  });

  it("offers «استخدم رقمي» on the phone question, which is only ever a third party's", () => {
    expect(reply(unresolved("phone"))).toContain("استخدم رقمي");
  });

  it("offers «استخدم إيميلي» only where that phrase resolves", () => {
    expect(reply(unresolved("email", "other"))).toContain("استخدم إيميلي");
    // A sender opening their own file is not offered a phrase that does nothing.
    expect(reply(unresolved("email"))).not.toContain("استخدم إيميلي");
  });

  it("speaks the conversation's language", () => {
    expect(reply(unresolved("date_of_birth"), "en")).toContain("date of birth");
    expect(reply(unresolved("national_id"), "en")).toContain("national/civil ID");
    expect(reply(unresolved("phone"), "en")).toContain("use my number");
    expect(reply(unresolved("date_of_birth"), "ar")).toContain("تاريخ ميلاد");
  });

  it("keeps the generic line for a slot it has nothing specific to say about", () => {
    for (const locale of ["ar", "en"] as const) {
      expect(reply(unresolved("doctor"), locale)).toBe(
        COMPOSER_COPY["clarify.value_not_recognised"]![locale],
      );
      expect(reply(unresolved("day"), locale)).toBe(
        COMPOSER_COPY["clarify.value_not_recognised"]![locale],
      );
    }
  });

  it("keeps the generic line when there is no slot at all", () => {
    for (const locale of ["ar", "en"] as const) {
      expect(
        reply([{ kind: "ask", key: "clarify.value_not_recognised", slot: null }], locale),
      ).toBe(COMPOSER_COPY["clarify.value_not_recognised"]![locale]);
    }
  });

  it("falls back to the slot line for a variant it has no copy for", () => {
    expect(reply(unresolved("national_id", "other"))).toBe(
      COMPOSER_COPY["clarify.value_not_recognised.national_id"]!.ar,
    );
  });

  it("explains without inventing: nothing is committed by the repair itself", async () => {
    const state = thirdPartyIntake({
      full_name: slotValue("سعاد ابراهيم"),
      full_name_latin: slotValue("Soad Ibrahim"),
    });
    const asked = await turn([], ctx("", state));
    expect(askedSlot(asked.effects)).toBe("national_id");
    const result = await turn(
      [{ kind: "set_slot", slot: "national_id", value: "ايه ده" }],
      ctx("ايه ده", asked.state),
    );
    const frame = activeFrame(result.state)!;
    expect(frame.slots.national_id).toBeUndefined();
    expect(reply(result.effects)).toContain("الرقم المدني");
    // The repair explains; it does not answer the question on the patient's
    // behalf, and it changes nothing else on the frame.
    expect(frame.slots.full_name?.value).toBe("سعاد ابراهيم");
    expect(frame.slots.beneficiary?.value).toBe("other");
  });

  it("carries the third-party variant off the frame, on a real turn", async () => {
    const state = thirdPartyIntake({
      full_name: slotValue("سعاد ابراهيم"),
      full_name_latin: slotValue("Soad Ibrahim"),
      national_id: slotValue("707030001655"),
      date_of_birth: slotValue("1990-03-15"),
    });
    const asked = await turn([], ctx("", state));
    expect(askedSlot(asked.effects)).toBe("email");
    const result = await turn(
      [{ kind: "set_slot", slot: "email", value: "مش عارف" }],
      ctx("مش عارف", asked.state),
    );
    expect(activeFrame(result.state)?.slots.email).toBeUndefined();
    expect(reply(result.effects)).toContain("استخدم إيميلي");
  });
});
