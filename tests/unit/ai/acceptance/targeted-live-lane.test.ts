/**
 * F-13 — the targeted live regression lane, and the two intent readings the
 * authority now makes.
 *
 * The filter's whole value is that it is a *selector*, not a second, weaker
 * suite: the cases it picks run through the same runner, the same scenarios and
 * the same graders as a full certification. So what is asserted here is that it
 * can only ever narrow, that it fails loudly on a name it does not recognise,
 * and that it is inert unless the live lane is explicitly on.
 *
 * No provider is constructed and no network call is made.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  LIVE_ACCEPTANCE_ENV,
  LiveAcceptanceConfigurationError,
  buildLiveCacheReport,
  liveAcceptanceEnabled,
  resolveLiveAcceptanceCaseFilter,
  selectLiveAcceptanceCases,
} from "@/lib/ai/acceptance/live-provider";
import { expandScenarios } from "@/lib/ai/acceptance/scenarios";
import { detectCancellationIntent } from "@/lib/ai/cancellation-intent";
import { isRosterQuestion } from "@/lib/ai/roster-intent";
import {
  bookingAuthorityInstruction,
  resolveBookingAuthority,
} from "@/lib/ai/booking-authority";

const ALL = expandScenarios();

/** The six cases the managed live artifact records as failures. */
const PREVIOUSLY_FAILED = [
  "incomplete-intake",
  "doctors-roster#p1",
  "existing-patient-booking-ar#p1",
  "existing-patient-booking-ar#p2",
  "cancellation-verified",
  "cancellation-verified#p3",
];

