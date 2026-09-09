/**
 * The second manual-QA pass, frozen as behaviour contracts.
 *
 * Five findings, and the assertions below are on the property rather than on
 * the sentence in every case:
 *
 *   1. **packages and insurance were half-topics.** Both were valid
 *      `QUESTION_TOPIC`s the interpreter was prompted to emit, and both
 *      answered only the widest form of the question: `packages` ignored the
 *      department the patient named and rendered a flat comma-separated run,
 *      and `insurance` could not answer «بتقبلوا AXA؟» at all. Neither could
 *      show a clinic-authored Arabic name, because there was none to show.
 *   2. **the confirmation gate held, and nothing tested that it did.** The
 *      write is two turns from the summary by construction; these tests pin it.
 *   3. **an edit with no field named had nowhere to go.** «عايز أغير» reached
 *      `ask_clarification`, which inside a flow re-asked the current step —
 *      so the patient's request to change something was answered by repeating
 *      the question they had already answered.
 *   4. **a staged file dead-ended the booking.** `confirm` required
 *      `identity: "linked"`, and staging never links a conversation.
 *   5. **a beneficiary answer could escalate to a human before the engine ran.**
 *      Covered separately in `p5b-patient-escalation.test.ts`.
 *
 * The tool layer is stubbed at the module boundary; the flow definitions, the
 * engine, the preconditions, the name matching and the composer are real.
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
import {
  EMPTY_FLOW_STATE,
  newFrame,
  type FlowFrame,
  type FlowState,
} from "@/lib/ai/v2/flow-state";
import { runEngine, type Effect } from "@/lib/ai/v2/engine";
import { FLOW_REGISTRY } from "@/lib/ai/v2/flows";
import { composeDeterministic } from "@/lib/ai/v2/composer";
import type { TurnContext } from "@/lib/ai/v2/context";
import { resolveInsuranceProvider, resolvePackageNamed } from "@/lib/ai/v2/catalog";
import type { PackageEntry } from "@/lib/ai/v2/catalog";
import { localizedName } from "@/lib/ai/v2/present";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const AT = NOW.toISOString();

const DEPARTMENTS = [
  { value: "dept-derma", label: "الجلدية", source: "clinic_directory" as const },
  { value: "dept-physio", label: "العلاج الطبيعي", source: "clinic_directory" as const },
];

/** Two departments' worth of packages, as `readPublicPackages` returns them. */
function packageEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "tpl-acne",
    name: "باكيدج علاج حب الشباب",
    aliases: ["Acne Treatment Package", "باكيدج علاج حب الشباب"],
    departmentId: "dept-derma",
    departmentName: "الجلدية",
    totalSessions: 6,
    pricePerSession: 750,
    totalPrice: 4500,
    // Department-only by default, which is what every package in this clinic
    // is until somebody adds service lines to one.
    items: [] as PackageEntry["items"],
    notes: null as string | null,
    ...overrides,
  };
}

const ACNE = packageEntry();
const SKINCARE = packageEntry({
  id: "tpl-skin",
  name: "باكيدج العناية بالبشرة",
  aliases: ["Skincare Package", "باكيدج العناية بالبشرة"],
  totalPrice: 6000,
  pricePerSession: null,
});
const REHAB = packageEntry({
  id: "tpl-rehab",
  name: "باكيدج التأهيل",
  aliases: ["Rehabilitation Package", "باكيدج التأهيل"],
  departmentId: "dept-physio",
  departmentName: "العلاج الطبيعي",
  totalSessions: 10,
  totalPrice: 5000,
  pricePerSession: 500,
  notes: "10 جلسات علاج طبيعي + تقييم أولي",
});

const CATALOG = {
  groups: [
    { departmentId: "dept-derma", departmentName: "الجلدية", packages: [ACNE, SKINCARE] },
    { departmentId: "dept-physio", departmentName: "العلاج الطبيعي", packages: [REHAB] },
  ],
  all: [ACNE, SKINCARE, REHAB],
  currency: "TRY",
  total: 3,
};

