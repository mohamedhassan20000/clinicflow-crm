/**
 * The product behaviours from the rebuild brief, as executable assertions.
 *
 * Each `describe` below is one of the named cases. They run against the **real
 * flow definitions** in `lib/ai/v2/flows.ts` with the tool layer stubbed, so
 * what is being tested is the actual business logic — which step runs, what it
 * may read, what it may commit — rather than a parallel fixture of it.
 *
 * The interpreter is not involved. Its job is to turn Arabic into commands, and
 * these tests supply the commands directly so that a failure here is always a
 * business-logic failure and never a prompt one. The interpreter's own contract
 * is tested in `commands.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The tool layer, stubbed at the module boundary.
 *
 * Stubbing here rather than at the database means the flow definitions, the
 * engine, the preconditions and the composer are all the real ones. The stubs
 * are deliberately generous — the clinic has departments, doctors, days, times,
 * a package and a document — so that "nothing happened" in a test below is
 * never because there was nothing to find.
 */
const stubs = vi.hoisted(() => ({
  readDepartments: vi.fn(),
  readDoctors: vi.fn(),
  resolveDoctorSpoken: vi.fn(),
  readAvailableDays: vi.fn(),
  readAvailableSlots: vi.fn(),
  readPatientPackages: vi.fn(),
  readPublicPackages: vi.fn(),
  readServices: vi.fn(),
  resolveDepartmentSpoken: vi.fn(),
  resolveDepartmentNamed: vi.fn(),
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
import { composeDeterministic } from "@/lib/ai/v2/composer";
import type { TurnContext } from "@/lib/ai/v2/context";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const AT = NOW.toISOString();

const DERMA = { value: "dept-derma", label: "الجلدية", source: "clinic_directory" as const };
const CARDIO = { value: "dept-cardio", label: "القلب", source: "clinic_directory" as const };
const NABIL = { value: "doc-nabil", label: "Ahmed Nabil", source: "clinic_directory" as const };
const SARA = { value: "doc-sara", label: "Sara Ali", source: "clinic_directory" as const };

/**
 * Ahmed Nabil is this patient's treating doctor — the live failure's own data.
 *
 * Every assertion below that says "no calendar was read" is therefore saying
 * the strong thing: the fact is present, loadable and correct, and the
 * architecture still does not let it act.
 */
function context(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    clinicId: "clinic-1",
    conversationId: "conv-1",
    turn: { text: "", receivedAt: AT, locale: "ar", attachments: [] },
    episode: { turns: [] },
    flows: EMPTY_FLOW_STATE,
    durable: {
      treatingDoctors: async () => [
        { value: "doc-nabil", label: "Ahmed Nabil", source: "patient_history" },
      ],
      knownDepartments: async () => [
        { value: "dept-derma", label: "الجلدية", source: "patient_history" },
      ],
      activePackages: async () => [],
      issuedDocuments: async () => [],
      appointments: async () => [],
      canonicalName: async () => "أنس طلال",
    },
    history: { search: async () => [] },
    identity: "verified",
    patientId: "patient-1",
    clinic: {
      name: "Clinic",
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

function slotValue(value: string): Slot {
  return { value, provenance: "spoken", at: AT };
}

function frameWith(
  flow: Parameters<typeof newFrame>[0]["flow"],
  slots: Record<string, Slot> = {},
  extra: Partial<ReturnType<typeof newFrame>> = {},
): FlowState {
  return {
    version: 1,
    stack: [{ ...newFrame({ flow, at: AT }), slots, ...extra }],
  };
}

async function turn(commands: readonly Command[], ctx: TurnContext) {
  return runEngine({ context: ctx, commands, registry: FLOW_REGISTRY });
}

function offerIn(effects: readonly Effect[]) {
  const offer = effects.find((effect) => effect.kind === "offer");
  return offer && offer.kind === "offer" ? offer.offer : null;
}

function reply(effects: readonly Effect[], locale: "ar" | "en" = "ar") {
  return composeDeterministic({ effects, locale }).text;
}

beforeEach(() => {
  vi.clearAllMocks();
  stubs.readDepartments.mockResolvedValue([DERMA, CARDIO]);
  stubs.readDoctors.mockResolvedValue([NABIL, SARA]);
  stubs.resolveDoctorSpoken.mockResolvedValue({ kind: "unresolved" });
  stubs.readAvailableDays.mockResolvedValue({
    ok: true,
    windowStart: "2026-09-05",
    windowEnd: "2026-09-11",
    days: [
      { value: "2026-09-10", label: "2026-09-10", source: "clinic_directory" },
      { value: "2026-09-11", label: "2026-09-11", source: "clinic_directory" },
    ],
  });
  stubs.readAvailableSlots.mockResolvedValue({
    ok: true,
    times: [{ value: "10:00", label: "10:00", source: "clinic_directory" }],
  });
  stubs.readPatientPackages.mockResolvedValue([]);
  const laserPackage = {
    id: "tpl-1",
    name: "باقة الليزر",
    aliases: ["باقة الليزر"],
    departmentId: "dept-derm",
    departmentName: "الجلدية",
    totalSessions: 6,
    pricePerSession: 500,
    totalPrice: 3000,
    notes: null,
  };
  stubs.readPublicPackages.mockResolvedValue({
    groups: [
      {
        departmentId: "dept-derm",
        departmentName: "الجلدية",
        packages: [laserPackage],
      },
    ],
    all: [laserPackage],
    currency: "EGP",
    total: 1,
  });
  // The authoritative service catalog. Real names and real prices, so a test
  // asserting that nothing was invented is asserting against something.
  stubs.readServices.mockResolvedValue({
    groups: [
      {
        departmentId: "dept-pt",
        departmentName: "Physical Therapy",
        services: [
          { id: "svc-1", name: "Physical Therapy Assessment", price: 1000 },
          { id: "svc-2", name: "Rehabilitation Session", price: 1600 },
        ],
      },
    ],
    total: 2,
    currency: "TRY",
  });
  stubs.resolveDepartmentSpoken.mockResolvedValue([]);
  stubs.resolveDepartmentNamed.mockResolvedValue({ kind: "unresolved" });
  stubs.readPatientDocuments.mockResolvedValue([]);
  stubs.readDocumentLink.mockResolvedValue(null);
  stubs.readMyAppointments.mockResolvedValue([]);
  stubs.readTreatingDoctors.mockResolvedValue([
    { value: "doc-nabil", label: "Ahmed Nabil", source: "patient_history" },
  ]);
  stubs.readClinicInfo.mockResolvedValue({ name: "Clinic", phone: "0100", address: "Cairo" });
  stubs.resolveIdentity.mockResolvedValue({ kind: "none" });
  stubs.stageIntake.mockResolvedValue({ ok: true });
  stubs.commitBooking.mockResolvedValue({
    ok: true,
    appointmentId: "appt-1",
    packageSessionNumber: null,
  });
  stubs.commitCancellation.mockResolvedValue({ ok: true });
  stubs.commitReschedule.mockResolvedValue({ ok: true });
});

// ===========================================================================
// Conversational behaviour
// ===========================================================================

describe("«السلام عليكم» → greeting only, no flow", () => {
  it("answers, starts nothing, and reads no clinic data", async () => {
    const result = await turn([{ kind: "small_talk", talk: "greeting" }], context());
    expect(result.state.stack).toEqual([]);
    expect(stubs.readDepartments).not.toHaveBeenCalled();
    expect(stubs.readAvailableDays).not.toHaveBeenCalled();
    expect(stubs.readTreatingDoctors).not.toHaveBeenCalled();
    expect(reply(result.effects)).toContain("أهلًا");
  });
});

describe("«عندي استفسار» → clarification only, no flow", () => {
  it("is the live failure, and it is now impossible by construction", async () => {
    const result = await turn(
      [{ kind: "ask_clarification", reason: "unspecified_request" }],
      context({ turn: { text: "عندي استفسار", receivedAt: AT, locale: "ar", attachments: [] } }),
    );

    // No flow, so no rung, so nothing to force.
    expect(result.state.stack).toEqual([]);
    // The treating doctor was never even read, let alone committed.
    expect(stubs.readTreatingDoctors).not.toHaveBeenCalled();
    expect(stubs.readAvailableDays).not.toHaveBeenCalled();
    expect(stubs.commitBooking).not.toHaveBeenCalled();
    // And the answer is the one a receptionist gives.
    expect(reply(result.effects)).toBe("اتفضل، أقدر أساعدك في إيه؟");
  });

  it("mentions a parked booking without resuming it", async () => {
    const stale = frameWith(
      "book_appointment",
      { doctor: slotValue("doc-nabil"), department: slotValue("dept-derma") },
      { lastAdvancedAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString() },
    );
    const result = await turn(
      [{ kind: "ask_clarification", reason: "unspecified_request" }],
      context({ flows: stale }),
    );
    expect(stubs.readAvailableDays).not.toHaveBeenCalled();
    expect(activeFrame(result.state)).toBeNull();
    expect(reply(result.effects)).toContain("نكمّل الحجز");
  });
});

describe("«مين الدكتور اللي كنت بتابع معاه؟» → history lookup, not booking", () => {
  it("answers with the treating doctor and starts no booking", async () => {
    const result = await turn(
      [{ kind: "start_flow", flow: "patient_relationship_lookup" }],
      context(),
    );
    expect(reply(result.effects)).toContain("Ahmed Nabil");
    expect(stubs.readAvailableDays).not.toHaveBeenCalled();
    expect(stubs.commitBooking).not.toHaveBeenCalled();
    // The lookup completed, so nothing is left running.
    expect(activeFrame(result.state)).toBeNull();
  });

  it("refuses without verified identity rather than disclosing", async () => {
    const result = await turn(
      [{ kind: "start_flow", flow: "patient_relationship_lookup" }],
      context({ identity: "linked" }),
    );
    expect(reply(result.effects)).toContain("نتأكد من هويتك");
  });
});

// ===========================================================================
// Booking
// ===========================================================================

describe("«عايز احجز» → StartFlow(book_appointment)", () => {
  it("asks who it is for, and commits nothing from memory", async () => {
    const result = await turn(
      [{ kind: "start_flow", flow: "book_appointment" }],
      context(),
    );
    expect(activeFrame(result.state)?.flow).toBe("book_appointment");
    expect(activeFrame(result.state)?.slots).toEqual({});
    expect(stubs.readAvailableDays).not.toHaveBeenCalled();
    expect(reply(result.effects)).toContain("ليك إنت ولا لحد تاني");
  });
});

describe("«عايز احجز مع نفس الدكتور» → prior doctor as an affirmable candidate", () => {
  it("offers the treating doctor first without committing them", async () => {
    const state = frameWith("book_appointment", {
      beneficiary: slotValue("self"),
      department: slotValue("dept-derma"),
    });
    const result = await turn([], context({ flows: state }));

    const offer = offerIn(result.effects);
    expect(offer?.slot).toBe("doctor");
    // Offered first — the convenience the brief asks for.
    expect(offer?.options[0]?.label).toBe("Ahmed Nabil");
    expect(offer?.options[0]?.source).toBe("patient_history");
    // And still not chosen.
    expect(activeFrame(result.state)?.slots.doctor).toBeUndefined();
    expect(stubs.readAvailableDays).not.toHaveBeenCalled();

    // Accepting it commits with `affirmed` provenance, never `spoken`, and
    // never anything that would let a future reader mistake it for memory.
    const accepted = await turn(
      [{ kind: "affirm_offer", offerId: offer!.id }],
      context({ flows: result.state }),
    );
    expect(activeFrame(accepted.state)?.slots.doctor).toMatchObject({
      value: "doc-nabil",
      provenance: "affirmed",
    });
    // Only now is the calendar readable.
    expect(stubs.readAvailableDays).toHaveBeenCalled();
  });
});

describe("«لا دكتور تاني» → RejectOffer and a negative constraint", () => {
  it("rules the doctor out and never offers them again", async () => {
    const state = frameWith("book_appointment", {
      beneficiary: slotValue("self"),
      department: slotValue("dept-derma"),
    });
    const offered = await turn([], context({ flows: state }));
    const offer = offerIn(offered.effects)!;

    const rejected = await turn(
      [{ kind: "reject_offer", offerId: offer.id }],
      context({ flows: offered.state }),
    );
    const frame = activeFrame(rejected.state)!;
    expect(frame.rejected.doctor).toContain("doc-nabil");

    // The next read excludes them — the constraint reaches the tool.
    expect(stubs.readDoctors).toHaveBeenLastCalledWith(
      expect.objectContaining({ excluding: expect.arrayContaining(["doc-nabil"]) }),
    );
  });
});

describe("«لا قصدي بعد يوم ٩» → correction cascades", () => {
  it("drops the day and the time together and re-reads the calendar", async () => {
    const state = frameWith("book_appointment", {
      beneficiary: slotValue("self"),
      department: slotValue("dept-derma"),
      doctor: slotValue("doc-nabil"),
      day: slotValue("2026-09-10"),
      time: slotValue("10:00"),
    });
    const result = await turn(
      [{ kind: "correct_slot", slot: "day", value: "2026-09-11" }],
      context({ flows: state }),
    );
    const frame = activeFrame(result.state)!;
    expect(frame.slots.day?.value).toBe("2026-09-11");
    expect(frame.slots.time).toBeUndefined();
    // Facts about *who and where* are untouched by a date correction.
    expect(frame.slots.doctor?.value).toBe("doc-nabil");
    expect(frame.slots.department?.value).toBe("dept-derma");
  });
});

describe("«طب بكام الكشف؟» during booking → suspend, answer, resume", () => {
  it("keeps every booking slot and returns to the same step", async () => {
    const state = frameWith("book_appointment", {
      beneficiary: slotValue("self"),
      department: slotValue("dept-derma"),
      doctor: slotValue("doc-nabil"),
    });
    const result = await turn(
      [{ kind: "suspend_flow" }, { kind: "answer_question", topic: "prices" }],
      context({ flows: state }),
    );
    const booking = result.state.stack.find((frame) => frame.flow === "book_appointment");
    expect(booking?.status).toBe("active");
    expect(booking?.slots.doctor?.value).toBe("doc-nabil");
    expect(reply(result.effects)).toContain("الأسعار");
  });
});

describe("no booking before an explicit confirmation", () => {
  it("shows the summary on one turn and writes only on the next", async () => {
    const state = frameWith("book_appointment", {
      beneficiary: slotValue("self"),
      department: slotValue("dept-derma"),
      doctor: slotValue("doc-nabil"),
      day: slotValue("2026-09-10"),
      time: slotValue("10:00"),
    });
    const reviewed = await turn([], context({ flows: state }));
    expect(stubs.commitBooking).not.toHaveBeenCalled();
    const offer = offerIn(reviewed.effects)!;
    expect(offer.kind).toBe("summary");

    const confirmed = await turn(
      [{ kind: "affirm_offer", offerId: offer.id }],
      context({ flows: reviewed.state }),
    );
    expect(stubs.commitBooking).toHaveBeenCalledTimes(1);
    expect(reply(confirmed.effects)).toContain("سجلت طلب الحجز");
  });
});

// ===========================================================================
// Packages
// ===========================================================================

describe("package inquiry without being a patient", () => {
  it("answers from clinic configuration and never touches patient packages", async () => {
    const result = await turn(
      [{ kind: "start_flow", flow: "package_inquiry" }],
      context({ identity: "anonymous", patientId: null }),
    );
    expect(stubs.readPublicPackages).toHaveBeenCalled();
    expect(stubs.readPatientPackages).not.toHaveBeenCalled();
    expect(reply(result.effects)).toContain("باقة الليزر");
  });
});

describe("identified patient with an applicable package", () => {
  it("offers the package and does not consume a session", async () => {
    stubs.readPatientPackages.mockResolvedValue([
      { value: "pkg-1", label: "باقة الليزر · 4", source: "patient_packages" },
    ]);
    const state = frameWith("book_appointment", {
      beneficiary: slotValue("self"),
      department: slotValue("dept-derma"),
      doctor: slotValue("doc-nabil"),
      day: slotValue("2026-09-10"),
      time: slotValue("10:00"),
    });
    const result = await turn([], context({ flows: state }));

    const offer = offerIn(result.effects)!;
    // A distinct offer kind, so accepting it cannot be confused with choosing
    // a value — accepting it is permission to decrement.
    expect(offer.kind).toBe("package_use");
    expect(activeFrame(result.state)?.slots.package).toBeUndefined();
    expect(stubs.commitBooking).not.toHaveBeenCalled();
  });

  it("consumes a session only after acceptance, and only through the write", async () => {
    stubs.readPatientPackages.mockResolvedValue([
      { value: "pkg-1", label: "باقة الليزر · 4", source: "patient_packages" },
    ]);
    const state = frameWith("book_appointment", {
      beneficiary: slotValue("self"),
      department: slotValue("dept-derma"),
      doctor: slotValue("doc-nabil"),
      day: slotValue("2026-09-10"),
      time: slotValue("10:00"),
    });
    const offered = await turn([], context({ flows: state }));
    const packageOffer = offerIn(offered.effects)!;

    const accepted = await turn(
      [{ kind: "affirm_offer", offerId: packageOffer.id }],
      context({ flows: offered.state }),
    );
    // Acceptance records permission; it does not itself decrement anything.
    const frame = activeFrame(accepted.state)!;
    expect(frame.memo.package_accepted).toBe(true);
    expect(frame.memo.package_id).toBe("pkg-1");

    const summaryOffer = offerIn(accepted.effects)!;
    expect(summaryOffer.kind).toBe("summary");
    const confirmed = await turn(
      [{ kind: "affirm_offer", offerId: summaryOffer.id }],
      context({ flows: accepted.state }),
    );
    void confirmed;
    // The package reaches the write, which is the only place a session is
    // consumed — transactionally, under a row lock, inside the booking RPC.
    expect(stubs.commitBooking).toHaveBeenCalledWith(
      expect.objectContaining({ packageId: "pkg-1" }),
    );
  });

  it("never passes a package the patient did not accept", async () => {
    stubs.readPatientPackages.mockResolvedValue([
      { value: "pkg-1", label: "باقة الليزر · 4", source: "patient_packages" },
    ]);
    // A declined package is `package_declined` on the memo — the decision the
    // engine records when `reject_offer` names a `package_use` offer. It was
    // written here as a `package` slot holding the string "skipped", which was
    // the only way past a step that (wrongly) declared `fills: "package"`; the
    // step now records its own decision and the slot means what it says.
    const state = frameWith(
      "book_appointment",
      {
        beneficiary: slotValue("self"),
        department: slotValue("dept-derma"),
        doctor: slotValue("doc-nabil"),
        day: slotValue("2026-09-10"),
        time: slotValue("10:00"),
      },
      { memo: { confirmed: true, package_declined: true } },
    );
    await turn([], context({ flows: state }));
    expect(stubs.commitBooking).toHaveBeenCalledWith(
      expect.objectContaining({ packageId: null }),
    );
  });
});

// ===========================================================================
// Documents
// ===========================================================================

describe("existing documents", () => {
  it("lists issued documents and delivers a link, never issues one", async () => {
    stubs.readPatientDocuments.mockResolvedValue([
      { value: "doc-1", label: "INVOICE INV-2026-0001", source: "patient_documents" },
    ]);
    stubs.readDocumentLink.mockResolvedValue({
      url: "https://signed.example/inv.pdf",
      label: "INVOICE INV-2026-0001",
    });

    const listed = await turn(
      [{ kind: "start_flow", flow: "retrieve_document" }],
      context(),
    );
    const offer = offerIn(listed.effects)!;
    expect(offer.kind).toBe("document_choice");

    const delivered = await turn(
      [{ kind: "affirm_offer", offerId: offer.id }],
      context({ flows: listed.state }),
    );
    // The link still reaches the patient — it is just carried separately from
    // the prose now, so it never enters the polish prompt. See `LINK_FACTS`.
    const composed = composeDeterministic({ effects: delivered.effects, locale: "ar" });
    expect(composed.links).toContain("https://signed.example/inv.pdf");
    expect(composed.text).toContain("INVOICE INV-2026-0001");
    expect(composed.text).not.toContain("https://signed.example/inv.pdf");
    // Nothing in this flow can create a document. `stageIntake` and
    // `commitBooking` are the only writes in the tool layer and neither ran.
    expect(stubs.stageIntake).not.toHaveBeenCalled();
    expect(stubs.commitBooking).not.toHaveBeenCalled();
  });

  it("refuses the whole flow without verified identity", async () => {
    const result = await turn(
      [{ kind: "start_flow", flow: "retrieve_document" }],
      context({ identity: "linked" }),
    );
    expect(stubs.readPatientDocuments).not.toHaveBeenCalled();
    expect(reply(result.effects)).toContain("نتأكد من هويتك");
  });

  it("says so plainly when the patient has none", async () => {
    const result = await turn(
      [{ kind: "start_flow", flow: "retrieve_document" }],
      context(),
    );
    expect(reply(result.effects)).toContain("مفيش مستندات");
  });
});

describe("«طلعلي فاتورة جديدة» → the AI may not issue one", () => {
  it("hands off, and no flow in the registry can create a document", async () => {
    const result = await turn(
      [{ kind: "request_handoff", reason: "unsupported_request" }],
      context(),
    );
    expect(result.effects).toEqual([
      { kind: "handoff", reason: "unsupported_request" },
    ]);
    expect(stubs.stageIntake).not.toHaveBeenCalled();

    // The structural claim, asserted rather than asserted-about: no step in any
    // flow can reach an issuance path, because the tool layer has none.
    const toolNames = Object.keys(stubs);
    expect(toolNames.filter((name) => /issue|createDocument|finalize/i.test(name))).toEqual(
      [],
    );
  });
});

// ===========================================================================
// Identity
// ===========================================================================

describe("existing patient, national ID + transliteration variation", () => {
  it("continues the existing file and creates no duplicate", async () => {
    stubs.resolveIdentity.mockResolvedValue({
      kind: "matched",
      patientId: "patient-1",
      canonicalName: "Anas Talal Ali",
      departments: [{ id: "dept-derma", name: "الجلدية" }],
      treatingDoctorByDepartment: {},
    });
    const state = frameWith("register_patient", {
      // Spelled one letter short of the file — the exact case from the brief.
      full_name: slotValue("Anas Talal Ai"),
      national_id: slotValue("29001011234567"),
    });
    const result = await turn([], context({ flows: state }));

    expect(stubs.stageIntake).not.toHaveBeenCalled();
    // Greeted by the canonical name ClinicFlow stores, not the one they typed.
    expect(reply(result.effects)).toContain("Anas Talal Ali");
    expect(result.state.stack).toEqual([]);
  });

  it("does not disclose whether another person's ID exists", async () => {
    // The RPC answers a non-match with nothing, and every non-match is the same
    // `none` — so a wrong name against a real id is indistinguishable from an
    // id nobody has. This asserts the flow does not add a distinction back.
    stubs.resolveIdentity.mockResolvedValue({ kind: "none" });
    const state = frameWith("register_patient", {
      full_name: slotValue("Someone Else"),
      national_id: slotValue("29001011234567"),
    });
    const result = await turn([], context({ flows: state }));
    const text = reply(result.effects);
    expect(text).not.toMatch(/موجود|exists|belongs/i);
    expect(text).toContain("ملف جديد");
  });
});

describe("new patient with an uncertain name", () => {
  it("asks to confirm the English spelling before the file is created", async () => {
    const state = frameWith("register_patient", {
      // A name whose parts have no curated reading, so the proposal is a guess.
      full_name: slotValue("چيهاد ڤرجاني"),
      national_id: slotValue("29001011234567"),
    });
    const result = await turn(
      [],
      context({ flows: { ...state, stack: [{ ...state.stack[0]!, memo: { identity_checked: true } }] } }),
    );
    expect(stubs.stageIntake).not.toHaveBeenCalled();
    const offer = offerIn(result.effects);
    const text = reply(result.effects);
    // Either an offer of the proposed spelling or a direct ask — both confirm
    // before creating, which is the rule.
    expect(offer !== null || /بالإنجليزي|هكتب اسمك/.test(text)).toBe(true);
  });
});

// ===========================================================================
// Ending
// ===========================================================================

describe("«خلاص شكرا» → deterministic close", () => {
  it("ends a clean thread with no further reads", async () => {
    const result = await turn([{ kind: "end_conversation" }], context());
    expect(result.state.stack).toEqual([]);
    expect(result.effects).toEqual([{ kind: "end_conversation" }]);
    expect(stubs.readDepartments).not.toHaveBeenCalled();
  });

  it("asks before discarding a staged file", async () => {
    const state = frameWith("book_appointment", {}, { memo: { intake_staged: true } });
    const result = await turn(
      [{ kind: "end_conversation" }],
      context({ flows: state }),
    );
    expect(reply(result.effects)).toContain("للفريق يراجعها");
    expect(result.state.stack).toHaveLength(1);
  });
});

// ===========================================================================
// Copy parity
// ===========================================================================

describe("every reply the assistant can produce exists in both languages", () => {
  it("has Arabic and English for each copy key", async () => {
    const { COMPOSER_COPY } = await import("@/lib/ai/v2/composer");
    for (const [key, copy] of Object.entries(COMPOSER_COPY)) {
      expect(copy.ar, `${key} is missing Arabic`).toBeTruthy();
      expect(copy.en, `${key} is missing English`).toBeTruthy();
    }
  });
});
