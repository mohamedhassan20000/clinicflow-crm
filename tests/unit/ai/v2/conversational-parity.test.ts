/**
 * The 14:12–14:26 manual QA exchange, frozen as behaviour contracts.
 *
 * That session was answered by the *legacy* engine — V2 was falling back on a
 * detached RPC — and it was the conversation the product wanted: compound
 * questions answered in full, follow-ups understood, clinic information
 * available. When V2 actually ran, three read/compose-side defects took all of
 * that away while the deterministic execution underneath stayed correct:
 *
 *   1. `answer_question` pushes a frame and `advance` runs one frame, so a
 *      three-part question got a one-part answer and the leftovers stayed on
 *      the stack as active frames nobody had been told about;
 *   2. seven of sixteen question topics had no copy key, and a missing key
 *      renders as `clarify.open` — «اتفضل، أقدر أساعدك في إيه؟» — which is why a
 *      live episode answered a follow-up with what reads like a greeting;
 *   3. the insurance topic read the clinic's contact row and the clinic's own
 *      FAQ was not reachable at all.
 *
 * Every assertion below is on the property, not the sentence. The tool layer is
 * stubbed at the module boundary; the flow definitions, the engine, the
 * preconditions and the composer are the real ones.
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

import { QUESTION_TOPICS, type Command, type QuestionTopic } from "@/lib/ai/v2/commands";
import { EMPTY_FLOW_STATE, newFrame, type FlowState } from "@/lib/ai/v2/flow-state";
import { runEngine, type Effect } from "@/lib/ai/v2/engine";
import { FLOW_REGISTRY } from "@/lib/ai/v2/flows";
import { COMPOSER_COPY, composeDeterministic } from "@/lib/ai/v2/composer";
import { interpreterView, type TurnContext } from "@/lib/ai/v2/context";
import { renderInterpreterView } from "@/lib/ai/v2/interpreter";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const AT = NOW.toISOString();

/** The clinic settings row, as `getPatientClinicPublicInfo` returns it. */
const CLINIC_INFO = {
  name: "عيادة الابتسامة",
  address: "١٢ شارع النيل، المعادي، القاهرة",
  email: "hello@smile.clinic",
  phone: "+20222222222",
  website: "https://smile.clinic",
  timezone: "Africa/Cairo",
  locale: "ar",
  working_hours: [
    { day_of_week: 0, shift_start: "09:00", shift_end: "13:00" },
    { day_of_week: 0, shift_start: "16:00", shift_end: "20:00" },
    { day_of_week: 2, shift_start: "10:00", shift_end: "18:00" },
  ],
  default_working_hours: { start: "09:00", end: "17:00" },
};

const DEPARTMENTS = [
  { value: "dept-derma", label: "الجلدية", source: "clinic_directory" as const },
  { value: "dept-dental", label: "الأسنان", source: "clinic_directory" as const },
];

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

async function turn(commands: readonly Command[], ctx: TurnContext) {
  return runEngine({ context: ctx, commands, registry: FLOW_REGISTRY });
}

function reply(effects: readonly Effect[], locale: "ar" | "en" = "ar") {
  return composeDeterministic({ effects, locale }).text;
}

function ask(topic: QuestionTopic): Command {
  return { kind: "answer_question", topic };
}

/** The fallback sentence a missing copy key produces. The bug's fingerprint. */
const GENERIC_OPENING = COMPOSER_COPY["clarify.open"]!;

beforeEach(() => {
  vi.clearAllMocks();
  stubs.readClinicInfo.mockResolvedValue(CLINIC_INFO);
  stubs.readDepartments.mockResolvedValue(DEPARTMENTS);
  stubs.readDoctors.mockResolvedValue([]);
  stubs.readClinicFaq.mockResolvedValue([]);
  stubs.readClinicInsurance.mockResolvedValue([]);
  stubs.readPublicPackages.mockResolvedValue({
    groups: [],
    all: [],
    currency: "EGP",
    total: 0,
  });
  stubs.readServices.mockResolvedValue({ groups: [], currency: "EGP", total: 0 });
  stubs.readMyAppointments.mockResolvedValue([]);
  stubs.readPatientPackages.mockResolvedValue([]);
  stubs.readPatientDocuments.mockResolvedValue([]);
  stubs.readTreatingDoctors.mockResolvedValue([]);
  stubs.readKnownDepartments.mockResolvedValue([]);
  stubs.resolveDepartmentSpoken.mockResolvedValue([]);
  stubs.resolveDepartmentNamed.mockResolvedValue({ kind: "unresolved" });
});