describe("the case filter", () => {
  it("is null unless the variable is set, so a full run stays the default", () => {
    expect(resolveLiveAcceptanceCaseFilter({} as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(
      resolveLiveAcceptanceCaseFilter({
        [LIVE_ACCEPTANCE_ENV.cases]: "   ",
      } as unknown as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(selectLiveAcceptanceCases(ALL, null)).toBe(ALL);
  });

  it("selects exactly the six previously-failed cases, paraphrases included", () => {
    const filter = resolveLiveAcceptanceCaseFilter({
      [LIVE_ACCEPTANCE_ENV.cases]: PREVIOUSLY_FAILED.join(","),
    } as unknown as NodeJS.ProcessEnv);
    const selected = selectLiveAcceptanceCases(ALL, filter);
    expect(selected.map((item) => item.caseId).sort()).toEqual([...PREVIOUSLY_FAILED].sort());
    // A paraphrase is a case in its own right: `cancellation-verified` and
    // `cancellation-verified#p3` are two different conversations and were two
    // different failures.
    expect(selected.filter((item) => item.caseId.includes("#")).length).toBe(4);
  });

  it("accepts whitespace and newlines as separators", () => {
    const filter = resolveLiveAcceptanceCaseFilter({
      [LIVE_ACCEPTANCE_ENV.cases]: " incomplete-intake\n doctors-roster#p1 ,, ",
    } as unknown as NodeJS.ProcessEnv);
    expect(filter).toEqual(["incomplete-intake", "doctors-roster#p1"]);
  });

  it("refuses an unknown id instead of silently certifying nothing", () => {
    // A typo that quietly ran zero cases and reported a green lane is the one
    // failure a selector can introduce.
    expect(() => selectLiveAcceptanceCases(ALL, ["incomplete-intak"])).toThrow(
      LiveAcceptanceConfigurationError,
    );
    expect(() => selectLiveAcceptanceCases(ALL, ["incomplete-intak"])).toThrow(
      /does not define/i,
    );
  });

  it("selects from the real matrix, so it can never invent a case", () => {
    const filter = ["incomplete-intake"];
    const [selected] = selectLiveAcceptanceCases(ALL, filter);
    const original = ALL.find((item) => item.caseId === "incomplete-intake")!;
    // Identity, not a copy: the same scenario object, with the same turns and
    // the same expectations the full run would grade.
    expect(selected).toBe(original);
  });

  it("stays off unless the live lane itself is on", () => {
    expect(liveAcceptanceEnabled({} as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(
      liveAcceptanceEnabled({
        [LIVE_ACCEPTANCE_ENV.cases]: PREVIOUSLY_FAILED.join(","),
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

describe("the cache report the targeted run will produce", () => {
  const pricing = {
    inputMicrosPerMillion: 1_000_000,
    outputMicrosPerMillion: 5_000_000,
    cacheReadMicrosPerMillion: 100_000,
    cacheWriteMicrosPerMillion: 1_250_000,
  };

  it("compares against the exact counterfactual rather than a model of it", () => {
    const report = buildLiveCacheReport(
      {
        calls: 10,
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadTokens: 8_000,
        cacheWriteTokens: 1_000,
        estimatedCostMicros: 0,
      },
      pricing,
    );
    // 1_000 @ 1.0x + 8_000 @ 0.1x + 1_000 @ 1.25x = 1000 + 800 + 1250 = 3050
    expect(report.inputCostMicros).toBe(3_050);
    // The same 10_000 tokens with no breakpoint at all.
    expect(report.uncachedInputCostMicros).toBe(10_000);
    expect(report.savedMicros).toBe(6_950);
    expect(report.savedFraction).toBeCloseTo(0.695, 3);
    expect(report.cacheHitFraction).toBeCloseTo(0.8, 3);
  });

  it("reports a loss as a loss when writes are never read back", () => {
    const report = buildLiveCacheReport(
      {
        calls: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 1_000,
        estimatedCostMicros: 0,
      },
      pricing,
    );
    expect(report.savedMicros).toBeLessThan(0);
    expect(report.cacheHitFraction).toBe(0);
  });
});

describe("F-9 — the cancellation reading", () => {
  it("recognises the two phrasings the live run failed on", () => {
    expect(detectCancellationIntent("عايز ألغي معادي").cancel).toBe(true);
    expect(detectCancellationIntent("ألغي الحجز من فضلك").cancel).toBe(true);
  });

  it("recognises the request across every register the suite covers", () => {
    for (const text of [
      "الغاء الموعد",
      "I want to cancel my appointment",
      "cancel my booking please",
      "أبي ألغي موعدي",
      "أرغب في إلغاء موعدي",
      "أود إلغاء الحجز من فضلك",
      "3ayez alghi el maw3ad",
      "momken cancel el maw3ad?",
    ]) {
      expect(detectCancellationIntent(text).cancel, text).toBe(true);
    }
  });

  it("does not read a question about cancellation, or a reschedule, as one", () => {
    for (const text of [
      "ما هي سياسة الإلغاء؟",
      "what is your cancellation policy?",
      "is there a cancellation fee?",
      "عايز أأجل معادي",
      "can I reschedule my appointment?",
      "عايز احجز معاد",
      "الغي السؤال",
    ]) {
      expect(detectCancellationIntent(text).cancel, text).toBe(false);
    }
  });

  it("pins the appointment read rather than the booking tool", () => {
    const authority = resolveBookingAuthority({
      // The rung a thread that has collected nothing always reports, and the
      // reason `prepare_booking` used to be forced on a cancellation.
      step: "department",
      collected: {},
      offeredDoctorIds: [],
      offeredDays: [],
      offeredSlots: [],
      closing: false,
      terminal: false,
      linked: true,
      cancellationRequest: true,
    });
    expect(authority.operation).toBe("list_my_appointments");
    expect(authority.reason).toBe("needs_appointments");
    // Never the write. The cancellation keeps every protection it has.
    expect(authority.requirement).toBe("read_authority");
  });

  it("withholds the pin from a thread with no file to read", () => {
    const authority = resolveBookingAuthority({
      step: "department",
      collected: {},
      offeredDoctorIds: [],
      offeredDays: [],
      offeredSlots: [],
      closing: false,
      terminal: false,
      linked: false,
      cancellationRequest: true,
    });
    expect(authority.operation).not.toBe("list_my_appointments");
  });
});

describe("F-10 — the roster continuation", () => {
  it("recognises 'are there other doctors?' in every register", () => {
    for (const text of [
      "في دكاترة غيره؟",
      "are there other doctors?",
      "مين تاني متاح؟",
      "هل يوجد أطباء آخرون؟",
      "في دكاترة ثانيين؟",
      "who else is available?",
    ]) {
      expect(isRosterQuestion(text), text).toBe(true);
    }
  });

  it("continues the roster once a department is settled, at any later rung", () => {
    for (const step of ["doctor", "day", "time", "intake", "confirm"] as const) {
      const authority = resolveBookingAuthority({
        step,
        collected: { department_id: "dept-1", doctor_id: "doc-1" },
        offeredDoctorIds: ["doc-1"],
        offeredDays: ["2026-09-07"],
        offeredSlots: ["2026-09-07T10:00"],
        closing: false,
        terminal: false,
        rosterQuestion: true,
      });
      expect(authority.operation, step).toBe("list_doctors");
      expect(authority.reason, step).toBe("needs_roster_continuation");
    }
  });

  it("does not hijack the department rung, where there is no roster to continue", () => {
    const authority = resolveBookingAuthority({
      step: "department",
      collected: {},
      offeredDoctorIds: [],
      offeredDays: [],
      offeredSlots: [],
      closing: false,
      terminal: false,
      rosterQuestion: true,
      // V2-CONTAINMENT — a roster question with no department settled and no
      // booking under way now falls to `conversational` rather than to the
      // department pin. F-10's property is unchanged and is what this case
      // actually guards: the roster continuation must not hijack the rung. It
      // does not; there is simply no rung to hijack, and the informational
      // mount (`list_doctors`, `list_clinic_departments`) answers the question
      // without opening a booking funnel.
      bookingOpening: false,
    });
    expect(authority.reason).toBe("conversational");
    expect(authority.operation).toBeNull();
  });

  it("tells the model the department is settled and must not be asked about again", () => {
    const authority = resolveBookingAuthority({
      step: "day",
      collected: { department_id: "dept-1", doctor_id: "doc-1" },
      offeredDoctorIds: ["doc-1"],
      offeredDays: ["2026-09-07"],
      offeredSlots: [],
      closing: false,
      terminal: false,
      rosterQuestion: true,
    });
    const en = bookingAuthorityInstruction("en", authority) ?? "";
    expect(en).toMatch(/do not ask which department/i);
    expect(en).toMatch(/list_doctors/);
  });
});
