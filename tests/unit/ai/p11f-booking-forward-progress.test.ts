import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11F §3/§4/§8/§9 — a booking never asks the same question twice.
 *
 * ## The production trace this replays
 *
 * Every turn of the real conversation had `tool_called: "none"`: the model
 * never called a booking tool once, so the deterministic continuation *was* the
 * booking flow. It knew two sentences — the roster and the days — and the
 * patient walked off the end of them:
 *
 * ```
 *   turn 38  "علاج طبيعي"        → department committed, roster offered   ✅
 *   turn 39  "حنين"              → doctor committed, days offered         ✅
 *   turn 40  "يوسف"              → doctor changed, days offered           ✅
 *   turn 41  "31"                → (model prose) times                    ⚠️
 *   turn 42  "الساعه ٩ الصبح"    → "الدكاترة المتاحين في …"                ❌
 * ```
 *
 * `stage_before` and `stage_after` were `intake_collecting` on the last three,
 * and `illegalTransitions` stayed 0 throughout — the stage machine was never
 * wrong. The *presentation* went backwards, and nothing had an opinion about
 * that until this phase.
 *
 * ## Generated data only
 *
 * Every department and person below is invented for this file. Production code
 * knows none of them — `p11b`/`p11c` assert exactly that against the source
 * tree — and swapping these strings for any others must not change one
 * assertion about control flow. §7 of the brief is a property of the code, and
 * the last block here tests it by running the whole flow twice with two
 * unrelated departments.
 */

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const DEPT_A = "d0000000-0000-4000-8000-0000000000aa";
const DEPT_B = "d0000000-0000-4000-8000-0000000000bb";
const DOC_1 = "e0000000-0000-4000-8000-0000000000c1";
const DOC_2 = "e0000000-0000-4000-8000-0000000000c2";
const DOC_3 = "e0000000-0000-4000-8000-0000000000c3";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  setState: vi.fn(),
  recordStage: vi.fn(),
  days: vi.fn(),
  slots: vi.fn(),
  book: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: mocks.audit }));
vi.mock("@/lib/supabase/admin", () => ({
  setConversationAiState: mocks.setState,
  resolvePatientAiContext: vi.fn(),
}));
vi.mock("@/lib/ai/booking-stage-store", () => ({ recordStageTurn: mocks.recordStage }));
vi.mock("@/lib/booking/patient", () => ({
  getPatientAvailableDays: mocks.days,
  getPatientAvailableSlots: mocks.slots,
  createPatientPendingBooking: mocks.book,
}));

import { continuePatientBookingFromRoster } from "@/lib/ai/patient-roster-continuation";
import {
  EMPTY_BOOKING_STAGE_STATE,
  nextBookingStep,
  recordOfferedDays,
  recordOfferedDoctors,
  recordOfferedSlots,
  type BookingStageState,
} from "@/lib/ai/booking-stage";
import type { CollectedData } from "@/lib/ai/collected-state";

// ---------------------------------------------------------------------------
// A conversation that actually remembers things
// ---------------------------------------------------------------------------

const DAYS = ["2026-08-26", "2026-08-27", "2026-08-31"];
const TIMES = ["09:00", "09:30", "10:00", "14:00"];

function directory(overrides: { doctorState?: Record<string, "available" | "inactive"> } = {}) {
  const state = (id: string) => overrides.doctorState?.[id] ?? "available";
  return {
    departments: [
      { id: DEPT_A, name: "Physiotherapy Wing " },
      { id: DEPT_B, name: "Dermatology Suite" },
    ],
    doctors: [
      { id: DOC_1, name: "Dr. Wren Halloway", departmentId: DEPT_A, departmentName: "Physiotherapy Wing ", state: state(DOC_1), unavailableUntil: null },
      { id: DOC_2, name: "Dr. Ilias Vantorre", departmentId: DEPT_A, departmentName: "Physiotherapy Wing ", state: state(DOC_2), unavailableUntil: null },
      { id: DOC_3, name: "Dr. Perri Callowhill", departmentId: DEPT_B, departmentName: "Dermatology Suite", state: state(DOC_3), unavailableUntil: null },
    ],
  };
}

