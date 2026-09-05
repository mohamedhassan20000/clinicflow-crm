import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Item #8 — the behavioural certification matrix.
 *
 * ## Why this file exists
 *
 * The recurring failure in this product is not that fixes are wrong. It is that
 * a capability which demonstrably worked stops working several phases later,
 * because the module it lived in was changed for an unrelated reason and
 * nothing said so. Every individual behaviour here already has a test. What did
 * not exist was a single place that says *which behaviours are the contract*.
 *
 * ## The two kinds of row
 *
 *   * **Asserted here.** Invariants that are pure and cheap to state — an
 *     intent classification, a boundary reading, a ladder step, the closed set
 *     of Inbox statuses. Stating them twice is deliberate: this file is the
 *     contract, and a change that breaks one should break the contract test as
 *     well as the module's own.
 *
 *   * **A coverage ledger.** Behaviours whose test needs a database mock or a
 *     rendered component are certified in their own file, and this file asserts
 *     that the certifying case *still exists there*. That turns "somebody
 *     deleted the test that proved third-party bookings never inherit the
 *     sender's doctor" from an invisible event into a failing test.
 *
 * The ledger matches on the `it(...)` title. Renaming a case is therefore a
 * deliberate act that updates this file too, which is the point.
 */

import {
  CONVERSATION_BADGE_STATES,
  type ConversationBadgeState,
} from "@/lib/messaging/conversation-status";
import {
  effectiveConversationAiEnabled,
  resolveEffectiveConversationAi,
} from "@/lib/messaging/ai-enablement";
import { isServiceInquiry, readServiceScope } from "@/lib/ai/service-intent";
import { classifyPatientTurn, isExplicitBookingConfirmation } from "@/lib/ai/patient-turn-intent";
import { isClinicInformationQuestion } from "@/lib/ai/clinic-information-intent";
import { readDateBoundary, resolveUpcomingDayOfMonth } from "@/lib/ai/day-of-month";
import { nextBookingStep } from "@/lib/ai/booking-stage";
import { discoveryFromRelationships } from "@/lib/ai/existing-patient-discovery";

const CAIRO = "Africa/Cairo";
const at = (day: string) => ({ now: new Date(`${day}T09:00:00.000Z`), timeZone: CAIRO });

// ---------------------------------------------------------------------------
// SERVICES
// ---------------------------------------------------------------------------