// ---------------------------------------------------------------------------
// 1. The compound question
// ---------------------------------------------------------------------------

describe("«عايز اعرف العنوان ورقم التليفون والاقسام الموجودة عندكم»", () => {
  const COMPOUND: readonly Command[] = [ask("address"), ask("phone"), ask("departments")];

  it("answers every fact the patient asked for, in one reply", async () => {
    const result = await turn(COMPOUND, context());
    const text = reply(result.effects);
    // The observed defect answered only the last topic named.
    expect(text).toContain(CLINIC_INFO.address);
    expect(text).toContain(CLINIC_INFO.phone);
    expect(text).toContain("الجلدية");
    expect(text).not.toBe(GENERIC_OPENING.ar);
  });

  it("answers them in the order the patient asked", async () => {
    const result = await turn(COMPOUND, context());
    const text = reply(result.effects);
    // Stack order is push order is command order. Draining from the top of the
    // stack instead — which is what `resumeSuspended` does — answers backwards.
    expect(text.indexOf(CLINIC_INFO.address)).toBeLessThan(text.indexOf(CLINIC_INFO.phone));
    expect(text.indexOf(CLINIC_INFO.phone)).toBeLessThan(text.indexOf("الجلدية"));
  });

  it("leaves no question frame behind once the turn is answered", async () => {
    const result = await turn(COMPOUND, context());
    // The zombie-frame contract. A leftover `answer_question` frame reported
    // itself to the next turn as the ACTIVE FLOW and offered its `collects`
    // slots — `department` and `service` — to values meant for a booking.
    expect(result.state.stack.filter((frame) => frame.flow === "answer_question")).toEqual([]);
  });

  it("tells the next turn that nothing is running", async () => {
    const result = await turn(COMPOUND, context());
    const view = interpreterView(context({ flows: result.state }));
    expect(view.activeFlow).toBeNull();
    expect(renderInterpreterView(view)).toContain("ACTIVE FLOW: none");
  });

  it("reads each topic from its own authoritative source", async () => {
    await turn(COMPOUND, context());
    expect(stubs.readClinicInfo).toHaveBeenCalled();
    expect(stubs.readDepartments).toHaveBeenCalled();
  });

  it("bounds how many topics one turn may answer", async () => {
    // `MAX_COMMANDS_PER_TURN` already caps the input; this proves the drain
    // does not become an unbounded read loop if that cap ever moves.
    const many = Array.from({ length: 6 }, () => ask("address"));
    const result = await turn(many, context());
    expect(stubs.readClinicInfo.mock.calls.length).toBeLessThanOrEqual(6);
    expect(result.state.stack.filter((frame) => frame.flow === "answer_question")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. The follow-up inside a live episode
// ---------------------------------------------------------------------------

describe("«طيب والعنوان ورقم التليفون؟» inside an active episode", () => {
  /** The state the QA session was really in: the compound turn had just run. */
  const EPISODE = {
    turns: [
      {
        role: "patient" as const,
        text: "عايز اعرف العنوان ورقم التليفون والاقسام الموجودة عندكم",
        at: "2026-09-04T11:12:00.000Z",
      },
      {
        role: "assistant" as const,
        text: "أقسام العيادة: الجلدية، الأسنان.",
        at: "2026-09-04T11:13:00.000Z",
      },
    ],
  };

  it("answers with the facts and never with the generic opening", async () => {
    const ctx = context({
      turn: {
        text: "طيب والعنوان ورقم التليفون؟",
        receivedAt: AT,
        locale: "ar",
        attachments: [],
      },
      episode: EPISODE,
    });
    const result = await turn([ask("address"), ask("phone")], ctx);
    const text = reply(result.effects);
    expect(text).toContain(CLINIC_INFO.address);
    expect(text).toContain(CLINIC_INFO.phone);
    // The exact regression: this sentence is what the patient actually got.
    expect(text).not.toBe(GENERIC_OPENING.ar);
    expect(text).not.toContain(GENERIC_OPENING.ar);
  });

  it("shows the interpreter what the assistant just said", async () => {
    const rendered = renderInterpreterView(
      interpreterView(
        context({
          turn: {
            text: "طيب والعنوان ورقم التليفون؟",
            receivedAt: AT,
            locale: "ar",
            attachments: [],
          },
          episode: EPISODE,
        }),
      ),
    );
    // Without an assistant turn in view, «طيب و…» has no antecedent at all.
    expect(rendered).toContain("assistant: أقسام العيادة");
    expect(rendered).toContain("patient: عايز اعرف العنوان");
    // Chronological: the question the follow-up continues must precede it.
    expect(rendered.indexOf("patient: عايز اعرف العنوان")).toBeLessThan(
      rendered.indexOf("assistant: أقسام العيادة"),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Copy coverage — the regression net for the whole defect class
// ---------------------------------------------------------------------------

describe("every question topic produces an answer", () => {
  it.each(QUESTION_TOPICS)("«%s» is not answered with the generic opening", async (topic) => {
    // The topics that legitimately require identity are given it, so that the
    // only thing this can fail on is a topic with nothing to say.
    const ctx = context({ identity: "verified" });
    for (const locale of ["ar", "en"] as const) {
      const result = await turn([ask(topic)], { ...ctx, turn: { ...ctx.turn, locale } });
      const text = reply(result.effects, locale);
      expect(text.trim().length, `${topic}/${locale} said nothing`).toBeGreaterThan(0);
      expect(text, `${topic}/${locale} fell through to clarify.open`).not.toBe(
        GENERIC_OPENING[locale],
      );
    }
  });

  it("has copy for every `info.<topic>` key a step can emit", () => {
    // The static half. `flows.ts` builds this key with a template literal, so
    // the existing copy-parity test — which walks the keys that exist — could
    // never have seen the ones that did not.
    const dead = QUESTION_TOPICS.filter((topic) => {
      const key = `info.${topic}`;
      // `prices`/`services` share `info.services`; `my_documents` is delegated
      // to the document flow; `clinic_other` is answered from the clinic FAQ.
      if (["prices", "services", "my_documents", "clinic_other"].includes(topic)) return false;
      return !COMPOSER_COPY[key];
    });
    expect(dead).toEqual([]);
  });

  it("renders both languages for every new key", () => {
    for (const key of [
      "info.address",
      "info.phone",
      "info.website",
      "info.email",
      "info.opening_hours",
      "info.detail_unset",
      "info.insurance",
      "info.insurance_none",
      "info.faq_answer",
      "info.faq_none",
    ]) {
      expect(COMPOSER_COPY[key]?.ar, key).toBeTruthy();
      expect(COMPOSER_COPY[key]?.en, key).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Clinic settings actually reach the patient
// ---------------------------------------------------------------------------

describe("clinic contact settings", () => {
  it("quotes the stored value exactly and adds nothing", async () => {
    const result = await turn([ask("address")], context());
    expect(reply(result.effects)).toContain(CLINIC_INFO.address);
  });

  it("answers the email topic from the clinic's stored email", async () => {
    const result = await turn([ask("email")], context());
    expect(reply(result.effects)).toContain(CLINIC_INFO.email);
  });

  it("renders per-day working hours in the clinic's own language", async () => {
    const result = await turn([ask("opening_hours")], context());
    const text = reply(result.effects);
    expect(text).toContain("الأحد");
    expect(text).toContain("09:00–13:00");
    expect(text).toContain("16:00–20:00");
    expect(text).toContain("الثلاثاء");
  });

  it("honours the clinic's configured 12-hour clock", async () => {
    // `time_format` has been loaded into the turn context since `assemble.ts`
    // was written and, until now, was read by nothing in V2.
    const result = await turn(
      [ask("opening_hours")],
      context({
        clinic: {
          name: "عيادة الابتسامة",
          timeZone: "Africa/Cairo",
          locale: "ar",
          country: "EG",
          timeFormat: "12h",
        },
      }),
    );
    const text = reply(result.effects);
    expect(text).toContain("9:00 ص");
    expect(text).toContain("4:00 م");
  });

  it("falls back to the default range when no per-day shifts exist", async () => {
    stubs.readClinicInfo.mockResolvedValue({ ...CLINIC_INFO, working_hours: [] });
    const result = await turn([ask("opening_hours")], context());
    expect(reply(result.effects)).toContain("09:00–17:00");
  });

  it("says a field is not recorded rather than inventing one", async () => {
    stubs.readClinicInfo.mockResolvedValue({ ...CLINIC_INFO, address: null });
    const result = await turn([ask("address")], context());
    const text = reply(result.effects);
    expect(text).toBe(COMPOSER_COPY["info.detail_unset"]!.ar);
    expect(text).not.toContain(CLINIC_INFO.phone);
  });

  it("never substitutes a different field for a missing one", async () => {
    stubs.readClinicInfo.mockResolvedValue({ ...CLINIC_INFO, website: null });
    const result = await turn([ask("website")], context());
    const text = reply(result.effects);
    expect(text).not.toContain(CLINIC_INFO.address);
    expect(text).not.toContain(CLINIC_INFO.phone);
  });

  it("says so plainly when the clinic row cannot be read", async () => {
    stubs.readClinicInfo.mockResolvedValue(null);
    const result = await turn([ask("phone")], context());
    expect(reply(result.effects)).toBe(COMPOSER_COPY["info.unavailable"]!.ar);
  });
});

// ---------------------------------------------------------------------------
// 5. Insurance and the clinic FAQ — the two settings V2 could not reach
// ---------------------------------------------------------------------------

describe("insurance", () => {
  it("names the clinic's configured insurers, not its address", async () => {
    stubs.readClinicInsurance.mockResolvedValue([
      { id: "ins-1", label: "أكسا", aliases: ["أكسا", "AXA"] },
      { id: "ins-2", label: "مصر للتأمين", aliases: ["مصر للتأمين"] },
    ]);
    const result = await turn([ask("insurance")], context());
    const text = reply(result.effects);
    expect(stubs.readClinicInsurance).toHaveBeenCalled();
    expect(text).toContain("أكسا");
    expect(text).toContain("مصر للتأمين");
    // The old `default:` branch answered this from the clinic contact row.
    expect(text).not.toContain(CLINIC_INFO.address);
  });

  it("treats an empty list as an answer, not a gap to fill", async () => {
    stubs.readClinicInsurance.mockResolvedValue([]);
    const result = await turn([ask("insurance")], context());
    expect(reply(result.effects)).toBe(COMPOSER_COPY["info.insurance_none"]!.ar);
  });

  it("states no coverage terms", async () => {
    stubs.readClinicInsurance.mockResolvedValue([
      { id: "ins-1", label: "أكسا", aliases: ["أكسا"] },
    ]);
    const result = await turn([ask("insurance")], context());
    const text = reply(result.effects);
    expect(text).not.toMatch(/%|نسبة|تغطية كامل/);
  });
});

describe("clinic-authored FAQ", () => {
  it("answers `clinic_other` from the clinic's own rows", async () => {
    stubs.readClinicFaq.mockResolvedValue([
      { question: "في موقف؟", answer: "أيوه، في جراج تحت المبنى مجانًا للمرضى.", score: 0.9 },
    ]);
    const ctx = context({
      turn: { text: "في موقف عربيات؟", receivedAt: AT, locale: "ar", attachments: [] },
    });
    const result = await turn([ask("clinic_other")], ctx);
    expect(reply(result.effects)).toContain("جراج تحت المبنى");
  });

  it("asks the FAQ with the patient's own words and nothing else", async () => {
    stubs.readClinicFaq.mockResolvedValue([]);
    const ctx = context({
      turn: { text: "في موقف عربيات؟", receivedAt: AT, locale: "ar", attachments: [] },
      episode: {
        turns: [
          { role: "patient", text: "عايز أحجز مع د. أحمد", at: "2026-09-04T10:00:00.000Z" },
        ],
      },
    });
    await turn([ask("clinic_other")], ctx);
    expect(stubs.readClinicFaq).toHaveBeenCalledWith(
      expect.objectContaining({ question: "في موقف عربيات؟" }),
    );
  });

  it("says it does not know rather than improvising", async () => {
    stubs.readClinicFaq.mockResolvedValue([]);
    const result = await turn([ask("clinic_other")], context());
    expect(reply(result.effects)).toBe(COMPOSER_COPY["info.faq_none"]!.ar);
  });
});

// ---------------------------------------------------------------------------
// 6. Nothing else moved
// ---------------------------------------------------------------------------

describe("the flow engine is unchanged underneath", () => {
  it("still suspends a booking for a side question and keeps every slot", async () => {
    const booking: FlowState = {
      version: 1,
      stack: [
        {
          ...newFrame({ flow: "book_appointment", at: "2026-09-04T11:55:00.000Z" }),
          slots: {
            beneficiary: { value: "self", provenance: "spoken", at: AT },
            department: { value: "dept-derma", provenance: "spoken", at: AT },
          },
        },
      ],
    };
    const result = await turn([{ kind: "suspend_flow" }, ask("address")], context({ flows: booking }));
    expect(reply(result.effects)).toContain(CLINIC_INFO.address);
    const frame = result.state.stack.find((entry) => entry.flow === "book_appointment");
    expect(frame).toBeDefined();
    expect(frame?.slots.department?.value).toBe("dept-derma");
    expect(frame?.slots.beneficiary?.value).toBe("self");
    // Resumed, not restarted, and not advanced in the same breath.
    expect(frame?.status).toBe("active");
  });

  it("answers the question and re-asks the booking's own, and never two questions", async () => {
    const booking: FlowState = {
      version: 1,
      stack: [newFrame({ flow: "book_appointment", at: "2026-09-04T11:55:00.000Z" })],
    };
    const result = await turn([{ kind: "suspend_flow" }, ask("address")], context({ flows: booking }));
    const text = reply(result.effects);
    expect(text).toContain(CLINIC_INFO.address);

    // P12B — this asserted `questions == []`, and the reading behind it was too
    // broad. The collision worth preventing is **two questions competing for
    // one answer**, and that is prevented upstream: if answering the topic
    // itself produces an `ask` or an `offer`, `runEngine`'s `producedQuestion`
    // guard stops the flow being advanced at all.
    //
    // What the old assertion actually pinned was the booking going silent. On
    // WhatsApp that reads as the booking having been dropped — the assistant
    // had asked something, the patient asked a side question, and the reply
    // came back with no trace of the booking — so the patient had to say
    // «عايز أكمل الحجز» to return to a step that had never moved. Exactly one
    // question is the contract, and it is the resumed flow's own.
    const questions = result.effects.filter(
      (effect) => effect.kind === "ask" || effect.kind === "offer",
    );
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ kind: "offer" });
    // The booking is resumed, not restarted: the frame is the same one.
    expect(result.state.stack.map((frame) => frame.flow)).toEqual(["book_appointment"]);
  });

  it("keeps a question frame that still holds an open offer", async () => {
    // «أنهي قسم تحب تعرف دكاتره؟» is a live question. Retiring it would throw
    // away the thing the patient is about to answer.
    const result = await turn([ask("doctors")], context());
    const frame = result.state.stack.find((entry) => entry.flow === "answer_question");
    expect(frame?.offer).not.toBeNull();
    expect(frame?.status).toBe("active");
  });

  it("retires a spent question frame left by an earlier turn", async () => {
    // Self-healing for state written before the drain existed.
    const stale: FlowState = {
      version: 1,
      stack: [
        {
          ...newFrame({ flow: "answer_question", at: "2026-09-03T10:00:00.000Z", topic: "phone" }),
          status: "active",
        },
      ],
    };
    const result = await turn([{ kind: "small_talk", talk: "greeting" }], context({ flows: stale }));
    expect(result.state.stack.filter((frame) => frame.flow === "answer_question")).toEqual([]);
    expect(result.trace).toContain("retired_stale_informational_frames");
  });

  it("defers rather than abandons the topics behind an open question", async () => {
    // `doctors` needs a department, so it asks. The address behind it is not
    // answered underneath that question, and is not left on the stack either.
    const result = await turn([ask("doctors"), ask("address")], context());
    const pending = result.state.stack.filter(
      (frame) => frame.flow === "answer_question" && frame.status !== "cancelled",
    );
    expect(pending.length).toBeLessThanOrEqual(1);
  });
});

describe("the grounding check sees every fact in a compound reply", () => {
  it("keeps one effect's facts from erasing another's", async () => {
    const result = await turn([ask("address"), ask("phone")], context());
    const composed = composeDeterministic({ effects: result.effects, locale: "ar" });
    const values = Object.values(composed.facts).filter(
      (value): value is string => typeof value === "string",
    );
    // Both `value` facts survive the merge. With a plain `Object.assign` the
    // second erased the first, and a polish that dropped the address passed the
    // grounding check.
    expect(values).toContain(CLINIC_INFO.address);
    expect(values).toContain(CLINIC_INFO.phone);
  });
});