/**
 * The conversation, as a mutable object the mocked writes actually update.
 *
 * A stateless replay would prove nothing: the whole defect was that a sentence
 * was said and not remembered, so a fixture that forgets is a fixture that
 * cannot see the bug.
 */
class Thread {
  collected: CollectedData = {};
  stage: BookingStageState = { ...EMPTY_BOOKING_STAGE_STATE };
  readonly outcomes: string[] = [];
  readonly replies: string[] = [];

  constructor(options: { bookingForOther?: boolean; linked?: boolean } = {}) {
    this.stage = { ...EMPTY_BOOKING_STAGE_STATE, bookingForOther: options.bookingForOther ?? false };
    this.linked = options.linked ?? false;
  }
  linked: boolean;

  identity() {
    return {
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      patientId: null,
      linked: this.linked,
      identityVerifiedAt: null,
      identityLockedUntil: null,
      clinicName: "Test Clinic",
      clinicLocale: "ar" as const,
      clinicTimezone: "Africa/Cairo",
      clinicCountry: "EG",
      participantAddress: "+201000000000",
      aiPaused: false,
      collectedData: this.collected,
      pendingClarification: null,
      bookingStage: this.stage,
      communicationStyle: {},
    } as never;
  }

  /** Applies what `setConversationAiState` and `recordStageTurn` were told. */
  absorb(collected: Record<string, string> | null, patch: Record<string, unknown> | null) {
    if (collected) {
      for (const [key, value] of Object.entries(collected)) {
        if (value === "") delete (this.collected as Record<string, unknown>)[key];
        else (this.collected as Record<string, unknown>)[key] = value;
      }
    }
    if (!patch) return;
    if (patch.offeredDoctorIds) {
      this.stage = recordOfferedDoctors(this.stage, patch.offeredDoctorIds as string[]);
    }
    if (patch.offeredDays) {
      this.stage = recordOfferedDays(this.stage, patch.offeredDays as string[]);
    }
    if (patch.offeredSlots) {
      const offer = patch.offeredSlots as { date: string; times: string[] };
      this.stage = recordOfferedSlots(this.stage, offer.date, offer.times);
    }
    if (patch.submitted) this.stage = { ...this.stage, submitted: true };
  }

  step() {
    return nextBookingStep({
      collected: this.collected,
      linked: this.linked,
      bookingForOther: this.stage.bookingForOther,
      intakeStaged: this.stage.intakeStaged,
      submitted: this.stage.submitted,
    });
  }

  async say(text: string, options: { directory?: ReturnType<typeof directory> } = {}) {
    const result = await continuePatientBookingFromRoster({
      identity: this.identity(),
      directory: (options.directory ?? directory()) as never,
      locale: "ar",
      patientText: text,
    });
    this.outcomes.push(result.outcome);
    this.replies.push(result.text);
    return result;
  }
}

let thread: Thread;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.audit.mockResolvedValue(undefined);
  mocks.recordStage.mockResolvedValue(null);
  mocks.days.mockResolvedValue({
    ok: true,
    availableDays: DAYS.map((date) => ({ date, slotCount: 4 })),
  });
  mocks.slots.mockResolvedValue({ ok: true, availableSlots: TIMES });
  mocks.book.mockResolvedValue({
    ok: true,
    appointmentId: "a1",
    expiresAt: "2026-08-25T00:00:00Z",
    provisional: true,
  });
  thread = new Thread({ bookingForOther: true });
  mocks.setState.mockImplementation(async (args: { collected?: Record<string, string> }) => {
    thread.absorb(args.collected ?? null, null);
    return { error: null };
  });
  mocks.recordStage.mockImplementation(async (_identity: unknown, patch: Record<string, unknown>) => {
    thread.absorb(null, patch);
    return null;
  });
});

// ---------------------------------------------------------------------------
// §9 — the exact manual flow
// ---------------------------------------------------------------------------

