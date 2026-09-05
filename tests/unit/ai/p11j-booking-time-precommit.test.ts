import { beforeEach, describe, expect, it, vi } from "vitest";

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const DEPARTMENT = "33333333-3333-4333-8333-333333333333";
const DOCTOR = "44444444-4444-4444-8444-444444444444";
const DATE = "2026-08-31";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  setState: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: mocks.audit }));
vi.mock("@/lib/ai/patient-authorization", async (original) => {
  const actual = await original<typeof import("@/lib/ai/patient-authorization")>();
  return { ...actual, authorizePatientConversation: mocks.authorize };
});
vi.mock("@/lib/supabase/admin", () => ({
  setConversationAiState: mocks.setState,
  resolvePatientAiContext: vi.fn(),
}));

import { EMPTY_BOOKING_STAGE_STATE } from "@/lib/ai/booking-stage";
import { openBookingStageTurn } from "@/lib/ai/booking-stage-store";
import { enforcePatientFactReply } from "@/lib/ai/patient-fact-reply";
import { createGroundingLedger } from "@/lib/ai/patient-grounding";

function identity() {
  return {
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    patientId: null,
    linked: false,
    identityVerifiedAt: null,
    bookingIdentityConfirmedAt: null,
    identityLockedUntil: null,
    patientDisplayName: null,
    patientNationalIdSuffix: null,
    clinicName: "Generated Test Clinic",
    clinicLocale: "ar" as const,
    clinicTimezone: "Africa/Cairo",
    clinicCountry: "EG",
    participantAddress: "+201000000000",
    aiPaused: false,
    collectedData: {
      department_id: DEPARTMENT,
      doctor_id: DOCTOR,
      doctor_name: "Generated Doctor",
      appointment_date: DATE,
    },
    pendingClarification: null,
    bookingStage: {
      ...EMPTY_BOOKING_STAGE_STATE,
      stage: "intake_collecting" as const,
      offeredSlots: [`${DATE}T09:00`, `${DATE}T09:30`],
    },
    communicationStyle: {
      locale: "ar" as const,
      arabicDialect: "egyptian" as const,
      tone: "friendly" as const,
      styleInstruction: null,
    },
  };
}

const ctx = {
  clinicId: CLINIC,
  conversationId: CONVERSATION,
  locale: "ar" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(identity());
  mocks.setState.mockResolvedValue({ data: null, error: null });
  mocks.audit.mockResolvedValue(undefined);
});

describe("P11J · an offered time is committed before tool authority is computed", () => {
  it("replays the exact Arabic 9 AM turn and advances to intake", async () => {
    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "الساعه ٩ الصبح",
      conversationEscalated: false,
    });

    expect(mocks.setState).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicId: CLINIC,
        conversationId: CONVERSATION,
        collected: { appointment_time: 540 },
      }),
    );
    expect(turn.authority).toMatchObject({
      operation: "register_patient",
      reason: "needs_intake",
    });
    expect(turn.authority?.operation).not.toBe("check_availability");
  });

  it("does not advance when the time write is rejected", async () => {
    mocks.setState.mockImplementation(async (input: { collected?: unknown }) =>
      input.collected
        ? { data: null, error: { message: "write rejected" } }
        : { data: null, error: null },
    );

    const turn = await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "الساعه ٩ الصبح",
      conversationEscalated: false,
    });

    expect(turn.authority).toMatchObject({
      operation: null,
      reason: "committed_slots",
    });
    expect(turn.authority?.operation).not.toBe("register_patient");
  });

  it("does not interpret a question or unrelated intake message as a time", async () => {
    for (const text of [
      "هل فتحت لي ملف باسمي وحجزت الموعد؟",
      "اسمي كامل ورقم الهوية موجودين هنا",
    ]) {
      vi.clearAllMocks();
      mocks.authorize.mockResolvedValue(identity());
      mocks.setState.mockResolvedValue({ data: null, error: null });
      mocks.audit.mockResolvedValue(undefined);
      const turn = await openBookingStageTurn(ctx, "patient_booking", {
        latestPatientText: text,
        conversationEscalated: false,
      });
      expect(
        mocks.setState.mock.calls.some(
          ([input]) => (input as { collected?: unknown }).collected !== undefined,
        ),
      ).toBe(false);
      expect(turn.authority).toMatchObject({
        operation: null,
        reason: "committed_slots",
      });
      expect(turn.authority?.operation).not.toBe("register_patient");
    }
  });
});

