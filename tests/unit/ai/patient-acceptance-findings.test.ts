import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { detectPatientEscalation } from "@/lib/ai/patient-escalation";
import { detectConversationClosure } from "@/lib/ai/conversation-closure";
import { resolveConversationLifecycle } from "@/lib/ai/conversation-lifecycle";
import {
  bookingAuthorityInstruction,
  resolveBookingAuthority,
  shouldForceAuthority,
  type BookingAuthorityFacts,
} from "@/lib/ai/booking-authority";
import { isClinicInformationQuestion } from "@/lib/ai/clinic-information-intent";
import {
  EMPTY_BOOKING_STAGE_STATE,
  candidateClockTimes,
  parseBookingStageState,
  recordOfferedDays,
  recordOfferedSlots,
  resolveOrdinalOfferedDay,
  serializeBookingStageState,
  type BookingStageState,
} from "@/lib/ai/booking-stage";
import { resolveOfferedSelection } from "@/lib/ai/offered-selection";
import {
  checkCommercialGrounding,
  hasInsuranceAcceptanceClaim,
  quotedPrices,
} from "@/lib/ai/patient-commercial-grounding";
import { createGroundingLedger } from "@/lib/ai/patient-grounding";
import {
  enforcePatientWriteReply,
  hasPatientWriteSuccessClaim,
} from "@/lib/ai/patient-write-commit";
import { enforcePatientClarificationReply } from "@/lib/ai/patient-clarification-reply";

/**
 * The eight findings of the 2026-08-30 production acceptance pass
 * (`docs/reviews/PATIENT_ASSISTANT_PRODUCTION_ACCEPTANCE.md`), one describe
 * block each, asserted at the level the fix actually lives at.
 *
 * These are deliberately *unit* tests over pure functions rather than another
 * pass of the acceptance matrix. The matrix proves the findings are closed end
 * to end and is rerun in CI by `tests/unit/ai/acceptance`; what a fix needs on
 * top of that is a test that names the exact input that used to be wrong, so a
 * future edit that reintroduces it fails with the reproduction in the message
 * rather than with a scenario id.
 */

const AHMED_NABIL = { id: "bbbbbbbb-0000-4000-8000-000000000001", name: "Ahmed Nabil" };
const AHMED_MOSTAFA = { id: "bbbbbbbb-0000-4000-8000-000000000002", name: "Ahmed Mostafa" };
const SARA_ALI = { id: "bbbbbbbb-0000-4000-8000-000000000003", name: "Sara Ali" };
const ROSTER = [AHMED_NABIL, AHMED_MOSTAFA, SARA_ALI];

