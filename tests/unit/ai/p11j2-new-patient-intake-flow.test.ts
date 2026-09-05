/**
 * P11J-2 — the manual-QA regression, driven end to end.
 *
 * The failing conversation had already got everything right: the department was
 * chosen, the doctor was chosen, the day and the time were chosen. Only the
 * patient file was missing. At that point the assistant said, to a real patient,
 * in Arabic:
 *
 *   "أحتاج تصحيح أو استكمال البيانات التالية فقط (national_id, date_of_birth, phone)."
 *
 * and then said it again, and again. These tests walk that same conversation:
 * the details the booking already established are not asked for a second time,
 * the details that are genuinely missing are asked for as questions rather than
 * listed as schema keys, the optional ones can be skipped without a loop, the
 * intake stages against the server's own receipt, and the pending appointment
 * request follows from it — in both Arabic and English.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "763b1c6b-c388-4f36-b8ca-965f71f20f86";
const DERMATOLOGY = "dddddddd-0000-4000-8000-000000000001";
const NABIL = "aaaaaaaa-0000-4000-8000-000000000001";
const INTAKE = "eeeeeeee-0000-4000-8000-000000000001";
const APPOINTMENT = "cccccccc-0000-4000-8000-000000000001";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  directory: vi.fn(),
  persist: vi.fn(),
  clinicInfo: vi.fn(),
  stageIntake: vi.fn(),
  pendingIntake: vi.fn(),
  createBooking: vi.fn(),
  availableSlots: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/ai/patient-authorization", async (original) => {
  const actual = await original<typeof import("@/lib/ai/patient-authorization")>();
  return { ...actual, authorizePatientConversation: mocks.authorize };
});
vi.mock("@/lib/supabase/admin", () => ({
  setConversationAiState: mocks.persist,
  getPatientClinicPublicInfo: mocks.clinicInfo,
  stagePatientIntakeFromConversation: mocks.stageIntake,
  getPendingConversationIntake: mocks.pendingIntake,
  resolvePatientAiContext: vi.fn(),
  createClinicScopedAdminClient: () => {
    throw new Error("no table access is expected on these paths");
  },
}));
vi.mock("@/lib/ai/doctor-directory", async (original) => {
  const actual = await original<typeof import("@/lib/ai/doctor-directory")>();
  return { ...actual, loadDoctorDirectory: mocks.directory };
});
vi.mock("@/lib/booking/patient", () => ({
  createPatientPendingBooking: mocks.createBooking,
  getPatientAvailableSlots: mocks.availableSlots,
  getPatientAvailableDays: vi.fn(),
}));

import { EMPTY_BOOKING_STAGE_STATE, offeredSlotKey } from "@/lib/ai/booking-stage";
import { resolveBookingAuthority } from "@/lib/ai/booking-authority";
import { createGroundingLedger } from "@/lib/ai/patient-grounding";
import { enforcePatientWriteReply } from "@/lib/ai/patient-write-commit";
import { containsInternalFieldName } from "@/lib/ai/patient-intake-contract";
import { registerPatientTool } from "@/lib/ai/tools/register-patient";
import { createPreliminaryBookingTool } from "@/lib/ai/tools/create-preliminary-booking";

const opts = {} as never;

/** Every identifier that must never survive to a patient's WhatsApp thread. */
const FORBIDDEN_IDENTIFIERS = [
  "national_id",
  "date_of_birth",
  "phone",
  "blood_type",
  "department_id",
  "doctor_id",
  "missing_fields",
] as const;

/**
 * What the patient would actually have read, given this tool result.
 *
 * The regression was not in the model — it was in this boundary, which owns the
 * final sentence on every write turn. Asserting on the model's draft would have
 * missed it entirely, so the assertions run on what this returns.
 */
function patientVisibleReply(
  locale: "ar" | "en",
  toolResult: Record<string, unknown>,
  draft = "…",
): string {
  const ledger = createGroundingLedger();
  ledger.record("register_patient", toolResult);
  return enforcePatientWriteReply({
    locale,
    text: draft,
    authority: resolveBookingAuthority({
      step: "intake",
      collected: {},
      offeredDoctorIds: [],
      offeredDays: [],
      offeredSlots: [],
      closing: false,
      terminal: false,
    }),
    ledger,
  }).text;
}

function expectPatientSafe(text: string, locale: "ar" | "en") {
  for (const token of FORBIDDEN_IDENTIFIERS) {
    // "phone" is a real English word; it is only forbidden as a bare identifier,
    // which is what `containsInternalFieldName` decides. Underscored keys are
    // forbidden outright.
    if (!token.includes("_")) continue;
    expect(text, `patient-visible copy leaked ${token}`).not.toContain(token);
  }
  expect(text).not.toMatch(/[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9]+/);
  expect(containsInternalFieldName(text, locale)).toBe(false);
}