describe("matrix · services", () => {
  const PARAPHRASES = [
    "عايز استفسر عن الخدمات اللي موجودة",
    "عايز أعرف الخدمات",
    "إيه الخدمات الموجودة؟",
    "ممكن أعرف الخدمات والأسعار؟",
    "بتقدموا إيه؟",
    "What services do you offer?",
    "What services and prices do you have?",
  ];

  it("every generic paraphrase reaches the same intent", () => {
    for (const text of PARAPHRASES) {
      expect(isServiceInquiry(text), text).toBe(true);
      expect(classifyPatientTurn(text).topic, text).toBe("service");
      expect(isClinicInformationQuestion(text), text).toBe(true);
    }
  });

  it("a services question mid-booking is a side question, not a lost booking", () => {
    for (const text of PARAPHRASES) {
      const classification = classifyPatientTurn(text, { workflowEngaged: true });
      expect(classification.topic, text).toBe("service");
      expect(classification.relation, text).toBe("side_question");
    }
  });

  it("the all-vs-specific answer is read the same way in every wording", () => {
    for (const text of ["كلهم", "كل الأقسام", "جميع الاقسام", "all", "all departments"]) {
      expect(readServiceScope(text), text).toBe("all");
    }
    // A department name is never decided here — that is the clinic directory's
    // job, and a lexicon that learned department names would go stale.
    expect(readServiceScope("الجلدية")).toBeNull();
  });

  it("a booking frame still outranks a price question", () => {
    for (const text of ["بكام الكشف ولو حلو احجز", "عايز أعرف الخدمات وأحجز"]) {
      expect(isClinicInformationQuestion(text), text).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// BOOKING — dates
// ---------------------------------------------------------------------------

describe("matrix · after-date lower bound", () => {
  it("«بعد 9» is a bound and never a chosen day", () => {
    for (const text of ["بعد 9", "بعد يوم 9", "بعد تاريخ 9", "أي يوم بعد 9", "after the 9th"]) {
      expect(readDateBoundary(text, at("2026-09-02")), text).toMatchObject({ day: 9 });
      expect(resolveUpcomingDayOfMonth(text, at("2026-09-02")), text).toBeNull();
    }
  });

  it("a week window is a window, not a day", () => {
    expect(readDateBoundary("الأسبوع اللي بعد يوم 9", at("2026-09-02"))).toMatchObject({
      window: "week",
    });
  });

  it("an explicit day is still a direct selection", () => {
    expect(resolveUpcomingDayOfMonth("يوم 10 سبتمبر", at("2026-09-02"))).toBeNull();
    expect(resolveUpcomingDayOfMonth("يوم 10", at("2026-09-02"))).toBe("2026-09-10");
    expect(readDateBoundary("يوم 10", at("2026-09-02"))).toBeNull();
  });

  it("a clock bound and a relative day are not date bounds", () => {
    for (const text of ["بعد الساعة 9", "بعد 9 مساءً", "بعد 3 ايام", "بعد بكرة", "بعد الضهر"]) {
      expect(readDateBoundary(text, at("2026-09-02")), text).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// BOOKING — confirmation
// ---------------------------------------------------------------------------

describe("matrix · confirmation", () => {
  it("every canonical agreement is an explicit confirmation", () => {
    for (const text of [
      "اه", "ايوه", "نعم", "تمام", "موافق", "اه تمام", "اه تمام موافق",
      "yes", "confirm", "okay",
    ]) {
      expect(isExplicitBookingConfirmation(text), text).toBe(true);
    }
  });

  it("agreement plus an edit is not a confirmation", () => {
    expect(isExplicitBookingConfirmation("اه بس غيّر الميعاد")).toBe(false);
  });

  const complete = {
    department_id: "d",
    doctor_id: "doc",
    appointment_date: "2026-09-10",
    appointment_time: 600,
  };
  const base = {
    collected: complete,
    linked: false,
    bookingForOther: false,
    intakeStaged: false,
    submitted: false,
  };

  it("the confirm rung is never offered before the write behind it can run", () => {
    expect(
      nextBookingStep({
        ...base,
        linked: true,
        bookingForOther: true,
        intakeStaged: true,
        thirdPartyIntakeStaged: false,
      }),
    ).toBe("intake");
  });

  it("the ladder never goes backwards through its rungs", () => {
    expect(nextBookingStep({ ...base, collected: {} })).toBe("department");
    expect(nextBookingStep({ ...base, collected: { department_id: "d" } })).toBe("doctor");
    expect(
      nextBookingStep({ ...base, collected: { department_id: "d", doctor_id: "doc" } }),
    ).toBe("day");
    expect(nextBookingStep({ ...base, linked: true })).toBe("confirm");
    expect(nextBookingStep({ ...base, linked: true, submitted: true })).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// IDENTITY
// ---------------------------------------------------------------------------

describe("matrix · identity", () => {
  const row = {
    patient_id: "p1",
    full_name: "جهاد علي",
    department_id: "derm",
    department_name: "الجلدية",
    doctor_id: "doc",
    doctor_name: "أحمد نبيل",
    is_primary: true,
  };

  it("no match is not a match", () => {
    expect(discoveryFromRelationships([])).toEqual({ kind: "none" });
  });

  it("one department offers the treating doctor; several ask which", () => {
    expect(discoveryFromRelationships([row]).kind).toBe("single_department");
    expect(
      discoveryFromRelationships([
        row,
        { ...row, department_id: "cardio", department_name: "القلب", is_primary: false },
      ]).kind,
    ).toBe("multiple_departments");
  });

  it("nothing about the discovered person leaves except where they are known", () => {
    const serialized = JSON.stringify(discoveryFromRelationships([row]));
    for (const leak of ["phone", "email", "national", "file_number", "date_of_birth"]) {
      expect(serialized, leak).not.toContain(leak);
    }
  });
});

// ---------------------------------------------------------------------------
// AI CONTROL
// ---------------------------------------------------------------------------

describe("matrix · AI control", () => {
  it("there are seven Inbox statuses and no eighth", () => {
    expect(CONVERSATION_BADGE_STATES).toEqual([
      "done",
      "problem",
      "needsReview",
      "newContact",
      "humanHandling",
      "waitingPatient",
      "aiHandling",
    ] satisfies readonly ConversationBadgeState[]);
  });

  it("the clinic default governs a thread with no opinion of its own", () => {
    expect(effectiveConversationAiEnabled({ clinicMode: "auto", override: null })).toBe(true);
    expect(effectiveConversationAiEnabled({ clinicMode: "off", override: null })).toBe(false);
  });

  it("an explicit per-conversation override outranks the clinic default, both ways", () => {
    expect(effectiveConversationAiEnabled({ clinicMode: "off", override: true })).toBe(true);
    expect(effectiveConversationAiEnabled({ clinicMode: "auto", override: false })).toBe(false);
  });

  it("Pause AI wins over everything, including an override that admits the thread", () => {
    expect(
      effectiveConversationAiEnabled({
        clinicMode: "auto",
        override: true,
        aiPausedAt: "2026-09-01T00:00:00Z",
      }),
    ).toBe(false);
  });

  it("the effective decision is one function, and the Inbox reads it rather than re-deriving it", () => {
    // The Inbox header's global control and the per-thread badge must both come
    // through here. A second implementation of "is the assistant answering?" is
    // the defect this rule exists to prevent.
    expect(resolveEffectiveConversationAi({ clinicMode: "off", override: null }).enabled).toBe(
      false,
    );
    const inbox = readFileSync("lib/messaging/inbox.ts", "utf8");
    expect(inbox).toContain("effectiveConversationAiEnabled");
    expect(inbox).toContain("normalizeClinicAiReplyMode");
  });

  it("the Inbox global control writes the same setting Settings writes", () => {
    const control = readFileSync("components/inbox/inbox-ai-replies-control.tsx", "utf8");
    const settings = readFileSync("components/settings/whatsapp-ai-replies-card.tsx", "utf8");
    for (const source of [control, settings]) {
      expect(source).toContain('from "@/actions/patient-ai"');
      expect(source).toContain("setPatientAiReplyMode");
    }
  });
});

// ---------------------------------------------------------------------------
// The coverage ledger
// ---------------------------------------------------------------------------

/**
 * Behaviours certified elsewhere, and where. A deleted or renamed case fails
 * here, which is the whole mechanism: capabilities stop working silently, and
 * this is what makes losing one loud.
 */
const LEDGER: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    "tests/unit/ai/item2-service-intent-and-scope.test.ts",
    [
      "does not ask when the clinic has only one department",
      "gives every department when the patient says «كلهم»",
      "gives one department when the patient names one",
      "reflects a department added since the last deploy, with no code change",
      "reflects a changed price rather than a remembered one",
      "says so plainly when a clinic has no departments configured",
      "uses the department a booking already settled, and never asks again",
    ],
  ],
  [
    "tests/unit/ai/item3-existing-beneficiary-flow.test.ts",
    [
      "does not propose a second file for her",
      "uses the beneficiary's own relationships, not the sender's",
      "offers her existing department before anything is staged",
      "asks which department when she is known in more than one",
      "never opens a duplicate when the matched staging refuses",
      "stages a new file exactly as before",
      "never runs the identity lookup when booking for themself",
    ],
  ],
  [
    "tests/unit/ai/item4-correction-outranks-rung.test.ts",
    [
      "does not turn «لا أنا عايز يوم 12» into 12:00 on the 10th",
      "does not commit anything on the old day when the corrected day cannot be read",
      "resolves the day the patient actually named, against real availability",
      "keeps the doctor, the department and the intake across the correction",
      "says so plainly when the corrected day has nothing free, and moves nothing",
      "keeps the day and the doctor, and recomputes the hour against the schedule",
      "still commits a bare offered time",
    ],
  ],
  [
    "tests/unit/ai/item5-date-lower-bound.test.ts",
    [
      "does not commit the 9th when the patient asks for the days after it",
      "re-opens day discovery instead of leaving the old offer standing",
      "invalidates a date and time already held, and nothing upstream of them",
      "leaves an explicit day selection alone",
    ],
  ],
  [
    "tests/unit/ai/item6-confirmation-loop-flow.test.ts",
    [
      "asks for the intake instead of asking for a confirmation",
      "does not hand a confirmation write authority when the patient says «موافق»",
      "reaches the confirmation, exactly as before",
      "keeps a submitted booking terminal rather than re-asking anything",
    ],
  ],
  [
    "tests/unit/ai/p11f-booking-forward-progress.test.ts",
    [
      "walks department → doctor → day → time → intake without ever going back",
      "an explicit department change is allowed and clears what it invalidates",
      "an explicit doctor change is allowed and keeps the department",
      "a slot taken between turns drops exactly one rung",
      "never touches the bookingForOther latch",
    ],
  ],
  [
    "tests/unit/ai/p12-whatsapp-booking-corrections-flow.test.ts",
    [
      "does not force the sender's treating doctor once the latch is set",
      "records the rung the side question interrupted, and offers to continue",
      "resumes from that exact rung when the patient agrees",
      "carries the request and touches no state",
    ],
  ],
  [
    "tests/unit/ai/booking-beneficiary.test.ts",
    [
      "answers 'لشخص تاني' to the question by opening a third-party intake",
      "never infers 'self' from the linkage alone",
      "survives an amendment to the booking review",
    ],
  ],
  [
    "tests/unit/lib/whatsapp-account-boundary.test.ts",
    [
      "shows the identical boundary across connected -> disconnected -> connected",
      "is still account A while A is disconnected and the channel row is gone",
      "moves to B, and only to B, once B is the proved account",
      "fails closed while pairing, rather than revealing legacy rows",
      "reads the legacy NULL scope only for a clinic that has never linked anything",
    ],
  ],
  [
    "tests/unit/lib/inbox-thread-account-scope.test.ts",
    [
      "keeps the same account scope while the linked device is disconnected",
      "never reads message tables when the conversation is outside the current account",
    ],
  ],
  [
    "tests/unit/components/p17-inbox-global-ai-control.test.tsx",
    [
      "turns the clinic default off through the existing action",
      "is read-only for a role that may not change it",
      "does not claim every conversation follows the clinic default when some do not",
      "yields to the server's value on re-render rather than pinning a stale flip",
    ],
  ],
];

describe("matrix · coverage ledger", () => {
  it.each(LEDGER)("%s still certifies its rows", (path, cases) => {
    const source = readFileSync(path, "utf8");
    for (const name of cases) {
      expect(source, `${path} no longer contains: ${name}`).toContain(name);
    }
  });
});