function facts(overrides: Partial<BookingAuthorityFacts> = {}): BookingAuthorityFacts {
  return {
    step: "department",
    collected: {},
    offeredDoctorIds: [],
    offeredDays: [],
    offeredSlots: [],
    closing: false,
    terminal: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// F-1 — services, prices and insurers are tool-grounded, exactly like doctors
// ---------------------------------------------------------------------------

describe("F-1 · a price or an insurer may only come from a server receipt", () => {
  const adversarial =
    "Botox Package بـ2499 جنيه، وباقة التقشير بـ777 جنيه. وطبعًا بنقبل Bupa Global.";

  it("reads the numbers the reply is quoting as money", () => {
    expect(quotedPrices(adversarial).sort((a, b) => a - b)).toEqual([777, 2499]);
    expect(quotedPrices("الكشف 400 جنيه")).toEqual([400]);
    expect(quotedPrices("The consultation is EGP 400")).toEqual([400]);
    expect(quotedPrices("السعر 1200")).toEqual([1200]);
  });

  it("does not read a date, a clock time, a phone number or a year as a price", () => {
    expect(quotedPrices("موعدك يوم 2026-09-07 الساعة 10:00")).toEqual([]);
    expect(quotedPrices("اتصل على +20 2 1234 5678")).toEqual([]);
    expect(quotedPrices("Your appointment on 2026-09-07 at 10:30 is pending")).toEqual([]);
    expect(quotedPrices("إحنا فاتحين من 09:00 لـ17:00")).toEqual([]);
  });

  it("reads an acceptance assertion, and does not read a deferral as one", () => {
    expect(hasInsuranceAcceptanceClaim("وطبعًا بنقبل Bupa Global")).toBe(true);
    expect(hasInsuranceAcceptanceClaim("Yes, the clinic accepts AXA")).toBe(true);
    expect(hasInsuranceAcceptanceClaim("That insurer is not accepted")).toBe(true);
    expect(
      hasInsuranceAcceptanceClaim("تقدر تتواصل مع العيادة لتأكيد تفاصيل التأمين"),
    ).toBe(false);
    expect(hasInsuranceAcceptanceClaim("تحب أشوفلك شركات التأمين المسجلة؟")).toBe(false);
  });

  it("refuses the reported reply: no services receipt, no insurance receipt", () => {
    const check = checkCommercialGrounding({
      text: adversarial,
      allowedPrices: [],
      sawServices: false,
      sawInsurers: false,
    });
    expect(check.grounded).toBe(false);
    expect(check.violations.map((v) => v.source).sort()).toEqual([
      "unbacked_insurer",
      "unbacked_price",
      "unbacked_price",
    ]);
  });

  it("allows a price the receipt actually contained, and refuses one it did not", () => {
    expect(
      checkCommercialGrounding({
        text: "الكشف في الجلدية بـ400 جنيه.",
        allowedPrices: [400, 1200],
        sawServices: true,
        sawInsurers: false,
      }).grounded,
    ).toBe(true);
    const drifted = checkCommercialGrounding({
      text: "الكشف في الجلدية بـ450 جنيه.",
      allowedPrices: [400, 1200],
      sawServices: true,
      sawInsurers: false,
    });
    expect(drifted.grounded).toBe(false);
    expect(drifted.violations[0]!.source).toBe("unlisted_price");
  });

  it("the ledger records prices and insurers the server returned", () => {
    const ledger = createGroundingLedger();
    expect(ledger.sawServices()).toBe(false);
    expect(ledger.sawInsurers()).toBe(false);
    ledger.record("list_department_services", {
      found: true,
      department: { id: "d1", name: "Dermatology" },
      services: [
        { name: "Dermatology Consultation", price: 400, currency: "EGP" },
        { name: "Laser Session", price: 1200, currency: "EGP" },
      ],
    });
    ledger.record("list_clinic_insurance", {
      providers: [{ id: "i1", name: "AXA" }, { id: "i2", name: "MetLife" }],
    });
    expect([...ledger.prices()].sort((a, b) => a - b)).toEqual([400, 1200]);
    expect(ledger.names("service")).toContain("Laser Session");
    expect(ledger.names("insurer")).toEqual(["AXA", "MetLife"]);
    expect(ledger.sawServices()).toBe(true);
    expect(ledger.sawInsurers()).toBe(true);
    // The doctor world is untouched by any of it.
    expect(ledger.names("doctor")).toEqual([]);
  });

  it("a booking receipt and the clinic's own contact details are not commercial claims", () => {
    expect(
      checkCommercialGrounding({
        text:
          "تمام، تم إرسال طلب الحجز مع د. Ahmed Nabil في Dermatology يوم 2026-09-07 " +
          "الساعة 10:00. الطلب حاليًا قيد التأكيد.",
        allowedPrices: [],
        sawServices: false,
        sawInsurers: false,
      }).grounded,
    ).toBe(true);
    expect(
      checkCommercialGrounding({
        text: "مواعيد العمل من 09:00 لـ17:00. التليفون +20 2 1234 5678.",
        allowedPrices: [],
        sawServices: false,
        sawInsurers: false,
      }).grounded,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F-2 — an ambiguous answer produces a server-owned clarification
// ---------------------------------------------------------------------------

describe("F-2 · ambiguity is preserved, asked about, and continued from", () => {
  const state: BookingStageState = {
    ...EMPTY_BOOKING_STAGE_STATE,
    offeredDoctorIds: ROSTER.map((d) => d.id),
  };

  it.each(["دكتور احم", "عايز احجز مع دكتور احم", "أحمد", "I want doctor Ahm"])(
    "reads %s as ambiguous rather than committing or discarding it",
    (text) => {
      const outcome = resolveOfferedSelection({
        step: "doctor",
        patientText: text,
        state,
        offeredDoctors: ROSTER,
        appointmentDate: null,
      });
      expect(outcome.status).toBe("ambiguous");
      if (outcome.status !== "ambiguous") return;
      expect(outcome.candidates.map((c) => c.name).sort()).toEqual([
        "Ahmed Mostafa",
        "Ahmed Nabil",
      ]);
    },
  );

  it("still commits an answer that is unique", () => {
    const outcome = resolveOfferedSelection({
      step: "doctor",
      patientText: "سار",
      state,
      offeredDoctors: ROSTER,
      appointmentDate: null,
    });
    expect(outcome).toEqual({ status: "doctor", doctor: SARA_ALI });
  });

  it("carries the pending question across a persistence round trip", () => {
    const withPending: BookingStageState = {
      ...state,
      pendingSelection: { field: "doctor", candidates: [AHMED_NABIL, AHMED_MOSTAFA] },
    };
    const round = parseBookingStageState(serializeBookingStageState(withPending));
    expect(round.pendingSelection).toEqual({
      field: "doctor",
      candidates: [AHMED_NABIL, AHMED_MOSTAFA],
    });
    // A single candidate is not an ambiguity and must not survive parsing.
    expect(
      parseBookingStageState({ pendingSelection: { field: "doctor", candidates: [AHMED_NABIL] } })
        .pendingSelection,
    ).toBeNull();
  });

  it("the authority stops claiming the roster step is satisfied", () => {
    const pending = facts({
      step: "doctor",
      offeredDoctorIds: ROSTER.map((d) => d.id),
      pendingSelection: { field: "doctor", candidates: [AHMED_NABIL, AHMED_MOSTAFA] },
    });
    const authority = resolveBookingAuthority(pending);
    expect(authority.reason).toBe("needs_clarification");
    expect(authority.satisfied).toBe(false);
    expect(authority.clarificationCandidates).toHaveLength(2);
    // Nothing is pinned: the tool would re-state the whole roster, not the two
    // competing readings.
    expect(
      shouldForceAuthority({ authority, mountedTools: ["list_doctors"], stepNumber: 0 }),
    ).toBe(false);
    // And the instruction no longer tells the model the step is settled.
    for (const locale of ["ar", "en"] as const) {
      const line = bookingAuthorityInstruction(locale, authority)!;
      expect(line).toContain("Ahmed Nabil");
      expect(line).toContain("Ahmed Mostafa");
    }
    expect(bookingAuthorityInstruction("en", authority)).not.toMatch(
      /do not call that booking tool again/i,
    );
  });

  it("composes the question deterministically, naming both readings", () => {
    for (const locale of ["ar", "en"] as const) {
      const enforced = enforcePatientClarificationReply({
        locale,
        text: "أهلًا بيك في العيادة. تحب أساعدك في إيه النهاردة؟",
        authority: resolveBookingAuthority(
          facts({
            step: "doctor",
            offeredDoctorIds: ROSTER.map((d) => d.id),
            pendingSelection: {
              field: "doctor",
              candidates: [AHMED_NABIL, AHMED_MOSTAFA],
            },
          }),
        ),
      });
      expect(enforced.outcome).toBe("clarified");
      expect(enforced.text).toMatch(/[?؟]/);
      expect(enforced.text).toContain("Ahmed Nabil");
      expect(enforced.text).toContain("Ahmed Mostafa");
      // It can only ever name what was offered.
      expect(enforced.text).not.toContain("Sara Ali");
    }
  });

  it("continues from the same rung after the clarification, never restarting", () => {
    const pendingState: BookingStageState = {
      ...state,
      pendingSelection: { field: "doctor", candidates: [AHMED_NABIL, AHMED_MOSTAFA] },
    };
    // The name.
    expect(
      resolveOfferedSelection({
        step: "doctor",
        patientText: "احمد نبيل",
        state: pendingState,
        offeredDoctors: ROSTER,
        appointmentDate: null,
      }),
    ).toEqual({ status: "doctor", doctor: AHMED_NABIL });
    // And the ordinal, which belongs to the two names just read — not to the
    // whole roster, where "الأول" would be Ahmed Nabil by coincidence and
    // "التاني" would be the wrong person.
    expect(
      resolveOfferedSelection({
        step: "doctor",
        patientText: "التاني",
        state: pendingState,
        offeredDoctors: ROSTER,
        appointmentDate: null,
      }),
    ).toEqual({ status: "doctor", doctor: AHMED_MOSTAFA });
  });

  it("leaves an ordinary reply alone", () => {
    expect(
      enforcePatientClarificationReply({
        locale: "ar",
        text: "الأيام المتاحة: ...",
        authority: resolveBookingAuthority(facts({ step: "day", offeredDays: ["2026-09-07"] })),
      }).outcome,
    ).toBe("passthrough");
  });
});

// ---------------------------------------------------------------------------
// F-3 — an acknowledgement mid-flow is not a goodbye
// ---------------------------------------------------------------------------

describe("F-3 · closing is context-aware", () => {
  const ACKS = ["تمام", "ماشي", "حاضر", "تمام كده", "ok", "okay", "طيب"];

  it.each(ACKS)("does not read %s as closing while work is outstanding", (text) => {
    expect(detectConversationClosure(text, { outstandingWork: true }).isClosing).toBe(false);
  });

  it.each(ACKS)("still reads %s as closing when nothing is outstanding", (text) => {
    expect(detectConversationClosure(text).isClosing).toBe(true);
    expect(detectConversationClosure(text, { outstandingWork: false }).isClosing).toBe(true);
  });

  it.each([
    "تمام شكرا",
    "شكرا",
    "مع السلامة",
    "ok thanks",
    "thanks, bye",
    "bye",
    "الله يعطيك العافية",
  ])("keeps %s a closing in any context — gratitude and farewell say more than an ack", (text) => {
    expect(detectConversationClosure(text, { outstandingWork: true }).isClosing).toBe(true);
  });

  it("keeps the acknowledgement turn's booking authority", () => {
    // The reproduction: "تمام" answering «تحب أشوف المواعيد المتاحة معاه؟» with
    // the doctor already committed. Read as a closing, the turn was stripped of
    // its authority and the booking stalled where it stood.
    const closing = detectConversationClosure("تمام", { outstandingWork: true }).isClosing;
    const authority = resolveBookingAuthority(
      facts({ step: "day", collected: { doctor_id: "d" }, closing }),
    );
    expect(authority.reason).toBe("needs_days");
    expect(authority.operation).toBe("list_available_days");
  });

  it("does not close and wipe the episode on a bare acknowledgement mid-booking", () => {
    expect(
      resolveConversationLifecycle({
        locale: "ar",
        latestPatientText: "تمام",
        lastAssistantText: "تحب أشوف المواعيد المتاحة معاه؟",
        replyText: "الأيام المتاحة: ...",
        outstanding: true,
        goalCompleted: false,
      }),
    ).toMatchObject({ kind: "continue", reason: "outstanding_work" });
  });
});

// ---------------------------------------------------------------------------
// F-4 — a clinic-information question is not a booking
// ---------------------------------------------------------------------------

describe("F-4 · a pure FAQ is not force-pinned into prepare_booking", () => {
  it.each([
    "بتفتحوا امتى؟",
    "مواعيدكم ايه؟",
    "what are your hours?",
    "what time do you open?",
    "العنوان فين؟",
    "الجلدية بكام؟",
    "بتقبلوا تأمين؟",
    "do you have parking?",
  ])("reads %s as a clinic-information question", (text) => {
    expect(isClinicInformationQuestion(text)).toBe(true);
  });

  it.each([
    "عايز احجز",
    "عايز احجز في الجلدية",
    "الجلدية",
    "سارة علي",
    "عايز اعرف سعر الكشف وأحجز",
    "I want to book an appointment",
    "امتى الدكتور متاح؟",
    "عايز الغي موعدي",
  ])("does not read %s as a pure information question", (text) => {
    expect(isClinicInformationQuestion(text)).toBe(false);
  });

  it("withholds the department pin on a thread that is not booking", () => {
    const authority = resolveBookingAuthority(
      facts({ step: "department", clinicInformationQuery: true, bookingIntent: false }),
    );
    expect(authority.requirement).toBe("none");
    expect(authority.reason).toBe("conversational");
    expect(
      shouldForceAuthority({ authority, mountedTools: ["prepare_booking"], stepNumber: 0 }),
    ).toBe(false);
    expect(bookingAuthorityInstruction("ar", authority)).toBeNull();
  });

  it("keeps the pin once the thread really is booking, question or not", () => {
    // V2-CONTAINMENT — the second case here used to be
    // `{ clinicInformationQuery: false, bookingIntent: false }`, and it was the
    // bug written down as a requirement: "we could not prove this is a
    // question, and this thread is not booking, therefore pin the opening move
    // of a booking". That is the default «عندي استفسار» fell through. The pin
    // now needs positive evidence, so the case that keeps it is a turn that
    // actually asked to book.
    for (const overrides of [
      { clinicInformationQuery: true, bookingIntent: true },
      { clinicInformationQuery: false, bookingOpening: true },
    ]) {
      const authority = resolveBookingAuthority(facts({ step: "department", ...overrides }));
      expect(authority.operation).toBe("prepare_booking");
      expect(
        shouldForceAuthority({ authority, mountedTools: ["prepare_booking"], stepNumber: 0 }),
      ).toBe(true);
    }
  });

  it("V2-CONTAINMENT — an unrecognised turn is conversational, never a booking", () => {
    // The live failure, at the layer that produced it. «عندي استفسار» matches
    // no topic pattern, so it proves neither that it is a question nor that it
    // is a booking. Under the old default that ambiguity pinned
    // `prepare_booking`; it must now pin nothing at all.
    const authority = resolveBookingAuthority(
      facts({
        step: "department",
        clinicInformationQuery: false,
        bookingIntent: false,
        bookingOpening: false,
      }),
    );
    expect(authority.requirement).toBe("none");
    expect(authority.operation).toBeNull();
    expect(authority.reason).toBe("conversational");
    expect(
      shouldForceAuthority({ authority, mountedTools: ["prepare_booking"], stepNumber: 0 }),
    ).toBe(false);
  });

  it("lets a thread that only asked a question reach an ending", () => {
    // With no booking tool forced, nothing marks the thread engaged, so nothing
    // is outstanding and the goodbye closes it.
    expect(
      resolveConversationLifecycle({
        locale: "ar",
        latestPatientText: "شكرا، مع السلامة",
        lastAssistantText: "إحنا فاتحين من ٩ لـ٥.",
        replyText: "",
        outstanding: false,
        goalCompleted: false,
      }),
    ).toMatchObject({ kind: "close", reason: "closing_message" });
  });
});

// ---------------------------------------------------------------------------
// F-5 — explicit requests for a human
// ---------------------------------------------------------------------------

describe("F-5 · an explicit request for a person is escalated before the model runs", () => {
  it.each([
    "وصلني بحد من العيادة",
    "وصلني بحد",
    "حولني لحد",
    "حولني لموظف",
    "وصلني بالاستقبال",
    "عايز اكلم موظف",
    "عايز حد يرد عليا",
    "I want to speak to a human",
    "connect me to someone from the clinic",
    "put me through to reception",
    "transfer me to a person",
  ])("escalates %s", (text) => {
    expect(detectPatientEscalation(text)).toEqual({
      escalate: true,
      reason: "human_requested",
      emergency: false,
    });
  });

  it.each([
    "عايز احجز لابني علاج طبيعي",
    "عايز احجز لشخص تاني",
    "عايز احجز في الجلدية",
    "اتحدث عن موعد محدد",
    "بتفتحوا امتى؟",
    "عايز موعد واحد بس",
    "get me an appointment with someone",
  ])("does not escalate %s", (text) => {
    expect(
      detectPatientEscalation(text, {
        clinicDepartmentNames: ["Physical Therapy", "علاج طبيعي", "الجلدية"],
      }).escalate,
    ).toBe(false);
  });

  it("keeps the priority order: an emergency still outranks a handoff request", () => {
    expect(detectPatientEscalation("وصلني بحد، عندي نزيف شديد")).toMatchObject({
      reason: "emergency",
      emergency: true,
    });
  });
});

// ---------------------------------------------------------------------------
// F-6 — ordinals, spelled-out hours, and the re-offer that replaces silence
// ---------------------------------------------------------------------------

describe("F-6 · the offered pre-commit reads ordinals and spoken hours", () => {
  const days = ["2026-09-07", "2026-09-08", "2026-09-10"];
  const dayState = recordOfferedDays(EMPTY_BOOKING_STAGE_STATE, days);
  const slotState = recordOfferedSlots(dayState, "2026-09-07", ["10:00", "10:30", "11:00"]);

  it.each([
    ["أول يوم متاح", "2026-09-07"],
    ["اول يوم", "2026-09-07"],
    ["الأول", "2026-09-07"],
    ["the first available day", "2026-09-07"],
    ["التاني", "2026-09-08"],
    ["the third day", "2026-09-10"],
  ])("resolves %s to %s", (text, expected) => {
    expect(resolveOrdinalOfferedDay(dayState, text)).toBe(expected);
  });

  it("does not clamp an ordinal past the end of the offered list", () => {
    expect(resolveOrdinalOfferedDay(dayState, "الرابع")).toBeNull();
  });

  it("still reads a bare day number, and prefers it over the ordinal reading", () => {
    expect(
      resolveOfferedSelection({
        step: "day",
        patientText: "٧",
        state: dayState,
        offeredDoctors: [],
        appointmentDate: null,
      }),
    ).toEqual({ status: "day", date: "2026-09-07" });
  });

  it.each([
    ["الساعة عشرة", ["10:00", "22:00"]],
    ["عشرة", ["10:00", "22:00"]],
    ["الساعة تسعة الصبح", ["09:00"]],
    ["الساعة اتنين بالليل", ["14:00"]],
    ["ten", ["10:00", "22:00"]],
  ])("reads the spoken hour in %s", (text, expected) => {
    expect(candidateClockTimes(text)).toEqual(expected);
  });

  it("keeps the digit reading exactly as it was", () => {
    // A bare hour still yields both readings; it is the offered-slot list, not
    // this function, that decides which one the patient meant.
    expect(candidateClockTimes("١٠:٠٠")).toEqual(["10:00", "22:00"]);
    expect(candidateClockTimes("الساعة ٩ الصبح")).toEqual(["09:00"]);
    expect(candidateClockTimes("")).toEqual([]);
  });

  it("commits the spoken hour against the slots that were offered", () => {
    expect(
      resolveOfferedSelection({
        step: "time",
        patientText: "الساعة عشرة",
        state: slotState,
        offeredDoctors: [],
        appointmentDate: "2026-09-07",
      }),
    ).toEqual({ status: "time", time: "10:00" });
  });

  it("re-offers instead of going silent when the answer resolved nothing", () => {
    const unreadable = resolveOfferedSelection({
      step: "day",
      patientText: "يمكن الاسبوع الجاي",
      state: dayState,
      offeredDoctors: [],
      appointmentDate: null,
    });
    expect(unreadable.status).toBe("unresolved");
    const authority = resolveBookingAuthority(
      facts({ step: "day", offeredDays: days, unresolvedAnswer: true }),
    );
    expect(authority.requirement).toBe("read_authority");
    expect(authority.reason).toBe("reoffer");
    expect(authority.satisfied).toBe(false);
    expect(
      shouldForceAuthority({
        authority,
        mountedTools: ["list_available_days"],
        stepNumber: 0,
      }),
    ).toBe(true);
    expect(bookingAuthorityInstruction("en", authority)).toMatch(/again/i);
  });

  it("leaves a satisfied step satisfied when the answer was readable", () => {
    const authority = resolveBookingAuthority(
      facts({ step: "day", offeredDays: days, unresolvedAnswer: false }),
    );
    expect(authority.reason).toBe("committed_days");
    expect(authority.satisfied).toBe(true);
  });

  it("reads a day correction at the time rung as a day, not as an hour", () => {
    // "لا قصدي يوم ١٠" used to commit 10:00 on the day the patient had just
    // rejected, which put the ladder on `confirm` and booked it.
    for (const text of ["لا قصدي يوم ١٠", "no sorry, the 10th"]) {
      expect(
        resolveOfferedSelection({
          step: "time",
          patientText: text,
          state: recordOfferedSlots(dayState, "2026-09-08", ["10:00", "11:00"]),
          offeredDoctors: [],
          appointmentDate: "2026-09-08",
        }),
      ).toEqual({ status: "day", date: "2026-09-10" });
    }
  });

  it("still reads a plain time answer as a time", () => {
    expect(
      resolveOfferedSelection({
        step: "time",
        patientText: "١٠:٠٠",
        state: slotState,
        offeredDoctors: [],
        appointmentDate: "2026-09-07",
      }),
    ).toEqual({ status: "time", time: "10:00" });
  });
});

// ---------------------------------------------------------------------------
// F-7 / F-8 — the write-claim detector and its replacement copy
// ---------------------------------------------------------------------------

describe("F-7 · the write-claim detector reads negation", () => {
  it.each([
    "لسه ما تمّش إنشاء ملف مريض أو طلب حجز في النظام.",
    "لم يتم إنشاء طلب الموعد.",
    "No patient file has been created yet.",
    "The appointment request was not created because that time is no longer available.",
    "تعذّر إنشاء طلب الموعد في النظام، لذلك الموعد غير محجوز.",
  ])("does not call %s a success claim", (text) => {
    expect(hasPatientWriteSuccessClaim(text)).toBe(false);
  });

  it.each([
    "تمام، تم إرسال طلب الحجز مع د. أحمد.",
    "تم إنشاء ملف المريض وتأكيد الحجز.",
    "I have created your appointment request.",
    "Your patient file has been created.",
  ])("still calls %s a success claim", (text) => {
    expect(hasPatientWriteSuccessClaim(text)).toBe(true);
  });

  it("scopes negation to the sentence it sits in", () => {
    expect(
      hasPatientWriteSuccessClaim("لم يتم إنشاء طلب الموعد. تم حفظ ملف المريض."),
    ).toBe(true);
  });
});

describe("F-8 · the unbacked-claim replacement restates the outstanding question", () => {
  const ledger = createGroundingLedger();

  it.each([
    ["department", /قسم/],
    ["doctor", /مين/],
    ["day", /يوم/],
    ["time", /معاد/],
    ["intake", /الملف/],
  ] as const)("ends on a question at the %s rung", (step, pattern) => {
    const enforced = enforcePatientWriteReply({
      locale: "ar",
      text: "تمام، تم إنشاء ملف المريض وتأكيد الحجز.",
      authority: {
        requirement: "none",
        operation: null,
        reason: "conversational",
        satisfied: false,
        step,
      },
      ledger,
    });
    expect(enforced.outcome).toBe("unbacked_claim");
    // Still a correction …
    expect(enforced.text).toContain("لسه ما تمّش");
    // … and no longer a dead end.
    expect(enforced.text).toMatch(/[?؟]/);
    expect(enforced.text).toMatch(pattern);
  });

  it("names no doctor, day, time or department it has not been given", () => {
    const enforced = enforcePatientWriteReply({
      locale: "en",
      text: "Done — your appointment has been booked.",
      authority: {
        requirement: "none",
        operation: null,
        reason: "conversational",
        satisfied: false,
        step: "day",
      },
      ledger,
    });
    expect(enforced.text).toMatch(/\?$/);
    expect(enforced.text).not.toMatch(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/);
  });

  it("leaves an honest reply alone", () => {
    expect(
      enforcePatientWriteReply({
        locale: "ar",
        text: "لم يتم إنشاء طلب الموعد بعد. تحب أشوف المواعيد المتاحة؟",
        authority: {
          requirement: "none",
          operation: null,
          reason: "conversational",
          satisfied: false,
          step: "day",
        },
        ledger,
      }).outcome,
    ).toBe("passthrough");
  });
});
