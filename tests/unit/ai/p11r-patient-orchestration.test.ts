import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import {
  classifyPatientTurn,
  isExplicitBookingConfirmation,
  toolsForInformationalTurn,
} from "@/lib/ai/patient-turn-intent";
import {
  buildPatientBookingConfirmationReply,
} from "@/lib/ai/patient-booking-confirmation";
import { resolveBookingAuthority } from "@/lib/ai/booking-authority";
import { createGroundingLedger } from "@/lib/ai/patient-grounding";
import { enforcePatientFactReply, formatPatientDate, formatPatientTime } from "@/lib/ai/patient-fact-reply";
import { filterSlotsAfter, parsePatientAfterTime } from "@/lib/ai/patient-time-constraint";
import { buildPatientSystemPrompt } from "@/lib/ai/prompts/patient";
import { runConversation } from "@/lib/ai/acceptance/runner";
import { compliantModel } from "@/lib/ai/acceptance/personas";
import { expandScenarios } from "@/lib/ai/acceptance/scenarios";
import { EMPTY_BOOKING_STAGE_STATE, parseBookingStageState, serializeBookingStageState } from "@/lib/ai/booking-stage";

function confirmAuthority(explicitBookingConfirmation: boolean) {
  return resolveBookingAuthority({
    step: "confirm",
    collected: {
      department_id: "department",
      doctor_id: "doctor",
      appointment_date: "2026-09-10",
      appointment_time: 1020,
    },
    offeredDoctorIds: ["doctor"],
    offeredDays: ["2026-09-10"],
    offeredSlots: ["2026-09-10T17:00"],
    closing: false,
    terminal: false,
    explicitBookingConfirmation,
  });
}

