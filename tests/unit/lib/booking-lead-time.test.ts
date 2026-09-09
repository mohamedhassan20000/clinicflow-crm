/**
 * The online-booking lead-time rule, and the reads that are bound to it.
 *
 * Two layers, tested separately because they fail differently:
 *
 *   1. the rule itself (`lib/booking/lead-time.ts`) — pure calendar arithmetic
 *      in the clinic's timezone, which is where "not today, not tomorrow"
 *      either is or is not a property of the *day* rather than of the hour the
 *      patient happened to message at;
 *   2. the wiring (`lib/booking/patient.ts`, `lib/ai/v2/tools.ts`) — that every
 *      entry point into availability and every path to the write asks the rule,
 *      so there is no fifth caller quietly offering tomorrow.
 *
 * The defect this replaces: `now + 24 * 60 * 60 * 1000`, applied inside the
 * slot filter. At 09:00 that excluded tomorrow morning and *offered* tomorrow
 * afternoon; at 23:00 it offered almost all of the day after next. So the
 * clinic's actual rule was unrepresentable, and a patient could be shown a slot
 * the write would go on to refuse.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  ONLINE_BOOKING_LEAD_DAYS,
  bookableWindowStart,
  clinicToday,
  earliestOnlineBookableDate,
  earliestOnlineBookableInstant,
  isOnlineBookableDate,
  tooSoonReason,
} from "@/lib/booking/lead-time";

const CAIRO = "Africa/Cairo";

describe("the rule", () => {
  it("excludes today and tomorrow, and opens on the day after tomorrow", () => {
    const now = new Date("2026-09-05T09:00:00.000Z");
    expect(clinicToday(now, CAIRO)).toBe("2026-09-05");
    expect(earliestOnlineBookableDate(now, CAIRO)).toBe("2026-09-07");
    expect(isOnlineBookableDate("2026-09-05", now, CAIRO)).toBe(false);
    expect(isOnlineBookableDate("2026-09-06", now, CAIRO)).toBe(false);
    expect(isOnlineBookableDate("2026-09-07", now, CAIRO)).toBe(true);
    expect(isOnlineBookableDate("2026-09-30", now, CAIRO)).toBe(true);
  });

  it("is the same answer at one minute past midnight as at eleven at night", () => {
    // The property `now + 24h` did not have. A rolling duration moves the
    // boundary with the clock; a calendar floor does not.
    // Cairo is UTC+3 in September 2026, which is exactly the sort of detail a
    // hand-rolled offset gets wrong — both instants are stated in it.
    const early = new Date("2026-09-05T00:05:00.000+03:00");
    const late = new Date("2026-09-05T23:55:00.000+03:00");
    expect(earliestOnlineBookableDate(early, CAIRO)).toBe(
      earliestOnlineBookableDate(late, CAIRO),
    );
    expect(isOnlineBookableDate("2026-09-06", late, CAIRO)).toBe(false);
  });

  it("reads the calendar in the clinic's timezone, not the server's", () => {
    // 22:30 in Los Angeles is already the next day in Cairo, and the rule
    // belongs to the clinic.
    const now = new Date("2026-09-05T22:30:00.000Z");
    expect(clinicToday(now, "America/Los_Angeles")).toBe("2026-09-05");
    expect(clinicToday(now, CAIRO)).toBe("2026-09-06");
    expect(earliestOnlineBookableDate(now, CAIRO)).toBe("2026-09-08");
  });

  it("names why a date is too soon, and separates that from a date in the past", () => {
    const now = new Date("2026-09-05T09:00:00.000Z");
    expect(tooSoonReason("2026-09-04", now, CAIRO)).toBe("past");
    expect(tooSoonReason("2026-09-05", now, CAIRO)).toBe("today");
    expect(tooSoonReason("2026-09-06", now, CAIRO)).toBe("tomorrow");
    expect(tooSoonReason("2026-09-07", now, CAIRO)).toBeNull();
  });

  it("starts the search at the later of the floor and the patient's bound", () => {
    const now = new Date("2026-09-05T09:00:00.000Z");
    // No bound: the floor.
    expect(bookableWindowStart({ now, timeZone: CAIRO })).toBe("2026-09-07");
    // A bound behind the floor cannot walk the window backwards.
    expect(bookableWindowStart({ now, timeZone: CAIRO, after: "2026-09-01" })).toBe(
      "2026-09-07",
    );
    // A bound ahead of it moves the window, exclusively — "after the 11th"
    // opens on the 12th.
    expect(bookableWindowStart({ now, timeZone: CAIRO, after: "2026-09-11" })).toBe(
      "2026-09-12",
    );
  });

  it("keeps the floor as a calendar instant the slot filter can compare", () => {
    const now = new Date("2026-09-05T09:00:00.000Z");
    // Midnight on the 7th in Cairo (UTC+3 in September) is 21:00 UTC on the
    // 6th. Computing it in the server's zone instead would move the boundary by
    // hours for every host outside Egypt.
    expect(earliestOnlineBookableInstant(now, CAIRO).toISOString()).toBe(
      "2026-09-06T21:00:00.000Z",
    );
  });

  it("states the policy as one number", () => {
    expect(ONLINE_BOOKING_LEAD_DAYS).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------

const booking = vi.hoisted(() => ({
  getPatientAvailableDays: vi.fn(),
  getPatientAvailableSlots: vi.fn(),
  createPatientPendingBooking: vi.fn(),
}));

vi.mock("@/lib/booking/patient", () => booking);

const identity = vi.hoisted(() => ({
  authorizePatientConversation: vi.fn(),
}));

vi.mock("@/lib/ai/patient-authorization", () => identity);

vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: vi.fn(),
  getPatientClinicPublicInfo: vi.fn(async () => ({ data: null })),
  getClinicCurrency: vi.fn(async () => null),
  findClinicPatientByIdentity: vi.fn(),
  // The RPC's real shape. It returns a `status` row and signals most of its
  // outcomes there rather than as an error, so a fixture that carries only
  // `error: null` cannot represent the difference between a staging that
  // happened and one that did not — see `stageIntake`.
  stagePatientIntakeFromConversation: vi.fn(async () => ({
    error: null,
    data: [{ status: "staged", intake_id: "intake-1", attempts_remaining: null }],
  })),
  createPatientPreliminaryBookingWithPackage: vi.fn(),
  cancelPatientAiAppointment: vi.fn(),
  listClinicPublicPackages: vi.fn(),
  listPatientAiDocuments: vi.fn(),
  listPatientAiPackages: vi.fn(),
  signClinicDocumentUrl: vi.fn(),
  listPatientAiAppointments: vi.fn(),
  preparePatientAiReschedule: vi.fn(),
  reschedulePatientAiAppointment: vi.fn(),
  searchPatientClinicFaq: vi.fn(),
}));

import {
  classifyBookingFailure,
  commitBooking,
  readAvailableDays,
  readAvailableSlots,
  stageIntake,
} from "@/lib/ai/v2/tools";
import type { TurnContext } from "@/lib/ai/v2/context";

const NOW = new Date("2026-09-05T09:00:00.000Z");

function context(): TurnContext {
  return {
    clinicId: "clinic-1",
    conversationId: "conv-1",
    turn: { text: "", receivedAt: NOW.toISOString(), locale: "ar", attachments: [] },
    episode: { turns: [] },
    flows: { version: 1, stack: [] },
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
    patientId: "patient-1",
    clinic: {
      name: "Clinic",
      timeZone: CAIRO,
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
  } as unknown as TurnContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  identity.authorizePatientConversation.mockResolvedValue({
    clinicId: "clinic-1",
    conversationId: "conv-1",
    clinicTimezone: CAIRO,
    linked: true,
    patientId: "patient-1",
    collectedData: {},
  });
  booking.getPatientAvailableDays.mockResolvedValue({
    ok: true,
    doctorId: "doc-1",
    doctorName: "Youssef Adel",
    availableDays: [],
    minimumNoticeHours: 24,
  });
  booking.getPatientAvailableSlots.mockResolvedValue({
    ok: true,
    doctorId: "doc-1",
    doctorName: "Youssef Adel",
    date: "2026-09-07",
    availableSlots: ["09:00"],
    availabilityReason: "available",
    workingHours: [],
  });
  booking.createPatientPendingBooking.mockResolvedValue({
    ok: true,
    appointmentId: "appt-1",
    expiresAt: NOW.toISOString(),
    provisional: false,
  });
});

describe("every availability read starts at the floor", () => {
  it("never searches today or tomorrow", async () => {
    await readAvailableDays({ context: context(), doctorId: "doc-1" });
    expect(booking.getPatientAvailableDays).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: "2026-09-07", now: NOW }),
    );
  });

  it("moves the window past a bound the patient set, and never behind the floor", async () => {
    await readAvailableDays({ context: context(), doctorId: "doc-1", after: "2026-09-11" });
    expect(booking.getPatientAvailableDays).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: "2026-09-12" }),
    );

    booking.getPatientAvailableDays.mockClear();
    await readAvailableDays({ context: context(), doctorId: "doc-1", after: "2026-08-20" });
    expect(booking.getPatientAvailableDays).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: "2026-09-07" }),
    );
  });

  it("still filters by real working days and real availability after the floor", async () => {
    // The floor says "not before the 7th". It does not say "the 7th": the
    // doctor may not work that day, and the days that come back are whichever
    // ones the calendar actually had slots on.
    booking.getPatientAvailableDays.mockResolvedValue({
      ok: true,
      doctorId: "doc-1",
      doctorName: "Youssef Adel",
      availableDays: [
        { date: "2026-09-09", slotCount: 4 },
        { date: "2026-09-13", slotCount: 2 },
      ],
      minimumNoticeHours: 24,
    });
    const result = await readAvailableDays({ context: context(), doctorId: "doc-1" });
    expect(result.ok).toBe(true);
    expect(result.ok ? result.days.map((day) => day.value) : []).toEqual([
      "2026-09-09",
      "2026-09-13",
    ]);
    // The search still began at the floor; the gap is the doctor's schedule.
    expect(booking.getPatientAvailableDays).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: "2026-09-07" }),
    );
  });

  it("has no times on a day the rule excludes, whichever caller asks", async () => {
    const result = await readAvailableSlots({
      context: context(),
      doctorId: "doc-1",
      date: "2026-09-06",
    });
    expect(result).toEqual({ ok: true, times: [] });
    // The calendar was not even consulted: the day is not offerable.
    expect(booking.getPatientAvailableSlots).not.toHaveBeenCalled();
  });

  it("reads the calendar normally for a day the rule allows", async () => {
    const result = await readAvailableSlots({
      context: context(),
      doctorId: "doc-1",
      date: "2026-09-07",
    });
    expect(result.ok).toBe(true);
    expect(booking.getPatientAvailableSlots).toHaveBeenCalled();
  });
});

describe("the write revalidates the same invariant", () => {
  it("refuses a too-soon date without calling the booking path at all", async () => {
    const result = await commitBooking({
      context: context(),
      doctorId: "doc-1",
      date: "2026-09-06",
      time: "10:00",
      durationMinutes: 30,
      forThirdParty: false,
    });
    expect(result).toEqual({ ok: false, reason: "lead_time" });
    expect(booking.createPatientPendingBooking).not.toHaveBeenCalled();
  });

  it("commits a date the rule allows", async () => {
    const result = await commitBooking({
      context: context(),
      doctorId: "doc-1",
      date: "2026-09-09",
      time: "10:00",
      durationMinutes: 30,
      forThirdParty: false,
    });
    expect(result.ok).toBe(true);
    expect(booking.createPatientPendingBooking).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a repeated confirmation reports the existing request, never a conflict", async () => {
    booking.createPatientPendingBooking.mockResolvedValue({
      ok: false,
      reason: "patient_pending_cap",
    });
    const result = await commitBooking({
      context: context(),
      doctorId: "doc-1",
      date: "2026-09-09",
      time: "10:00",
      durationMinutes: 30,
      forThirdParty: false,
    });
    // Not `slot_taken`. Nothing was created and nothing was lost — this is the
    // database's one-pending-per-patient rule doing exactly its job.
    expect(result).toEqual({ ok: false, reason: "already_pending" });
  });

  it("separates a genuinely contended slot from every other failure", () => {
    expect(classifyBookingFailure("slot_unavailable")).toBe("slot_taken");
    expect(classifyBookingFailure("slot_pending_cap")).toBe("slot_taken");
    expect(classifyBookingFailure("AI_BOOKING_SLOT_UNAVAILABLE")).toBe("slot_taken");
    expect(classifyBookingFailure("minimum_notice")).toBe("lead_time");
    expect(classifyBookingFailure("AI_BOOKING_MINIMUM_NOTICE")).toBe("lead_time");
    expect(classifyBookingFailure("patient_pending_cap")).toBe("already_pending");
    expect(classifyBookingFailure("AI_PENDING_PATIENT_CAP")).toBe("already_pending");
    expect(classifyBookingFailure("intake_required")).toBe("not_ready");
    expect(classifyBookingFailure("create_failed")).toBe("failed");
  });
});

describe("a third party's file never inherits the sender's number", () => {
  it("refuses to stage a third-party intake with no phone of its own", async () => {
    const result = await stageIntake({
      context: context(),
      fullName: "Gehad Mohamed",
      nationalId: "29001012345678",
      dateOfBirth: "1990-03-15",
      email: "gehad@example.com",
      departmentId: "dept-1",
      doctorId: "doc-1",
      forThirdParty: true,
      phone: null,
    });
    // The RPC's own fallback is `conversations.participant_address` — the
    // sender's WhatsApp number. Refusing here is what makes that unreachable.
    expect(result).toEqual({ ok: false, reason: "third_party_phone_required" });
  });

  it("passes the number the patient actually gave", async () => {
    const admin = await import("@/lib/supabase/admin");
    await stageIntake({
      context: context(),
      fullName: "Gehad Mohamed",
      nationalId: "29001012345678",
      dateOfBirth: "1990-03-15",
      email: "gehad@example.com",
      departmentId: "dept-1",
      doctorId: "doc-1",
      forThirdParty: true,
      phone: "+201002003040",
    });
    expect(admin.stagePatientIntakeFromConversation).toHaveBeenCalledWith(
      expect.objectContaining({ forThirdParty: true, phone: "+201002003040" }),
    );
  });

  it("leaves a self-booking's phone semantics alone", async () => {
    const admin = await import("@/lib/supabase/admin");
    const result = await stageIntake({
      context: context(),
      fullName: "Anas Talal",
      nationalId: "29001012345678",
      dateOfBirth: "1990-03-15",
      email: "anas@example.com",
      departmentId: "dept-1",
      doctorId: "doc-1",
      forThirdParty: false,
      phone: null,
    });
    expect(result.ok).toBe(true);
    expect(admin.stagePatientIntakeFromConversation).toHaveBeenCalledWith(
      expect.objectContaining({ forThirdParty: false, phone: null }),
    );
  });
});
