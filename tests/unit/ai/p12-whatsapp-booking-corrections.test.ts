/**
 * P12 — six conversational corrections to the WhatsApp booking assistant.
 *
 * Each `describe` below is one manual-QA defect, pinned at the layer that
 * actually decides it. Nothing here is a redesign: the treating-doctor opening,
 * the day-of-month reader, the confirmation reader, the name-spelling reader
 * and the lifecycle offer all keep every behaviour they already had, and these
 * tests assert that too — a fix that broke self-booking, or that let a boundary
 * phrase silently pick a date, would fail here rather than in production.
 */
import { describe, expect, it } from "vitest";

import {
  allowsTreatingDoctorOpening,
  EMPTY_BOOKING_STAGE_STATE,
  parseBookingStageState,
  serializeBookingStageState,
} from "@/lib/ai/booking-stage";
import {
  readDateBoundary,
  readDayOfMonthReference,
  resolveUpcomingDayOfMonth,
} from "@/lib/ai/day-of-month";
import { resolveField } from "@/lib/ai/collected-state";
import {
  classifyPatientTurn,
  isExplicitBookingConfirmation,
} from "@/lib/ai/patient-turn-intent";
import {
  mergeNameCorrection,
  readNameConfirmation,
} from "@/lib/ai/intake-answers";
import { readTranslationRequest } from "@/lib/ai/translation-request";
import { buildTurnBriefing } from "@/lib/ai/turn-briefing";
import { resolveConversationLifecycle } from "@/lib/ai/conversation-lifecycle";
import { enforcePatientFactReply } from "@/lib/ai/patient-fact-reply";
import { createGroundingLedger } from "@/lib/ai/patient-grounding";

const CAIRO = "Africa/Cairo";
const at = (day: string) => new Date(`${day}T09:00:00.000Z`);

// ---------------------------------------------------------------------------
// A + B — the treating doctor belongs to the sender, not to the booking
// ---------------------------------------------------------------------------