/**
 * The stranger from the failing conversation: not linked to any patient record,
 * with the department, doctor, day and time already settled by the booking flow
 * that ran before intake began.
 */
function stranger(overrides: Record<string, unknown> = {}) {
  return {
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    patientId: null,
    linked: false,
    identityVerifiedAt: null,
    identityLockedUntil: null,
    clinicName: "ClinicFlow",
    clinicLocale: "ar" as const,
    clinicTimezone: "Africa/Cairo",
    clinicCountry: "EG",
    participantAddress: "+201000000000",
    aiPaused: false,
    collectedData: {
      department_id: DERMATOLOGY,
      doctor_id: NABIL,
      appointment_date: "2026-08-30",
    },
    pendingClarification: null,
    bookingStage: {
      ...EMPTY_BOOKING_STAGE_STATE,
      // The blood-type step is settled for these fixtures: it is asked once
      // before a new file is staged (see
      // `tests/unit/ai/new-patient-intake-name-and-blood-type.test.ts`), and it
      // is not what any assertion in this file is about.
      bloodTypeResolved: true,
      offeredDoctorIds: [NABIL],
      offeredDays: ["2026-08-30"],
      offeredSlots: [offeredSlotKey("2026-08-30", "10:00")],
    },
    ...overrides,
  };
}

const NEW_PATIENT = {
  full_name: "Omar Adel",
  national_id: "29901012345678",
  date_of_birth: "24,3,2001",
  email: "omar.adel@example.com",
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AI_PATIENT_STAGE_ORCHESTRATION;
  mocks.persist.mockResolvedValue({ data: null, error: null });
  mocks.pendingIntake.mockResolvedValue({ data: null, error: null });
  mocks.clinicInfo.mockResolvedValue({ data: { phone: null }, error: null });
  mocks.directory.mockResolvedValue({
    departments: [{ id: DERMATOLOGY, name: "Dermatology" }],
    doctors: [
      {
        id: NABIL,
        name: "Ahmed Nabil",
        departmentId: DERMATOLOGY,
        departmentName: "Dermatology",
        state: "available",
        unavailableUntil: null,
      },
    ],
  });
  mocks.stageIntake.mockResolvedValue({
    data: [{ status: "staged", intake_id: INTAKE, attempts_remaining: null }],
    error: null,
  });
  mocks.availableSlots.mockResolvedValue({
    ok: true,
    doctorId: NABIL,
    doctorName: "Ahmed Nabil",
    date: "2026-08-30",
    availableSlots: ["10:00"],
    availabilityReason: "open",
    workingHours: [],
  });
  mocks.createBooking.mockResolvedValue({
    ok: true,
    appointmentId: APPOINTMENT,
    expiresAt: "2026-08-30T09:00:00.000Z",
    provisional: true,
  });
});