describe("P11F §9 · the exact manual flow, end to end", () => {
  it("walks department → doctor → day → time → intake without ever going back", async () => {
    // 1. The opening move: a department the patient names.
    const t1 = await thread.say("عايز احجز لابني علاج طبيعي");
    expect(t1.outcome).toBe("roster_offered");
    expect(thread.collected.department_id).toBe(DEPT_A);

    // 2. The doctor.
    const t2 = await thread.say("Wren");
    expect(t2.outcome).toBe("doctor_selected");
    expect(thread.collected.doctor_id).toBe(DOC_1);
    expect(t2.text).toContain("٣١ أغسطس ٢٠٢٦");
    expect(t2.text).not.toContain("2026-08-31");

    // 3. The day, as a bare number off the list — the ordinary Arabic reply.
    const t3 = await thread.say("31");
    expect(t3.outcome).toBe("day_selected");
    expect(thread.collected.appointment_date).toBe("2026-08-31");
    expect(t3.text).toContain("9:00 صباحًا");
    expect(t3.text).not.toContain("09:00");

    // 4. The time. THIS is the turn that used to re-render the doctor roster.
    const t4 = await thread.say("الساعه ٩ الصبح");
    expect(t4.outcome).toBe("intake_required");
    expect(thread.collected.appointment_time).toBe(540);

    // The regression, stated directly.
    expect(t4.text).not.toContain("الدكاترة المتاحين");
    expect(t4.text).not.toContain("Ilias");
    expect(t4.text).not.toContain("الأقسام المتاحة");

    // The booking target is restated, not lost.
    expect(t4.text).toContain("2026-08-31");
    expect(t4.text).toContain("09:00");
    expect(t4.text).toContain("Wren Halloway");

    // 5. Intake completes; the preserved target becomes the pending booking.
    thread.stage = { ...thread.stage, intakeStaged: true };
    const t5 = await thread.say("خلصنا البيانات");
    expect(t5.outcome).toBe("booking_created");
    expect(mocks.book).toHaveBeenCalledWith(
      expect.objectContaining({ doctorId: DOC_1 }),
    );

    // No step was ever asked about twice, and no step was ever revisited.
    expect(thread.outcomes).toEqual([
      "roster_offered",
      "doctor_selected",
      "day_selected",
      "intake_required",
      "booking_created",
    ]);
  });

  it("never leaks English into the Arabic flow beyond the people's own names", async () => {
    await thread.say("عايز احجز لابني علاج طبيعي");
    // The department was stored in English; the reply is Arabic.
    expect(thread.replies[0]).not.toContain("Physiotherapy Wing");
    // Person names are the one thing that stays as stored, with an Arabic title.
    expect(thread.replies[0]).toContain("د. Wren Halloway");
  });
});

// ---------------------------------------------------------------------------
// §4 — monotonicity, and the four sanctioned exceptions
// ---------------------------------------------------------------------------