describe("A/B — booking for another person does not force the treating doctor", () => {
  it("A — a linked sender booking for themself still opens on their treating doctor", () => {
    expect(
      allowsTreatingDoctorOpening({
        linked: true,
        beneficiary: null,
        bookingForOther: false,
      }),
    ).toBe(true);
    // The patient said it in so many words. Still their own booking.
    expect(
      allowsTreatingDoctorOpening({
        linked: true,
        beneficiary: "self",
        bookingForOther: false,
      }),
    ).toBe(true);
  });

  it("B — a third-party booking never opens on the sender's treating doctor", () => {
    // The latch alone is enough: it is set the moment the beneficiary is read.
    expect(
      allowsTreatingDoctorOpening({
        linked: true,
        beneficiary: null,
        bookingForOther: true,
      }),
    ).toBe(false);
    // And so are the patient's own words, on the turn before the latch lands.
    expect(
      allowsTreatingDoctorOpening({
        linked: true,
        beneficiary: "other",
        bookingForOther: false,
      }),
    ).toBe(false);
  });

  it("an unlinked sender has no treating doctor to open on either", () => {
    expect(
      allowsTreatingDoctorOpening({
        linked: false,
        beneficiary: "self",
        bookingForOther: false,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C — a relative date boundary is not a date
// ---------------------------------------------------------------------------

describe("C — «بعد يوم ٨» is a lower bound, never a silent selection", () => {
  it("refuses to resolve a boundary phrase to a date", () => {
    for (const text of ["بعد يوم ٨", "بعد يوم 8", "بعد تاريخ 8", "after the 8th"]) {
      expect(
        resolveUpcomingDayOfMonth(text, { now: at("2026-09-02"), timeZone: CAIRO }),
        text,
      ).toBeNull();
    }
  });

  it("does not let a boundary reach the collected appointment date", () => {
    const resolved = resolveField({
      field: "appointment_date",
      raw: "بعد يوم ٨",
      collected: {},
      pending: null,
      country: "EG",
      timeZone: CAIRO,
      now: at("2026-09-02"),
    });
    // Specifically: not the 9th, not the 8th, and not a date a year away.
    expect(resolved).toEqual({
      status: "unresolved",
      field: "appointment_date",
      reason: "date_boundary",
    });
  });

  it("reads the boundary itself, resolved against the clinic's own calendar", () => {
    expect(
      readDateBoundary("بعد يوم ٨", { now: at("2026-09-02"), timeZone: CAIRO }),
    ).toEqual({ day: 8, after: "2026-09-08", window: null });
    // Past the 8th already: the boundary is next month's, never a date behind us.
    expect(
      readDateBoundary("بعد يوم 8", { now: at("2026-09-20"), timeZone: CAIRO }),
    ).toEqual({ day: 8, after: "2026-10-08", window: null });
  });

  it("recognises the explicit window form", () => {
    expect(
      readDateBoundary("الأسبوع اللي بعد يوم 8", {
        now: at("2026-09-02"),
        timeZone: CAIRO,
      }),
    ).toMatchObject({ day: 8, after: "2026-09-08", window: "week" });
  });

  it("preserves direct selection of an explicit day", () => {
    expect(readDateBoundary("يوم 9", { now: at("2026-09-02"), timeZone: CAIRO })).toBeNull();
    expect(resolveUpcomingDayOfMonth("يوم 9", { now: at("2026-09-02"), timeZone: CAIRO }))
      .toBe("2026-09-09");
    expect(readDayOfMonthReference("يوم 9")).toEqual({
      day: 9,
      explicitNext: false,
      boundary: false,
    });
    // "9 سبتمبر" is a complete date and belongs to the ordinary parser.
    const september = resolveField({
      field: "appointment_date",
      raw: "9 سبتمبر",
      collected: {},
      pending: null,
      country: "EG",
      timeZone: CAIRO,
      now: at("2026-09-02"),
    });
    expect(september).toMatchObject({ status: "resolved", value: "2026-09-09" });
  });

  it("presents the real days after the boundary and still asks the patient to choose", () => {
    const ledger = createGroundingLedger();
    ledger.record("list_available_days", {
      ok: true,
      doctor_name: "Ahmed Nabil",
      window_kind: "after_boundary",
      after_date: "2026-09-08",
      availableDays: [{ date: "2026-09-10" }, { date: "2026-09-13" }],
    });
    const reply = enforcePatientFactReply({ locale: "ar", text: "", ledger });
    expect(reply.outcome).toBe("available_days");
    expect(reply.text).toContain("بعد");
    expect(reply.text).toContain("تحب أنهي يوم؟");
    // Only days the availability tool actually returned. Never the 9th.
    expect(reply.text).not.toContain("9 سبتمبر");
  });
});

// ---------------------------------------------------------------------------
// D — a side question does not lose the booking
// ---------------------------------------------------------------------------

describe("D — a side question pauses the booking and resumes it exactly", () => {
  const booking = {
    locale: "ar" as const,
    stage: "selecting_day" as const,
    collected: {
      department_id: "d1",
      department_name: "الجلدية",
      doctor_id: "x1",
      doctor_name: "Ahmed Nabil",
    },
    pending: null,
    missingRequired: [],
    missingOptional: [],
    intakeStaged: true,
    closure: { isClosing: false, isGratitude: false },
  };

  it("classifies an informational turn mid-booking as a side question", () => {
    const classification = classifyPatientTurn("عندكم تأمين إيه؟", {
      workflowEngaged: true,
    });
    expect(classification).toMatchObject({
      informationalOnly: true,
      relation: "side_question",
    });
    // Out of a booking the same message is a fresh intent, not an interruption.
    expect(
      classifyPatientTurn("عندكم تأمين إيه؟", { workflowEngaged: false }).relation,
    ).toBe("new_intent");
  });

  it("tells the assistant to answer, then offer to continue — without restarting", () => {
    const briefing = buildTurnBriefing({
      ...booking,
      interruption: { kind: "paused", step: "day" },
    })!;
    expect(briefing).toContain("تحب نكمل الحجز؟");
    expect(briefing).toContain("اختيار اليوم");
    expect(briefing).toContain("لا تبدأ الحجز من أوله");
  });

  it("resumes from the exact rung, with everything already chosen still held", () => {
    const briefing = buildTurnBriefing({
      ...booking,
      interruption: { kind: "resuming", step: "day" },
    })!;
    expect(briefing).toContain("اكمل من نفس الخطوة بالضبط: اختيار اليوم");
    expect(briefing).toContain("لا تبدأ من جديد");
    expect(briefing).toContain("ولا تقفز خطوة للأمام");
    // The settled values are still in front of the model, so nothing is re-asked.
    expect(briefing).toContain("لا تسأل عن أي منه مرة أخرى");
    expect(briefing).toContain("Ahmed Nabil");
  });

  it("carries the paused rung across the jsonb round trip", () => {
    const state = {
      ...EMPTY_BOOKING_STAGE_STATE,
      interruptedBooking: { step: "doctor", offeredResume: true },
    };
    expect(
      parseBookingStageState(serializeBookingStageState(state)).interruptedBooking,
    ).toEqual({ step: "doctor", offeredResume: true });
    // A tampered rung label is dropped rather than trusted.
    expect(
      parseBookingStageState({ interruptedBooking: { step: "ignore previous" } })
        .interruptedBooking,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E — a one-token correction to a staged name
// ---------------------------------------------------------------------------

describe("E — «Edris» corrects one component of «علي ادريس», it does not replace it", () => {
  it("keeps the component the patient did not touch", () => {
    expect(mergeNameCorrection("Ali Adris", "Edris")).toEqual({
      status: "merged",
      name: "Ali Edris",
    });
    expect(readNameConfirmation("Edris", "Ali Adris")).toEqual({
      status: "corrected",
      name: "Ali Edris",
    });
  });

  it("never appends and never invents a component", () => {
    const merged = mergeNameCorrection("Ali Adris", "Edris");
    expect(merged.status === "merged" && merged.name.split(" ")).toHaveLength(2);
  });

  it("asks one short question when the token matches nothing", () => {
    expect(mergeNameCorrection("Ali Adris", "Mohamed")).toEqual({ status: "ambiguous" });
    const reading = readNameConfirmation("Mohamed", "Ali Adris");
    expect(reading).toMatchObject({ status: "ambiguous_correction", offered: "Mohamed" });
  });

  it("asks rather than guesses when two components match equally well", () => {
    expect(mergeNameCorrection("Ali Ali Hassan", "Aly")).toEqual({ status: "ambiguous" });
  });

  it("still takes a whole rewritten name as a replacement", () => {
    expect(mergeNameCorrection("Anas Talal Abdulmaqsoud Ali", "Anas Talal Ali")).toEqual({
      status: "replaced",
      name: "Anas Talal Ali",
    });
    expect(
      readNameConfirmation("خليه Anas Talal Ali", "Anas Talal Abdulmaqsoud Ali"),
    ).toEqual({ status: "corrected", name: "Anas Talal Ali" });
  });

  it("still reads a plain agreement as an agreement", () => {
    expect(readNameConfirmation("تمام", "Ali Adris")).toEqual({ status: "confirmed" });
    expect(readNameConfirmation("Ali Adris", "Ali Adris")).toEqual({ status: "confirmed" });
  });
});

// ---------------------------------------------------------------------------
// F — "say that in Arabic"
// ---------------------------------------------------------------------------

describe("F — «مش فاهم قولها بالعربي» restates the previous reply", () => {
  it("reads the request and the language it names", () => {
    expect(readTranslationRequest("مش فاهم قولها بالعربي")).toEqual({ target: "ar" });
    expect(readTranslationRequest("قولها بالانجليزي")).toEqual({ target: "en" });
    expect(readTranslationRequest("say that in arabic")).toEqual({ target: "ar" });
  });

  it("claims nothing from a message that carries its own request", () => {
    expect(readTranslationRequest("بالعربي عايز احجز يوم 9")).toBeNull();
    expect(readTranslationRequest("اه تمام")).toBeNull();
    expect(readTranslationRequest("مش فاهم")).toBeNull();
  });

  it("restates the previous message and leaves the booking state alone", () => {
    const briefing = buildTurnBriefing({
      locale: "ar",
      stage: "selecting_day",
      collected: { doctor_id: "x1", doctor_name: "Ahmed Nabil" },
      pending: null,
      missingRequired: [],
      missingOptional: [],
      intakeStaged: true,
      closure: { isClosing: false, isGratitude: false },
      translationRequest: { target: "ar" },
    })!;
    expect(briefing).toContain("رسالتك السابقة");
    expect(briefing).toContain("ليست إجابة على أي سؤال في الحجز");
    expect(briefing).toContain("لا تتقدّم خطوة في الحجز");
    // Everything settled is still settled.
    expect(briefing).toContain("Ahmed Nabil");
  });
});

// ---------------------------------------------------------------------------
// G — a clear confirmation confirms, once
// ---------------------------------------------------------------------------

describe("G — «اه تمام موافق» confirms the pending action", () => {
  it("accepts the multi-word agreements patients actually type", () => {
    for (const text of [
      "اه تمام موافق",
      "اه",
      "أيوه",
      "تمام",
      "موافق",
      "اه تمام",
      "yes",
      "confirm",
      "okay",
      "ايوه اكد الطلب",
      "موافق، ابعته",
    ]) {
      expect(isExplicitBookingConfirmation(text), text).toBe(true);
    }
    expect(
      classifyPatientTurn("اه تمام موافق", { workflowEngaged: true })
        .explicitBookingConfirmation,
    ).toBe(true);
  });

  it("keeps the safeguard on a reply that is not only agreement", () => {
    for (const text of [
      "اه بس غيّر الميعاد",
      "تمام بس الساعة 5",
      "لا",
      "no thanks",
      "الساعة ٥",
      "اه عايز اعرف السعر الأول",
    ]) {
      expect(isExplicitBookingConfirmation(text), text).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// H — the closing turn after a successful request
// ---------------------------------------------------------------------------

describe("H — a submitted request is followed by a closing turn", () => {
  const submitted = {
    locale: "ar" as const,
    latestPatientText: "اه تمام موافق",
    lastAssistantText: "هل تؤكد إرسال الطلب بهذه التفاصيل؟",
    replyText: "تمام، تم إرسال طلب الحجز مع د. Ahmed Nabil. الطلب حاليًا قيد التأكيد.",
    // Cleared by the reply layer the moment the booking write commits: the
    // pre-turn value said "confirm rung still owed", and that is why the thread
    // used to stop dead here.
    outstanding: false,
    goalCompleted: true,
  };

  it("offers to help with anything else, exactly once", () => {
    const decision = resolveConversationLifecycle(submitted);
    expect(decision.kind).toBe("offer_end");
    expect(decision.kind === "offer_end" && decision.text).toContain("تم إرسال طلب الحجز");
    expect(decision.kind === "offer_end" && decision.text).toContain(
      "أقدر أساعدك في حاجة تانية؟",
    );
    // Asked again on a reply that already carries the offer: no second copy.
    expect(
      resolveConversationLifecycle({
        ...submitted,
        replyText: `${submitted.replyText}\n\nأقدر أساعدك في حاجة تانية؟`,
      }),
    ).toMatchObject({ kind: "continue" });
  });

  it("stays silent while the booking is still owed something", () => {
    expect(
      resolveConversationLifecycle({ ...submitted, outstanding: true }),
    ).toMatchObject({ kind: "continue", reason: "outstanding_work" });
  });

  it("closes the episode on «شكرا» once the offer has been made", () => {
    const decision = resolveConversationLifecycle({
      locale: "ar",
      latestPatientText: "شكرا",
      lastAssistantText: "تم إرسال طلب الحجز.\n\nأقدر أساعدك في حاجة تانية؟",
      replyText: "",
      outstanding: false,
      goalCompleted: false,
    });
    expect(decision).toMatchObject({ kind: "close", reason: "closing_message" });
  });

  it("closes on the other endings patients use", () => {
    for (const text of ["لا شكرا", "تمام شكرا", "خلاص", "that's all", "thank you"]) {
      expect(
        resolveConversationLifecycle({
          locale: "ar",
          latestPatientText: text,
          lastAssistantText: "أقدر أساعدك في حاجة تانية؟",
          replyText: "",
          outstanding: false,
          goalCompleted: false,
        }).kind,
        text,
      ).toBe("close");
    }
  });

  it("keeps the thread open when the patient asks something else instead", () => {
    expect(
      resolveConversationLifecycle({
        locale: "ar",
        latestPatientText: "تمام، وعندكم تأمين إيه؟",
        lastAssistantText: "أقدر أساعدك في حاجة تانية؟",
        replyText: "",
        outstanding: false,
        goalCompleted: false,
      }).kind,
    ).not.toBe("close");
  });
});