describe("P11R patient turn orchestration", () => {
  it("requires a separate explicit confirmation before the booking write", () => {
    expect(confirmAuthority(false)).toMatchObject({
      requirement: "none",
      operation: null,
      reason: "needs_booking_confirmation",
    });
    expect(confirmAuthority(true)).toMatchObject({
      requirement: "write_authority",
      operation: "create_preliminary_booking",
    });
    expect(isExplicitBookingConfirmation("أيوه")).toBe(true);
    expect(isExplicitBookingConfirmation("أيوه، أكد الطلب")).toBe(true);
    expect(isExplicitBookingConfirmation("موافق، ابعته")).toBe(true);
    expect(isExplicitBookingConfirmation("أكد")).toBe(true);
    expect(isExplicitBookingConfirmation("الساعة ٥")).toBe(false);
  });

  it("carries the linked-patient flow through summary and explicit confirmation", async () => {
    const item = expandScenarios().find(
      (candidate) => candidate.caseId === "existing-patient-booking-ar",
    )!;
    const run = await runConversation(item.caseId, item.turns, {
      model: compliantModel(),
      locale: item.scenario.locale,
      patient: item.scenario.patient,
    });

    expect({
      turns: run.turns.map((turn) => ({
        patient: turn.patientText,
        stageBefore: turn.stageBefore,
        stepBefore: turn.stepBefore,
        step: turn.step,
        precommit: turn.precommit,
        authority: turn.authority,
        activeTools: turn.activeTools,
        requestedTools: turn.requestedTools,
        executedTools: turn.executedTools,
      })),
      writes: run.simulator.writes,
      collected: run.simulator.collected,
    }).toMatchObject({
      writes: [
        expect.objectContaining({
          operation: "create_preliminary_booking",
          committed: true,
        }),
      ],
    });
  });

  it("renders a localized pending-request summary without ISO or internal time", () => {
    const reply = buildPatientBookingConfirmationReply("ar", {
      doctorName: "د. أحمد",
      date: "2026-09-10",
      time: "17:00",
    });
    expect(reply).toContain("د. أحمد");
    expect(reply).toContain("طلب حجز منتظر تأكيد العيادة");
    expect(reply).not.toContain("2026-09-10");
    expect(reply).not.toContain("17:00");
    expect(formatPatientDate("2026-09-10", "en")).not.toContain("2026-09-10");
    expect(formatPatientTime("17:00", "en")).toBe("5:00 PM");
  });

  it("classifies side questions and suppresses stale booking tools", () => {
    const sequence = [
      classifyPatientTurn("عايز أحجز", { workflowEngaged: false }),
      classifyPatientTurn("كشف أسنان بكام؟", { workflowEngaged: true }),
      classifyPatientTurn("إيه بياناتي عندكم؟", { workflowEngaged: true }),
      classifyPatientTurn("والرقم القومي؟", { workflowEngaged: true }),
    ];
    expect(sequence[1]).toMatchObject({ topic: "service", relation: "side_question" });
    expect(sequence[2]).toMatchObject({ topic: "privacy", informationalOnly: true });
    expect(sequence[3]).toMatchObject({ topic: "privacy", informationalOnly: true });
    expect(toolsForInformationalTurn(sequence[2]!.topic)).toEqual([]);
    expect(toolsForInformationalTurn(sequence[3]!.topic)).toEqual([]);
    expect(classifyPatientTurn("أرغب في حجز موعد في قسم الجلدية").topic).toBe("booking");
    expect(classifyPatientTurn(
      "عمر حسن، الرقم القومي 29004121200345، مواليد 12/4/1990، ايميلي omar@example.com",
      { workflowEngaged: true },
    ).topic).not.toBe("privacy");
  });

  it("keeps roster FAQs and negative availability inquiries out of booking mutation", () => {
    expect(classifyPatientTurn("عندكم دكاترة قلب مين؟")).toMatchObject({
      topic: "roster",
      informationalOnly: true,
    });
    expect(classifyPatientTurn("مش عايز أحجز، مين من الاتنين متاح بكرة بعد 5؟")).toMatchObject({
      topic: "availability",
      informationalOnly: true,
    });
    expect(toolsForInformationalTurn("availability")).toContain("compare_doctor_availability");
    expect(classifyPatientTurn("مش هحجز")).toMatchObject({
      topic: "negative_booking",
      informationalOnly: true,
    });
  });

  it("separates reschedule language from a pure availability inquiry", () => {
    expect(classifyPatientTurn("هل بكرة 11 متاح؟").topic).toBe("availability");
    expect(classifyPatientTurn("غير حجزي لبكرة 11").topic).toBe("reschedule");
    expect(classifyPatientTurn("لو متاح غيره لبكرة 11").topic).toBe("reschedule");
    expect(classifyPatientTurn("أغيره").topic).toBe("reschedule");
  });

  it("uses a read-confirm-write reschedule authority path even after booking submission", () => {
    const base = {
      step: "done" as const,
      collected: {},
      offeredDoctorIds: [],
      offeredDays: [],
      offeredSlots: ["2026-09-10T11:00"],
      closing: false,
      terminal: true,
      linked: true,
    };
    expect(resolveBookingAuthority({ ...base, appointmentChangeRequest: true })).toMatchObject({
      requirement: "read_authority",
      operation: "list_my_appointments",
      reason: "needs_reschedule_target",
    });
    expect(resolveBookingAuthority({
      ...base,
      appointmentChange: { selectedTime: false },
    })).toMatchObject({
      operation: "check_reschedule_availability",
      reason: "needs_reschedule_availability",
    });
    expect(resolveBookingAuthority({
      ...base,
      appointmentChange: { selectedTime: true },
      explicitBookingConfirmation: false,
    })).toMatchObject({
      requirement: "none",
      reason: "needs_reschedule_confirmation",
    });
    expect(resolveBookingAuthority({
      ...base,
      appointmentChange: { selectedTime: true },
      explicitBookingConfirmation: true,
    })).toMatchObject({
      requirement: "write_authority",
      operation: "reschedule_my_appointment",
      reason: "needs_reschedule",
    });
  });

  it("round-trips only a structurally valid server reschedule proposal", () => {
    const state = {
      ...EMPTY_BOOKING_STAGE_STATE,
      appointmentChange: {
        appointmentId: "11111111-1111-4111-8111-111111111111",
        doctorId: "22222222-2222-4222-8222-222222222222",
        doctorName: "Dr. Ahmed",
        departmentId: null,
        serviceId: null,
        durationMinutes: 30,
        date: "2026-09-10",
        time: "11:00",
      },
    };
    expect(parseBookingStageState(serializeBookingStageState(state)).appointmentChange)
      .toEqual(state.appointmentChange);
    expect(parseBookingStageState({
      ...serializeBookingStageState(state),
      appointmentChange: { ...state.appointmentChange, appointmentId: "model-chosen" },
    }).appointmentChange).toBeNull();
  });

  it("filters Arabic and English lower-time constraints before presentation", () => {
    expect(parsePatientAfterTime("بعد الساعة ٢")).toBe(14 * 60);
    expect(parsePatientAfterTime("after 5 PM")).toBe(17 * 60);
    expect(filterSlotsAfter(["13:30", "14:00", "14:30", "18:00"], 14 * 60))
      .toEqual(["14:30", "18:00"]);
  });

  it("answers an exact Sunday follow-up and limits long lists", () => {
    const ledger = createGroundingLedger();
    ledger.record("list_available_days", {
      ok: true,
      doctor_name: "Ahmed",
      availableDays: [
        "2026-09-06", "2026-09-07", "2026-09-13", "2026-09-20",
      ].map((date) => ({ date })),
    });
    const reply = enforcePatientFactReply({
      locale: "ar",
      text: "ignored",
      ledger,
      latestPatientText: "مفيش ولا يوم أحد؟",
    }).text;
    expect(reply).toContain("أيوه");
    expect(reply).toContain("الأحد");
    expect(reply).not.toContain("2026-09");
  });

  it("caps rosters and does not push booking from a roster-only FAQ", () => {
    const ledger = createGroundingLedger();
    ledger.record("list_doctors", {
      doctors: Array.from({ length: 10 }, (_, index) => ({ name: `Doctor ${index + 1}` })),
      department: { name: "Cardiology" },
      needs_selection: true,
    });
    const reply = enforcePatientFactReply({
      locale: "en",
      text: "ignored",
      ledger,
      rosterOnly: true,
    }).text;
    expect(reply).toContain("6. Dr. 6");
    expect(reply).not.toContain("7. Dr. 7");
    expect(reply).toContain("4 more options");
    expect(reply).not.toContain("Who would you like to book with?");
  });

  it("states a named unavailable department directly and never invents a price", () => {
    const ledger = createGroundingLedger();
    ledger.record("list_department_services", {
      found: false,
      reason: "unknown",
      requested_department: "أسنان",
      departments: [{ name: "Cardiology" }],
    });
    const reply = enforcePatientFactReply({ locale: "ar", text: "ignored", ledger }).text;
    expect(reply).toContain("مفيش قسم أسنان");
    expect(reply).not.toMatch(/\d+\s*(?:EGP|جنيه)/i);
  });

  it("keeps phone confirmation, optional blood type, privacy, and compact greeting in both prompts", () => {
    const en = buildPatientSystemPrompt("en");
    const ar = buildPatientSystemPrompt("ar");
    expect(en).toContain("using that WhatsApp number is okay");
    expect(en).toContain("Blood type is optional");
    expect(en).toContain("never proof of identity");
    expect(ar).toContain("هل يناسبه استخدام رقم واتساب هذا");
    expect(ar).toContain("فصيلة الدم اختيارية");
    expect(ar).toContain("سجل المحادثة ليس إثبات هوية");
  });
});