describe("P11J · live choice and clinic-fact receipts own the patient layout", () => {
  it("renders available days and times as separate localized lines", () => {
    const dayLedger = createGroundingLedger();
    dayLedger.record("list_available_days", {
      ok: true,
      doctor_name: "Generated Doctor",
      availableDays: [{ date: "2026-08-31" }, { date: "2026-09-01" }],
    });
    const days = enforcePatientFactReply({ locale: "ar", text: "ignored", ledger: dayLedger });
    expect(days.outcome).toBe("available_days");
    expect(days.text).toContain("- الاثنين، ٣١ أغسطس ٢٠٢٦");
    expect(days.text).toContain("- الثلاثاء، ١ سبتمبر ٢٠٢٦");
    expect(days.text).not.toContain("2026-");

    const timeLedger = createGroundingLedger();
    timeLedger.record("check_availability", {
      ok: true,
      date: "2026-08-31",
      doctor_name: "Generated Doctor",
      availableSlots: ["09:00", "14:30"],
    });
    const times = enforcePatientFactReply({ locale: "ar", text: "ignored", ledger: timeLedger });
    expect(times.outcome).toBe("available_times");
    expect(times.text).toContain("- 9:00 صباحًا");
    expect(times.text).toContain("- 2:30 مساءً");
    expect(times.text).not.toContain("09:00");
    expect(times.text).not.toContain("14:30");
  });

  it("renders departments and doctors vertically from the live roster receipt", () => {
    const departments = createGroundingLedger();
    departments.record("prepare_booking", {
      needs_selection: true,
      field: "department",
      departments: [
        { id: "d1", name: "Unit A" },
        { id: "d2", name: "Unit B" },
      ],
    });
    const departmentReply = enforcePatientFactReply({
      locale: "en",
      text: "invented horizontal list",
      ledger: departments,
    });
    expect(departmentReply.text).toContain("1. Unit A\n2. Unit B");

    const doctors = createGroundingLedger();
    doctors.record("list_doctors", {
      needs_selection: true,
      field: "doctor",
      department: { id: "d1", name: "Unit A" },
      doctors: [
        { id: "p1", name: "Aster Vale" },
        { id: "p2", name: "Mira Sol" },
      ],
    });
    const doctorReply = enforcePatientFactReply({
      locale: "en",
      text: "invented horizontal list",
      ledger: doctors,
    });
    expect(doctorReply.text).toContain("1. Aster Vale\n2. Mira Sol");
  });

  it("uses the exact services selection question and prints all prices line by line", () => {
    const selection = createGroundingLedger();
    selection.record("list_department_services", {
      needs_selection: true,
      departments: [{ name: "Unit A" }, { name: "Unit B" }],
    });
    expect(
      enforcePatientFactReply({ locale: "ar", text: "ignored", ledger: selection }).text,
    ).toBe("تحب تعرف خدمات أنهي قسم؟\n- Unit A\n- Unit B");

    const all = createGroundingLedger();
    all.record("list_department_services", {
      found: true,
      scope: "all_departments",
      departments: [
        {
          name: "Unit A",
          services: [
            { name: "Consultation", price: 300, currency: "EGP" },
            { name: "Follow-up", price: null, currency: "EGP" },
          ],
        },
      ],
    });
    const reply = enforcePatientFactReply({ locale: "en", text: "ignored", ledger: all });
    expect(reply.text).toContain("Consultation — 300 EGP\nFollow-up — Price unavailable");
  });

  it("never lets a read list replace a write receipt on the same turn", () => {
    const ledger = createGroundingLedger();
    ledger.record("check_availability", {
      ok: true,
      date: "2026-08-31",
      availableSlots: ["09:00"],
    });
    ledger.record("create_preliminary_booking", { created: false, reason: "slot_unavailable" });
    expect(
      enforcePatientFactReply({ locale: "en", text: "write copy", ledger }),
    ).toEqual({ text: "write copy", outcome: "passthrough" });
  });
});