for (const locale of ["ar", "en"] as const) {
  const ctx = { clinicId: CLINIC, conversationId: CONVERSATION, locale };

  describe(`P11J-2 · new-patient intake, end to end (${locale})`, () => {
    it("asks a question instead of listing schema keys when details are missing", async () => {
      mocks.authorize.mockResolvedValue(stranger());

      // The patient has said they want to book, and nothing else about
      // themselves. This is the turn that produced the leaked sentence.
      const result = (await registerPatientTool(ctx).execute!(
        {},
        opts,
      )) as Record<string, unknown>;

      expect(result.registered).toBe(false);
      expect(result.reason).toBe("unreadable_fields");
      // The model still gets the identifiers — it needs them to reason.
      expect(result.fields).toEqual(
        expect.arrayContaining(["full_name", "national_id", "email", "date_of_birth"]),
      );
      // But the sender's phone is never among them: it is channel-owned.
      expect(result.fields).not.toContain("phone");
      // And a ready-made, identifier-free question comes with it.
      expect(typeof result.patient_question).toBe("string");
      expectPatientSafe(result.patient_question as string, locale);

      const reply = patientVisibleReply(locale, result);
      expectPatientSafe(reply, locale);
      expect(reply).toMatch(/[?؟]/);
    });

    it("never re-asks the department or the doctor the booking already chose", async () => {
      mocks.authorize.mockResolvedValue(stranger());

      const result = (await registerPatientTool(ctx).execute!(
        NEW_PATIENT,
        opts,
      )) as Record<string, unknown>;

      // Straight to staged: assignment came from the conversation's own state,
      // and nothing about a department or a doctor was asked.
      expect(result.reason).not.toBe("assignment_required");
      expect(result.intake_staged).toBe(true);
      expect(mocks.stageIntake).toHaveBeenCalledWith(
        expect.objectContaining({ departmentId: DERMATOLOGY, doctorId: NABIL }),
      );
    });

    it("reads a comma-written date of birth and stages the canonical value", async () => {
      mocks.authorize.mockResolvedValue(stranger());

      await registerPatientTool(ctx).execute!(NEW_PATIENT, opts);

      expect(mocks.stageIntake).toHaveBeenCalledWith(
        expect.objectContaining({ dateOfBirth: "2001-03-24" }),
      );
    });

    it("completes without a blood type, and says nothing about one", async () => {
      mocks.authorize.mockResolvedValue(stranger());

      const result = (await registerPatientTool(ctx).execute!(
        NEW_PATIENT,
        opts,
      )) as Record<string, unknown>;

      expect(result.intake_staged).toBe(true);
      expect(mocks.stageIntake).toHaveBeenCalledWith(
        expect.not.objectContaining({ bloodType: expect.anything() }),
      );
      expectPatientSafe(patientVisibleReply(locale, result), locale);
    });

    it("only claims the file is staged once the server returns the intake id", async () => {
      mocks.authorize.mockResolvedValue(stranger());

      const result = (await registerPatientTool(ctx).execute!(
        NEW_PATIENT,
        opts,
      )) as Record<string, unknown>;

      expect(result.intake_id).toBe(INTAKE);
      expect(result.awaiting_staff_review).toBe(true);
      // Not "registered" — a staged file is not a patient record.
      expect(result.registered).toBe(false);

      const reply = patientVisibleReply(locale, result, "تم إنشاء ملفك وحجز موعدك!");
      expectPatientSafe(reply, locale);
      expect(reply).toMatch(locale === "ar" ? /مراجعة/ : /review/i);
    });

    it("carries the same department, doctor, day and time into a pending request", async () => {
      mocks.authorize.mockResolvedValue(
        stranger({ bookingStage: { ...stranger().bookingStage, intakeStaged: true } }),
      );
      mocks.pendingIntake.mockResolvedValue({
        data: { id: INTAKE, department_id: DERMATOLOGY, doctor_id: NABIL },
        error: null,
      });

      const result = (await createPreliminaryBookingTool(ctx).execute!(
        { date: "2026-08-30", time: "10:00", duration_minutes: 30 },
        opts,
      )) as Record<string, unknown>;

      expect(result.created).toBe(true);
      expect(result.status).toBe("pending");
      // The doctor the booking already chose, and a subject that is the staged
      // intake rather than any patient record — the sender has none.
      const [call] = mocks.createBooking.mock.calls[0] as [Record<string, unknown>];
      expect(call.doctorId).toBe(NABIL);
      expect(call.scheduledAt).toBe("2026-08-30T07:00:00.000Z");
      expect((call.identity as Record<string, unknown>).patientId).toBeNull();
      expect((call.identity as Record<string, unknown>).linked).toBe(false);
    });

    it("hands the file to staff rather than asking a fourth time", async () => {
      // Two identical asks already on record; this call is the third.
      mocks.authorize.mockResolvedValue(
        stranger({
          bookingStage: {
            ...stranger().bookingStage,
            intakeAsk: {
              signature: "date_of_birth,email,full_name,national_id",
              repeats: 2,
            },
          },
        }),
      );

      const result = (await registerPatientTool(ctx).execute!(
        {},
        opts,
      )) as Record<string, unknown>;

      expect(result.reason).toBe("intake_repeated_question");
      expect(result.fields).toBeUndefined();
      const reply = patientVisibleReply(locale, result);
      expectPatientSafe(reply, locale);
      // The guard's whole job: stop asking.
      expect(reply).not.toMatch(/[?؟]/);
    });

    it("uses an existing patient rather than staging a second file for them", async () => {
      mocks.authorize.mockResolvedValue(stranger());
      mocks.stageIntake.mockResolvedValue({
        data: [{ status: "linked_existing", intake_id: null, attempts_remaining: null }],
        error: null,
      });

      const result = (await registerPatientTool(ctx).execute!(
        NEW_PATIENT,
        opts,
      )) as Record<string, unknown>;

      expect(result.registered).toBe(true);
      expect(result.matched_existing).toBe(true);
      expect(result.intake_staged).toBeUndefined();
      expectPatientSafe(patientVisibleReply(locale, result), locale);
    });

    it("says nothing about which detail matched when identity needs staff review", async () => {
      mocks.authorize.mockResolvedValue(stranger());
      mocks.stageIntake.mockResolvedValue({
        data: [{ status: "identity_mismatch", intake_id: null, attempts_remaining: 2 }],
        error: null,
      });

      const result = (await registerPatientTool(ctx).execute!(
        NEW_PATIENT,
        opts,
      )) as Record<string, unknown>;

      expect(result.reason).toBe("needs_staff_review");
      const reply = patientVisibleReply(locale, result);
      expectPatientSafe(reply, locale);
      expect(reply).not.toContain(NEW_PATIENT.national_id);
    });
  });
}