describe("P11F §4 · the ladder only moves forward", () => {
  it("nextBookingStep is monotonic in the collected facts", () => {
    const facts = { linked: false, bookingForOther: true, intakeStaged: false, submitted: false };
    expect(nextBookingStep({ ...facts, collected: {} })).toBe("department");
    expect(nextBookingStep({ ...facts, collected: { department_id: DEPT_A } })).toBe("doctor");
    expect(nextBookingStep({ ...facts, collected: { department_id: DEPT_A, doctor_id: DOC_1 } })).toBe("day");
    expect(
      nextBookingStep({ ...facts, collected: { department_id: DEPT_A, doctor_id: DOC_1, appointment_date: "2026-08-31" } }),
    ).toBe("time");
    const full = { department_id: DEPT_A, doctor_id: DOC_1, appointment_date: "2026-08-31", appointment_time: "09:00" };
    expect(nextBookingStep({ ...facts, collected: full })).toBe("intake");
    expect(nextBookingStep({ ...facts, collected: full, intakeStaged: true })).toBe("confirm");
    expect(nextBookingStep({ ...facts, collected: full, intakeStaged: true, submitted: true })).toBe("done");
    // A linked patient booking for themselves skips intake entirely.
    expect(nextBookingStep({ ...facts, collected: full, linked: true, bookingForOther: false })).toBe("confirm");
  });

  it("a plain valid time never produces a doctor roster", async () => {
    thread.collected = { department_id: DEPT_A, doctor_id: DOC_1, doctor_name: "Dr. Wren Halloway", appointment_date: "2026-08-31" };
    thread.stage = recordOfferedSlots(
      recordOfferedDoctors(thread.stage, [DOC_1, DOC_2]),
      "2026-08-31",
      TIMES,
    );
    const result = await thread.say("الساعه ٩ الصبح");
    expect(result.outcome).not.toBe("roster_offered");
    expect(result.text).not.toContain("الدكاترة المتاحين");
  });

  it("never advances to intake when the selected time was not persisted", async () => {
    thread.collected = { department_id: DEPT_A, doctor_id: DOC_1, doctor_name: "Dr. Wren Halloway", appointment_date: "2026-08-31" };
    thread.stage = recordOfferedSlots(thread.stage, "2026-08-31", TIMES);
    mocks.setState.mockResolvedValue({ error: { message: "write rejected" } });

    const result = await thread.say("الساعه ٩ الصبح");

    expect(result).toMatchObject({
      committed: "none",
      outcome: "time_commit_failed",
    });
    expect(thread.collected.appointment_time).toBeUndefined();
    expect(result.text).not.toContain("بيانات المريض");
    expect(mocks.book).not.toHaveBeenCalled();
  });

  it("an unrecognised reply at the time step re-offers times, not doctors", async () => {
    thread.collected = { department_id: DEPT_A, doctor_id: DOC_1, doctor_name: "Dr. Wren Halloway", appointment_date: "2026-08-31" };
    thread.stage = recordOfferedDoctors(thread.stage, [DOC_1, DOC_2]);
    const result = await thread.say("مش عارف");
    expect(result.outcome).toBe("times_offered");
    expect(result.text).toContain("9:00 صباحًا");
    expect(result.text).not.toContain("09:00");
    expect(result.text).not.toContain("الدكاترة المتاحين");
  });

  it("an unrecognised reply at the day step re-offers days, not doctors", async () => {
    thread.collected = { department_id: DEPT_A, doctor_id: DOC_1, doctor_name: "Dr. Wren Halloway" };
    thread.stage = recordOfferedDoctors(thread.stage, [DOC_1, DOC_2]);
    const result = await thread.say("مش عارف");
    expect(result.outcome).toBe("days_offered");
    expect(result.text).toContain("٣١ أغسطس ٢٠٢٦");
    expect(result.text).not.toContain("2026-08-31");
    expect(result.text).not.toContain("الدكاترة المتاحين");
  });

  it("an ambiguous time is asked about as a time", async () => {
    thread.collected = { department_id: DEPT_A, doctor_id: DOC_1, doctor_name: "Dr. Wren Halloway", appointment_date: "2026-08-31" };
    thread.stage = recordOfferedSlots(thread.stage, "2026-08-31", ["09:00", "21:00"]);
    const result = await thread.say("الساعة ٩");
    expect(result.outcome).toBe("time_ambiguous");
    expect(result.text).toContain("9:00 مساءً");
    expect(result.text).not.toContain("21:00");
    expect(result.text).not.toContain("الدكاترة");
  });

  // -- exception 1: the patient changes department ---------------------------
  it("an explicit department change is allowed and clears what it invalidates", async () => {
    thread.collected = {
      department_id: DEPT_A,
      doctor_id: DOC_1,
      doctor_name: "Dr. Wren Halloway",
      appointment_date: "2026-08-31",
    };
    const result = await thread.say("لا، عايز جلدية");
    expect(result.outcome).toBe("department_changed");
    expect(thread.collected.department_id).toBe(DEPT_B);
    expect(thread.collected.doctor_id).toBeUndefined();
    expect(thread.collected.appointment_date).toBeUndefined();
  });

  // -- exception 2: the patient changes doctor -------------------------------
  it("an explicit doctor change is allowed and keeps the department", async () => {
    thread.collected = { department_id: DEPT_A, doctor_id: DOC_1, doctor_name: "Dr. Wren Halloway", appointment_date: "2026-08-31" };
    thread.stage = recordOfferedDoctors(thread.stage, [DOC_1, DOC_2]);
    const result = await thread.say("Ilias");
    expect(result.outcome).toBe("doctor_changed");
    expect(thread.collected.doctor_id).toBe(DOC_2);
    expect(thread.collected.department_id).toBe(DEPT_A);
    expect(thread.collected.appointment_date).toBeUndefined();
  });

  it('"مين تاني؟" re-offers the roster and nothing above it', async () => {
    thread.collected = { department_id: DEPT_A, doctor_id: DOC_1, doctor_name: "Dr. Wren Halloway" };
    thread.stage = recordOfferedDoctors(thread.stage, [DOC_1, DOC_2]);
    const result = await thread.say("في دكتور تاني؟");
    expect(result.outcome).toBe("doctor_changed");
    expect(thread.collected.department_id).toBe(DEPT_A);
    expect(result.text).not.toContain("الأقسام المتاحة");
  });

  it("naming the doctor already chosen is a confirmation, not a change", async () => {
    thread.collected = { department_id: DEPT_A, doctor_id: DOC_1, doctor_name: "Dr. Wren Halloway", appointment_date: "2026-08-31" };
    thread.stage = recordOfferedSlots(recordOfferedDoctors(thread.stage, [DOC_1, DOC_2]), "2026-08-31", TIMES);
    const result = await thread.say("أيوه Wren، الساعة ٩ الصبح");
    expect(result.outcome).not.toBe("doctor_changed");
    expect(thread.collected.doctor_id).toBe(DOC_1);
  });

  // -- exception 3: the doctor becomes unavailable ---------------------------
  it("a doctor deactivated between turns forces a controlled reselection", async () => {
    thread.collected = { department_id: DEPT_A, doctor_id: DOC_1, doctor_name: "Dr. Wren Halloway", appointment_date: "2026-08-31" };
    const result = await thread.say("الساعه ٩ الصبح", {
      directory: directory({ doctorState: { [DOC_1]: "inactive" } }),
    });
    expect(result.outcome).toBe("doctor_unavailable");
    expect(thread.collected.doctor_id).toBeUndefined();
    // The department survives — it was not the thing that became invalid.
    expect(thread.collected.department_id).toBe(DEPT_A);
    expect(result.text).not.toContain("الأقسام المتاحة");
    // The reply *names* the doctor who became unavailable — that is the whole
    // point of a controlled reselection — and then offers the real alternative.
    expect(result.text).toContain("مابقاش متاحًا");
    expect(result.text).toContain("Ilias Vantorre");
  });

  // -- exception 4: the slot fails revalidation ------------------------------
  it("a slot taken between turns drops exactly one rung", async () => {
    mocks.book.mockResolvedValue({ ok: false, reason: "slot_unavailable" });
    thread.linked = true;
    thread.stage = { ...thread.stage, bookingForOther: false };
    thread.collected = {
      department_id: DEPT_A,
      doctor_id: DOC_1,
      doctor_name: "Dr. Wren Halloway",
      appointment_date: "2026-08-31",
      appointment_time: "09:00",
    };
    const result = await thread.say("تمام");
    expect(result.outcome).toBe("booking_blocked");
    expect(thread.collected.appointment_time).toBeUndefined();
    // Everything above the time survives.
    expect(thread.collected.appointment_date).toBe("2026-08-31");
    expect(thread.collected.doctor_id).toBe(DOC_1);
    expect(result.text).not.toContain("الدكاترة المتاحين");
    expect(result.text).toContain("9:30 صباحًا");
    expect(result.text).not.toContain("09:30");
  });

  it("the 24-hour rule is a time problem, not a restart", async () => {
    mocks.book.mockResolvedValue({ ok: false, reason: "minimum_notice" });
    thread.linked = true;
    thread.stage = { ...thread.stage, bookingForOther: false };
    thread.collected = {
      department_id: DEPT_A,
      doctor_id: DOC_1,
      doctor_name: "Dr. Wren Halloway",
      appointment_date: "2026-08-31",
      appointment_time: "09:00",
    };
    const result = await thread.say("تمام");
    expect(result.outcome).toBe("booking_blocked");
    expect(thread.collected.doctor_id).toBe(DOC_1);
    expect(thread.collected.appointment_date).toBe("2026-08-31");
  });
});