const INSURERS = [
  { id: "ins-axa", label: "أكسا", aliases: ["AXA", "أكسا"] },
  { id: "ins-allianz", label: "أليانز", aliases: ["Allianz", "أليانز"] },
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
      canonicalName: async () => "حسام حسن محمد",
    },
    history: { search: async () => [] },
    identity: "linked",
    patientId: "patient-sender",
    clinic: {
      name: "عيادة الابتسامة",
      timeZone: "Africa/Cairo",
      locale: "ar",
      country: "EG",
      timeFormat: "12h",
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

function ask(topic: "packages" | "insurance" | "prices", scope?: string): Command {
  return { kind: "answer_question", topic, ...(scope ? { scope } : {}) };
}

/** A booking frame with everything a summary needs already committed. */
const READY_TO_CONFIRM: FlowFrame["slots"] = {
  beneficiary: { value: "self", label: "ليك إنت", provenance: "affirmed", at: AT },
  department: { value: "dept-physio", label: "العلاج الطبيعي", provenance: "affirmed", at: AT },
  doctor: { value: "doc-youssef", label: "د. يوسف عادل", provenance: "affirmed", at: AT },
  day: { value: "2026-09-18", label: "الجمعة — 18-09-2026", provenance: "affirmed", at: AT },
  time: { value: "11:15", label: "11:15 صباحًا", provenance: "affirmed", at: AT },
};

function bookingState(
  slots: FlowFrame["slots"],
  memo: Record<string, string | number | boolean> = {},
): FlowState {
  return {
    ...EMPTY_FLOW_STATE,
    stack: [
      {
        ...newFrame({ flow: "book_appointment", at: AT }),
        slots,
        // Every step before `confirm` recorded done, so the engine advances
        // straight to the summary rather than replaying the ladder.
        memo: {
          "done:package_offer": true,
          "done:intake": true,
          booking_patient_known: true,
          ...memo,
        },
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stubs.readDepartments.mockResolvedValue(DEPARTMENTS);
  stubs.readDoctors.mockResolvedValue([]);
  stubs.readClinicInfo.mockResolvedValue({ name: "عيادة الابتسامة", phone: "+20222222222" });
  stubs.readClinicFaq.mockResolvedValue([]);
  stubs.readClinicInsurance.mockResolvedValue(INSURERS);
  stubs.readPublicPackages.mockResolvedValue(CATALOG);
  stubs.readServices.mockResolvedValue({ groups: [], currency: "TRY", total: 0 });
  stubs.readPatientPackages.mockResolvedValue([]);
  stubs.readMyAppointments.mockResolvedValue([]);
  stubs.readTreatingDoctors.mockResolvedValue([]);
  stubs.readKnownDepartments.mockResolvedValue([]);
  stubs.resolveDepartmentSpoken.mockResolvedValue([]);
  stubs.resolveDepartmentNamed.mockResolvedValue({ kind: "unresolved" });
  stubs.readAvailableDays.mockResolvedValue({
    ok: true,
    days: [{ value: "2026-09-18", label: "الجمعة — 18-09-2026", source: "clinic_directory" }],
    windowStart: "2026-09-08",
    windowEnd: "2026-09-18",
  });
  stubs.readAvailableSlots.mockResolvedValue({
    ok: true,
    times: [
      { value: "11:15", label: "11:15 صباحًا", source: "clinic_directory" },
      { value: "12:00", label: "12:00 ظهرًا", source: "clinic_directory" },
    ],
  });
  stubs.commitBooking.mockResolvedValue({
    ok: true,
    appointmentId: "appt-1",
    packageSessionNumber: null,
  });
});

// ---------------------------------------------------------------------------
// 1. Bilingual labels for packages and insurers
// ---------------------------------------------------------------------------

describe("bilingual display names", () => {
  const entity = {
    name: "Acne Treatment Package",
    nameAr: "باكيدج علاج حب الشباب",
    nameEn: "Acne Care Package",
  };

  it("prefers the clinic's Arabic label in an Arabic conversation", () => {
    expect(localizedName(entity, "ar")).toBe("باكيدج علاج حب الشباب");
  });

  it("prefers the clinic's English label in an English conversation", () => {
    expect(localizedName(entity, "en")).toBe("Acne Care Package");
  });

  it("falls back to the canonical stored name, never to a generated one", () => {
    // The whole point of the fallback: a clinic that authored nothing gets its
    // own stored string in both languages, and nothing invents an Arabic name.
    expect(localizedName({ name: "AXA" }, "ar")).toBe("AXA");
    expect(localizedName({ name: "AXA" }, "en")).toBe("AXA");
  });

  it("resolves either language's package name to the same entity", () => {
    const arabic = resolvePackageNamed({ packages: CATALOG.all, spoken: "باكيدج التأهيل" });
    const english = resolvePackageNamed({
      packages: CATALOG.all,
      spoken: "Rehabilitation Package",
    });
    expect(arabic.kind).toBe("matched");
    expect(english.kind).toBe("matched");
    expect(arabic.kind === "matched" && arabic.entry.id).toBe("tpl-rehab");
    expect(english.kind === "matched" && english.entry.id).toBe("tpl-rehab");
  });

  it("resolves either language's insurer name to the same entity", () => {
    const arabic = resolveInsuranceProvider({ providers: INSURERS, spoken: "أكسا" });
    const english = resolveInsuranceProvider({ providers: INSURERS, spoken: "AXA" });
    expect(arabic.kind === "matched" && arabic.provider.id).toBe("ins-axa");
    expect(english.kind === "matched" && english.provider.id).toBe("ins-axa");
  });
});

// ---------------------------------------------------------------------------
// 2. Package informational queries
// ---------------------------------------------------------------------------

describe("package questions", () => {
  it("answers «ايه الباكيدجات المتاحة؟» from the clinic's own catalog", async () => {
    const result = await turn([ask("packages")], context());
    const text = reply(result.effects);
    expect(stubs.readPublicPackages).toHaveBeenCalled();
    expect(text).toContain("باكيدج علاج حب الشباب");
    expect(text).toContain("باكيدج التأهيل");
  });

  it("groups them under department headings, one package per line", async () => {
    const text = reply((await turn([ask("packages")], context())).effects);
    expect(text).toContain("الجلدية:\n- باكيدج علاج حب الشباب");
    expect(text).toContain("العلاج الطبيعي:\n- باكيدج التأهيل");
    // A blank line between departments, and no separator rules anywhere.
    expect(text).toContain("\n\nالعلاج الطبيعي:");
    expect(text).not.toMatch(/[-=*_]{3,}/);
  });

  it("puts the price on the line of the package it belongs to", async () => {
    const text = reply((await turn([ask("packages")], context())).effects);
    expect(text).toContain("- باكيدج علاج حب الشباب — 4500 TRY");
    expect(text).toContain("- باكيدج التأهيل — 5000 TRY");
  });

  it("scopes to one department when the patient named one", async () => {
    stubs.resolveDepartmentSpoken.mockResolvedValue([DEPARTMENTS[0]!]);
    stubs.readPublicPackages.mockResolvedValue({
      ...CATALOG,
      groups: [CATALOG.groups[0]!],
      all: [ACNE, SKINCARE],
      total: 2,
    });
    const text = reply((await turn([ask("packages", "الجلدية")], context())).effects);
    expect(stubs.readPublicPackages).toHaveBeenCalledWith(
      expect.objectContaining({ departmentId: "dept-derma" }),
    );
    expect(text).toContain("باكيدج علاج حب الشباب");
    expect(text).not.toContain("باكيدج التأهيل");
  });

  it("answers a specific package with the clinic's configured facts only", async () => {
    const text = reply(
      (await turn([ask("packages", "باكيدج التأهيل")], context())).effects,
    );
    expect(text).toContain("باكيدج التأهيل");
    expect(text).toContain("5000 TRY");
    expect(text).toContain("10");
    // The clinic's own note, quoted. Nothing about the contents is derived
    // from the package's name.
    expect(text).toContain("10 جلسات علاج طبيعي + تقييم أولي");
  });

  it("never invents a package it was not given", async () => {
    const text = reply(
      (await turn([ask("packages", "باكيدج تبييض الأسنان")], context())).effects,
    );
    expect(text).not.toContain("تبييض");
    // Says so plainly, then shows what the clinic actually offers.
    expect(text).toContain("باكيدج علاج حب الشباب");
  });

  it("says so plainly when the clinic has none configured", async () => {
    stubs.readPublicPackages.mockResolvedValue({
      groups: [],
      all: [],
      currency: "TRY",
      total: 0,
    });
    const text = reply((await turn([ask("packages")], context())).effects);
    expect(text).toContain("مفيش باكيدجات");
  });
});

// ---------------------------------------------------------------------------
// 3. Insurance informational queries
// ---------------------------------------------------------------------------

describe("insurance questions", () => {
  it("lists the configured insurers, numbered, one per line", async () => {
    const text = reply((await turn([ask("insurance")], context())).effects);
    expect(text).toContain("1- أكسا");
    expect(text).toContain("2- أليانز");
  });

  it("answers a specific provider yes from the clinic's own configuration", async () => {
    const text = reply((await turn([ask("insurance", "AXA")], context())).effects);
    expect(text).toContain("أكسا");
    expect(text).toMatch(/^أيوه/);
  });

  it("answers a provider the clinic has not configured with a plain no", async () => {
    const text = reply((await turn([ask("insurance", "Bupa")], context())).effects);
    expect(text).toMatch(/^لأ/);
    expect(text).not.toContain("Bupa");
    // …and then the real list, so the answer is useful rather than merely true.
    expect(text).toContain("1- أكسا");
  });

  it("never promises service-level coverage", async () => {
    for (const command of [ask("insurance"), ask("insurance", "AXA")]) {
      const text = reply((await turn([command], context())).effects);
      // The distinction the schema forces: the clinic works with the insurer;
      // whether a service is covered is not a fact this system holds.
      expect(text).toContain("فريق العيادة");
      expect(text).not.toMatch(/%|نسبة التغطية|مغطى بالكامل/);
    }
  });

  it("does not reveal a deactivated provider", async () => {
    // `readClinicInsurance` filters on `is_active` and `deleted_at`, so a
    // deactivated insurer is not in the candidate set at all — it can be
    // neither confirmed nor listed, which is what stops this becoming an
    // existence oracle over the clinic's history.
    stubs.readClinicInsurance.mockResolvedValue([INSURERS[0]!]);
    const text = reply((await turn([ask("insurance", "Allianz")], context())).effects);
    expect(text).not.toContain("أليانز");
    expect(text).toMatch(/^لأ/);
  });
});

// ---------------------------------------------------------------------------
// 4. The compound question
// ---------------------------------------------------------------------------

describe("compound package + insurance question", () => {
  it("answers both, in the order the patient asked", async () => {
    stubs.resolveDepartmentSpoken.mockResolvedValue([DEPARTMENTS[0]!]);
    stubs.readPublicPackages.mockResolvedValue({
      ...CATALOG,
      groups: [CATALOG.groups[0]!],
      all: [ACNE, SKINCARE],
      total: 2,
    });
    const result = await turn(
      [ask("packages", "الجلدية"), ask("insurance")],
      context(),
    );
    const text = reply(result.effects);
    expect(text.indexOf("باكيدج علاج حب الشباب")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("باكيدج علاج حب الشباب")).toBeLessThan(text.indexOf("أكسا"));
    // Composes with the existing compound architecture rather than being a
    // one-off: two frames, both drained, neither left behind.
    expect(result.state.stack.filter((frame) => frame.flow === "answer_question")).toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// 5. The confirmation gate
// ---------------------------------------------------------------------------

describe("the booking confirmation gate", () => {
  it("does not write when every slot is filled but nothing was confirmed", async () => {
    const result = await turn([], context({ flows: bookingState(READY_TO_CONFIRM) }));
    expect(stubs.commitBooking).not.toHaveBeenCalled();
    expect(result.effects.some((effect) => effect.kind === "offer")).toBe(true);
  });

  it("emits a full summary, one field per line, ending in the question", async () => {
    const result = await turn([], context({ flows: bookingState(READY_TO_CONFIRM) }));
    const text = reply(result.effects);
    expect(text).toContain("المريض: حسام حسن محمد");
    expect(text).toContain("القسم: العلاج الطبيعي");
    expect(text).toContain("الدكتور: د. يوسف عادل");
    expect(text).toContain("اليوم: الجمعة — 18-09-2026");
    expect(text).toContain("الوقت: 11:15 صباحًا");
    expect(text.trimEnd().endsWith("تحب تأكد الطلب؟")).toBe(true);
    expect(text).not.toMatch(/[-=*_]{3,}/);
  });

  it("writes only once the patient has affirmed that summary", async () => {
    const offered = await turn([], context({ flows: bookingState(READY_TO_CONFIRM) }));
    const offer = offered.state.stack[0]!.offer!;
    expect(offer.kind).toBe("summary");
    const confirmed = await turn(
      [{ kind: "affirm_offer", offerId: offer.id }],
      context({ flows: offered.state }),
    );
    expect(stubs.commitBooking).toHaveBeenCalledTimes(1);
    expect(reply(confirmed.effects)).toContain("سجلت طلب الحجز");
  });

  it("does not write when the summary is rejected", async () => {
    const offered = await turn([], context({ flows: bookingState(READY_TO_CONFIRM) }));
    const offer = offered.state.stack[0]!.offer!;
    await turn(
      [{ kind: "reject_offer", offerId: offer.id }],
      context({ flows: offered.state }),
    );
    expect(stubs.commitBooking).not.toHaveBeenCalled();
  });

  it("does not say the appointment is confirmed when it is a request", async () => {
    const offered = await turn([], context({ flows: bookingState(READY_TO_CONFIRM) }));
    const offer = offered.state.stack[0]!.offer!;
    const done = await turn(
      [{ kind: "affirm_offer", offerId: offer.id }],
      context({ flows: offered.state }),
    );
    const text = reply(done.effects);
    // The domain writes a *pending* request, so the copy says so.
    expect(text).toContain("في انتظار تأكيد العيادة");
    expect(text).not.toContain("تم تأكيد الموعد");
  });

  it("asks whether anything else is needed once the booking is in", async () => {
    const offered = await turn([], context({ flows: bookingState(READY_TO_CONFIRM) }));
    const offer = offered.state.stack[0]!.offer!;
    const done = await turn(
      [{ kind: "affirm_offer", offerId: offer.id }],
      context({ flows: offered.state }),
    );
    expect(reply(done.effects)).toContain("حاجة تانية");
  });

  it("clears the stack when the patient says they are finished", async () => {
    const offered = await turn([], context({ flows: bookingState(READY_TO_CONFIRM) }));
    const offer = offered.state.stack[0]!.offer!;
    const done = await turn(
      [{ kind: "affirm_offer", offerId: offer.id }],
      context({ flows: offered.state }),
    );
    const closed = await turn(
      [{ kind: "end_conversation" }],
      context({ flows: done.state }),
    );
    expect(closed.state.stack).toEqual([]);
    expect(closed.effects.some((effect) => effect.kind === "end_conversation")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Corrections while the confirmation is open
// ---------------------------------------------------------------------------

describe("corrections at the confirmation step", () => {
  it("drops the time when the day changes and does not write", async () => {
    const offered = await turn([], context({ flows: bookingState(READY_TO_CONFIRM) }));
    const corrected = await turn(
      [{ kind: "correct_slot", slot: "day", value: "الخميس" }],
      context({ flows: offered.state }),
    );
    const frame = corrected.state.stack[0]!;
    expect(frame.slots.time).toBeUndefined();
    expect(stubs.commitBooking).not.toHaveBeenCalled();
  });

  it("drops the day and the time when the doctor changes", async () => {
    stubs.resolveDoctorSpoken.mockResolvedValue({
      kind: "resolved",
      value: "doc-haneen",
      label: "د. حنين",
    });
    const offered = await turn([], context({ flows: bookingState(READY_TO_CONFIRM) }));
    const corrected = await turn(
      [{ kind: "correct_slot", slot: "doctor", value: "دكتور حنين" }],
      context({ flows: offered.state }),
    );
    const frame = corrected.state.stack[0]!;
    expect(frame.slots.day).toBeUndefined();
    expect(frame.slots.time).toBeUndefined();
    expect(stubs.commitBooking).not.toHaveBeenCalled();
  });

  it("emits a new summary once the corrected request is complete again", async () => {
    const offered = await turn([], context({ flows: bookingState(READY_TO_CONFIRM) }));
    const corrected = await turn(
      [{ kind: "correct_slot", slot: "time", value: "12:00" }],
      context({ flows: offered.state }),
    );
    const text = reply(corrected.effects);
    expect(text).toContain("الوقت: 12:00 ظهرًا");
    expect(text.trimEnd().endsWith("تحب تأكد الطلب؟")).toBe(true);
    expect(stubs.commitBooking).not.toHaveBeenCalled();
  });

  it("cannot let an old confirmation authorize the corrected booking", async () => {
    // The offer the patient was shown is withdrawn by the correction, so its
    // id no longer names anything — an affirmation carrying it authorizes
    // nothing rather than authorizing the new values.
    const offered = await turn([], context({ flows: bookingState(READY_TO_CONFIRM) }));
    const stale = offered.state.stack[0]!.offer!;
    const corrected = await turn(
      [{ kind: "correct_slot", slot: "time", value: "12:00" }],
      context({ flows: offered.state }),
    );
    vi.clearAllMocks();
    stubs.commitBooking.mockResolvedValue({ ok: true, appointmentId: "x", packageSessionNumber: null });
    const replayed = await turn(
      [{ kind: "affirm_offer", offerId: stale.id }],
      context({ flows: corrected.state }),
    );
    expect(stubs.commitBooking).not.toHaveBeenCalled();
    expect(replayed.trace).toContain("affirm_unknown_offer");
  });

  it("asks what to change when the patient does not say", async () => {
    const offered = await turn([], context({ flows: bookingState(READY_TO_CONFIRM) }));
    const asked = await turn(
      [{ kind: "ask_clarification", reason: "unspecified_correction" }],
      context({ flows: offered.state }),
    );
    const text = reply(asked.effects);
    expect(text).toContain("تقصد تعدّل إيه");
    // Only the fields this frame actually holds, named in the patient's
    // language — never a canonical slot name.
    expect(text).toContain("الدكتور");
    expect(text).toContain("اليوم");
    expect(text).not.toContain("doctor");
  });

  it("preserves the frame and writes nothing while it asks", async () => {
    const offered = await turn([], context({ flows: bookingState(READY_TO_CONFIRM) }));
    const asked = await turn(
      [{ kind: "ask_clarification", reason: "unspecified_correction" }],
      context({ flows: offered.state }),
    );
    const frame = asked.state.stack[0]!;
    expect(frame.flow).toBe("book_appointment");
    expect(frame.slots.doctor?.value).toBe("doc-youssef");
    expect(frame.slots.time?.value).toBe("11:15");
    expect(stubs.commitBooking).not.toHaveBeenCalled();
    expect(asked.effects.some((effect) => effect.kind === "handoff")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. A staged file continues the booking
// ---------------------------------------------------------------------------

describe("a newly staged patient", () => {
  it("carries an anonymous sender's booking through to the summary", async () => {
    const staged = bookingState(READY_TO_CONFIRM, {
      booking_patient_known: false,
      intake_staged: true,
    });
    const result = await turn([], context({ flows: staged, identity: "anonymous" }));
    const text = reply(result.effects);
    // The dead end: `confirm` required a linkage that staging cannot create, so
    // this turn used to answer with an identity challenge and stop.
    expect(text).not.toContain("نتأكد من هويتك");
    expect(text).toContain("تحب تأكد الطلب؟");
    expect(stubs.commitBooking).not.toHaveBeenCalled();
  });

  it("does not re-ask for the department or the doctor it already holds", async () => {
    const staged = bookingState(READY_TO_CONFIRM, {
      booking_patient_known: false,
      intake_staged: true,
    });
    await turn([], context({ flows: staged, identity: "anonymous" }));
    // The department and doctor are committed slots on the frame, so the
    // continuation never re-reads the directory and never re-offers them.
    expect(stubs.readDepartments).not.toHaveBeenCalled();
    expect(stubs.readDoctors).not.toHaveBeenCalled();
  });

  it("still refuses a booking with no patient behind it at all", async () => {
    const orphaned = bookingState(READY_TO_CONFIRM, {
      booking_patient_known: false,
      confirmed: true,
    });
    const result = await turn([], context({ flows: orphaned, identity: "anonymous" }));
    expect(stubs.commitBooking).not.toHaveBeenCalled();
    expect(result.effects.some((effect) => effect.kind === "handoff")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Side questions during a booking
// ---------------------------------------------------------------------------

describe("an informational detour mid-booking", () => {
  /** A booking parked on the day step: department and doctor committed. */
  function awaitingDay(): FlowState {
    return {
      ...EMPTY_FLOW_STATE,
      stack: [
        {
          ...newFrame({ flow: "book_appointment", at: AT }),
          slots: {
            beneficiary: {
              value: "self",
              label: "ليك إنت",
              provenance: "affirmed",
              at: AT,
            },
            department: {
              value: "dept-physio",
              label: "العلاج الطبيعي",
              provenance: "affirmed",
              at: AT,
            },
            doctor: {
              value: "doc-youssef",
              label: "د. يوسف عادل",
              provenance: "affirmed",
              at: AT,
            },
          },
        },
      ],
    };
  }

  it.each([
    ["insurance", "أكسا"],
    ["packages", "باكيدج التأهيل"],
  ] as const)("answers a %s question and returns to the same step", async (topic, expected) => {
    const result = await turn(
      [{ kind: "suspend_flow" }, ask(topic)],
      context({ flows: awaitingDay() }),
    );
    const text = reply(result.effects);
    expect(text).toContain(expected);
    // …and the booking's own question is asked again in the same message, so
    // the patient never has to say «عايز أكمل الحجز».
    expect(text).toContain("الجمعة — 18-09-2026");
  });

  it("does not touch a single booking slot", async () => {
    const before = awaitingDay().stack[0]!.slots;
    const result = await turn(
      [{ kind: "suspend_flow" }, ask("insurance", "AXA")],
      context({ flows: awaitingDay() }),
    );
    const booking = result.state.stack.find((frame) => frame.flow === "book_appointment")!;
    expect(booking.slots).toEqual(before);
    expect(stubs.commitBooking).not.toHaveBeenCalled();
  });

  it("leaves no informational frame behind", async () => {
    const result = await turn(
      [{ kind: "suspend_flow" }, ask("packages")],
      context({ flows: awaitingDay() }),
    );
    // A leftover `answer_question` frame reports itself to the next turn as the
    // ACTIVE FLOW and offers its `collects` slots to values meant for the
    // booking — the zombie-frame defect the compound-question work fixed.
    expect(result.state.stack.filter((frame) => frame.flow === "answer_question")).toEqual(
      [],
    );
    expect(result.state.stack.map((frame) => frame.flow)).toEqual(["book_appointment"]);
  });
});