// ---------------------------------------------------------------------------
// §5/§6 — the third-party intake preserves the booking target
// ---------------------------------------------------------------------------

describe("P11F §5/§6 · intake never erases the booking target", () => {
  const full = {
    department_id: DEPT_A,
    doctor_id: DOC_1,
    doctor_name: "Dr. Wren Halloway",
    appointment_date: "2026-08-31",
    appointment_time: "09:00",
  };

  it("asks for the missing intake fields and restates the target", async () => {
    thread.collected = { ...full };
    const result = await thread.say("تمام");
    expect(result.outcome).toBe("intake_required");
    expect(result.text).toContain("2026-08-31");
    expect(result.text).toContain("09:00");
    expect(result.text).toContain("Wren Halloway");
    expect(result.text).toContain("تاريخ الميلاد");
  });

  it("writes nothing at all while asking, so nothing can be cleared", async () => {
    thread.collected = { ...full };
    await thread.say("تمام");
    expect(mocks.setState).not.toHaveBeenCalled();
    expect(thread.collected).toEqual(full);
  });

  it("never touches the bookingForOther latch", async () => {
    thread.collected = { ...full };
    await thread.say("تمام");
    for (const call of mocks.recordStage.mock.calls) {
      expect(call[1]).not.toHaveProperty("bookingForOther");
    }
    expect(thread.stage.bookingForOther).toBe(true);
  });

  it("asks only for what is still missing", async () => {
    thread.collected = { ...full, full_name: "Omar Hassan", national_id: "303090876514" };
    const result = await thread.say("تمام");
    expect(result.text).toContain("تاريخ الميلاد");
    expect(result.text).toContain("البريد الإلكتروني");
    expect(result.text).not.toContain("الاسم الكامل");
    expect(result.text).not.toContain("رقم الهوية");
  });

  it("books with the preserved target once the intake is staged", async () => {
    thread.collected = { ...full };
    thread.stage = { ...thread.stage, intakeStaged: true };
    const result = await thread.say("تمام");
    expect(result.outcome).toBe("booking_created");
    expect(mocks.book).toHaveBeenCalledWith(
      expect.objectContaining({ doctorId: DOC_1, durationMinutes: 30 }),
    );
    // The instant handed to the booking engine is the chosen local slot.
    const call = mocks.book.mock.calls[0]![0] as { scheduledAt: string };
    expect(call.scheduledAt).toBe(new Date("2026-08-31T09:00:00+03:00").toISOString());
  });

  it("a booking blocked on intake asks for fields, never for a doctor", async () => {
    mocks.book.mockResolvedValue({ ok: false, reason: "intake_required" });
    thread.collected = { ...full };
    thread.stage = { ...thread.stage, intakeStaged: true };
    const result = await thread.say("تمام");
    expect(result.outcome).toBe("intake_required");
    expect(result.text).not.toContain("الدكاترة المتاحين");
  });
});

// ---------------------------------------------------------------------------
// §7 — generic for any department
// ---------------------------------------------------------------------------

describe("P11F §7 · the same flow for a department added tomorrow", () => {
  it("runs identically for two unrelated departments", async () => {
    const runs: string[][] = [];
    for (const [departmentId, departmentWord, doctorWord] of [
      [DEPT_A, "علاج طبيعي", "Wren"],
      [DEPT_B, "جلدية", "Perri"],
    ] as const) {
      thread = new Thread({ bookingForOther: true });
      mocks.setState.mockImplementation(async (args: { collected?: Record<string, string> }) => {
        thread.absorb(args.collected ?? null, null);
        return { error: null };
      });
      mocks.recordStage.mockImplementation(async (_i: unknown, patch: Record<string, unknown>) => {
        thread.absorb(null, patch);
        return null;
      });
      await thread.say(`عايز احجز في ${departmentWord}`);
      expect(thread.collected.department_id).toBe(departmentId);
      await thread.say(doctorWord);
      await thread.say("31");
      await thread.say("الساعه ٩ الصبح");
      runs.push([...thread.outcomes]);
    }
    expect(runs[0]).toEqual(runs[1]);
    expect(runs[0]).toEqual([
      "roster_offered",
      "doctor_selected",
      "day_selected",
      "intake_required",
    ]);
  });
});
