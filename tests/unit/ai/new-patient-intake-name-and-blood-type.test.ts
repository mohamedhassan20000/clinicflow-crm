/**
 * The two new-patient intake steps manual QA found broken.
 *
 * 1. An Arabic name was transliterated and the *proposal was never shown*: the
 *    refusal copy said the spelling needed confirming without naming it, so
 *    there was nothing for the patient to answer.
 * 2. Blood type was skipped altogether — optional on the schema, and therefore
 *    never asked.
 *
 * Both are now deterministic on both sides: the server composes the question and
 * the server reads the answer. The model is not in the loop for either.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const INTAKE = "33333333-3333-4333-8333-333333333333";
const DOCTOR = "44444444-4444-4444-8444-444444444444";
const DEPARTMENT = "55555555-5555-4555-8555-555555555555";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  persist: vi.fn(),
  stageIntake: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: mocks.audit }));
vi.mock("@/lib/ai/patient-authorization", async (original) => {
  const actual = await original<typeof import("@/lib/ai/patient-authorization")>();
  return { ...actual, authorizePatientConversation: mocks.authorize };
});
vi.mock("@/lib/supabase/admin", () => ({
  setConversationAiState: mocks.persist,
  stagePatientIntakeFromConversation: mocks.stageIntake,
  resolvePatientAiContext: vi.fn(),
  getPendingConversationIntake: vi.fn().mockResolvedValue({ data: null, error: null }),
}));
vi.mock("@/lib/booking/patient", () => ({ getPatientAvailableSlots: vi.fn() }));

import { EMPTY_BOOKING_STAGE_STATE } from "@/lib/ai/booking-stage";
import { openBookingStageTurn } from "@/lib/ai/booking-stage-store";
import { registerPatientTool } from "@/lib/ai/tools/register-patient";
import { enforcePatientWriteReply } from "@/lib/ai/patient-write-commit";
import { createGroundingLedger } from "@/lib/ai/patient-grounding";

const opts = {} as never;
const ctx = { clinicId: CLINIC, conversationId: CONVERSATION, locale: "ar" as const };
const ARABIC_NAME = "أنس طلال عبدالمقصود علي";

function identity(overrides: Record<string, unknown> = {}) {
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
    clinicName: "Clinic",
    clinicLocale: "ar" as const,
    clinicTimezone: "Africa/Cairo",
    clinicCountry: "EG",
    participantAddress: "+201000000000",
    aiPaused: false,
    collectedData: { department_id: DEPARTMENT, doctor_id: DOCTOR },
    pendingClarification: null,
    bookingStage: EMPTY_BOOKING_STAGE_STATE,
    communicationStyle: {
      locale: "ar" as const,
      arabicDialect: "egyptian" as const,
      tone: "friendly" as const,
      styleInstruction: null,
    },
    ...overrides,
  };
}

const DETAILS = {
  national_id: "29009120123456",
  date_of_birth: "12 September 2000",
  email: "anas@example.com",
};

function stageWrites() {
  return mocks.persist.mock.calls
    .map(([input]) => input as { collected?: Record<string, unknown>; stage?: Record<string, unknown> })
    .filter((input) => input.stage)
    .map((input) => input.stage!);
}

function collectedWrites() {
  return mocks.persist.mock.calls
    .map(([input]) => (input as { collected?: Record<string, unknown> }).collected)
    .filter(Boolean) as Record<string, unknown>[];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(identity());
  mocks.persist.mockResolvedValue({ data: null, error: null });
  mocks.audit.mockResolvedValue(undefined);
  mocks.stageIntake.mockResolvedValue({
    data: [{ status: "staged", intake_id: INTAKE }],
    error: null,
  });
});

describe("the Arabic name is proposed in English and confirmed before it is filed", () => {
  it("shows the proposed spelling and files nothing", async () => {
    const result = (await registerPatientTool(ctx).execute!(
      { full_name: ARABIC_NAME, ...DETAILS },
      opts,
    )) as Record<string, unknown>;

    expect(result.reason).toBe("name_spelling_confirmation_required");
    expect(result.needs_clarification).toBe(true);
    const proposed = String(result.proposed_name);
    expect(proposed).toMatch(/^[A-Za-z' -]+$/);
    expect(String(result.patient_question)).toContain(proposed);
    expect(mocks.stageIntake).not.toHaveBeenCalled();
    // The proposal is remembered, so the answer has something to resolve against.
    expect(stageWrites().at(-1)).toMatchObject({
      pendingNameConfirmation: { proposed, original: ARABIC_NAME },
    });
  });

  it("puts that exact question in front of the patient, not a failure notice", () => {
    const ledger = createGroundingLedger();
    ledger.record("register_patient", {
      registered: false,
      needs_clarification: true,
      reason: "name_spelling_confirmation_required",
      patient_question: "تمام، هكتب الاسم بالإنجليزي كده:\nAnas Talal Ali\nهل الكتابة صحيحة؟",
    });
    const enforced = enforcePatientWriteReply({
      locale: "ar",
      text: "…",
      authority: null,
      ledger,
    });
    expect(enforced.outcome).toBe("clarification");
    expect(enforced.text).toContain("Anas Talal Ali");
  });

  it("saves the proposal exactly when the patient confirms", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          pendingNameConfirmation: { proposed: "Anas Talal Ali", original: ARABIC_NAME },
        },
      }),
    );
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "تمام",
      conversationEscalated: false,
    });
    expect(collectedWrites()).toContainEqual({ full_name: "Anas Talal Ali" });
    expect(stageWrites().at(-1)).toMatchObject({ nameSpellingConfirmed: true });
  });

  it("takes the patient's corrected spelling as authoritative", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          pendingNameConfirmation: { proposed: "Anas Talal Ali", original: ARABIC_NAME },
        },
      }),
    );
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "خليه Anas Talal Abdel Maksoud Ali",
      conversationEscalated: false,
    });
    expect(collectedWrites()).toContainEqual({
      full_name: "Anas Talal Abdel Maksoud Ali",
    });
  });

  it("does not restart the intake: the department and doctor survive", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          pendingNameConfirmation: { proposed: "Anas Talal Ali", original: ARABIC_NAME },
        },
      }),
    );
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "خليه Anas Talal Abdel Maksoud Ali",
      conversationEscalated: false,
    });
    for (const write of collectedWrites()) {
      expect(write.department_id).toBeUndefined();
      expect(write.doctor_id).toBeUndefined();
    }
  });

  it("never transliterates again once a Latin spelling is settled", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        collectedData: {
          department_id: DEPARTMENT,
          doctor_id: DOCTOR,
          full_name: "Anas Talal Abdel Maksoud Ali",
        },
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          nameSpellingConfirmed: true,
          bloodTypeResolved: true,
          pendingNameConfirmation: {
            proposed: "Anas Talal Abdel Maksoud Ali",
            original: ARABIC_NAME,
          },
        },
      }),
    );
    // The model resends the original Arabic. It must not undo the patient's own
    // spelling.
    await registerPatientTool(ctx).execute!({ full_name: ARABIC_NAME, ...DETAILS }, opts);
    expect(mocks.stageIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        fullName: "Anas Talal Abdel Maksoud Ali",
        fullNameOriginal: ARABIC_NAME,
      }),
    );
  });

  it("does not force a confirmation on a name already written in Latin", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        bookingStage: { ...EMPTY_BOOKING_STAGE_STATE, bloodTypeResolved: true },
      }),
    );
    const result = (await registerPatientTool(ctx).execute!(
      { full_name: "Anas Talal Ali", ...DETAILS },
      opts,
    )) as Record<string, unknown>;
    expect(result.reason).not.toBe("name_spelling_confirmation_required");
    expect(mocks.stageIntake).toHaveBeenCalledWith(
      expect.objectContaining({ fullName: "Anas Talal Ali" }),
    );
  });
});

describe("blood type is asked before the file is created, and stays optional", () => {
  const settledName = {
    collectedData: {
      department_id: DEPARTMENT,
      doctor_id: DOCTOR,
      full_name: "Anas Talal Ali",
    },
    bookingStage: {
      ...EMPTY_BOOKING_STAGE_STATE,
      nameSpellingConfirmed: true,
      pendingNameConfirmation: { proposed: "Anas Talal Ali", original: ARABIC_NAME },
    },
  };

  it("asks for it, and creates nothing, when it has never been asked", async () => {
    mocks.authorize.mockResolvedValue(identity(settledName));
    const result = (await registerPatientTool(ctx).execute!(
      { full_name: "Anas Talal Ali", ...DETAILS },
      opts,
    )) as Record<string, unknown>;

    expect(result.reason).toBe("blood_type_required");
    expect(result.needs_clarification).toBe(true);
    expect(String(result.patient_question)).toContain("فصيلة الدم");
    expect(mocks.stageIntake).not.toHaveBeenCalled();
    expect(stageWrites().at(-1)).toMatchObject({ bloodTypeAsks: 1 });
  });

  it("files a blood type the patient supplies", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        ...settledName,
        bookingStage: { ...settledName.bookingStage, bloodTypeAsks: 1 },
      }),
    );
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "او موجب",
      conversationEscalated: false,
    });
    expect(collectedWrites()).toContainEqual({ blood_type: "O+" });
    expect(stageWrites().at(-1)).toMatchObject({ bloodTypeResolved: true });
  });

  it("accepts 'لا أعرف' as a complete answer and stages the file without it", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        ...settledName,
        bookingStage: { ...settledName.bookingStage, bloodTypeAsks: 1 },
      }),
    );
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "لا أعرف",
      conversationEscalated: false,
    });
    expect(collectedWrites()).toEqual([]);
    expect(stageWrites().at(-1)).toMatchObject({ bloodTypeResolved: true });

    mocks.authorize.mockResolvedValue(
      identity({
        ...settledName,
        bookingStage: {
          ...settledName.bookingStage,
          bloodTypeAsks: 1,
          bloodTypeResolved: true,
        },
      }),
    );
    const result = (await registerPatientTool(ctx).execute!(
      { full_name: "Anas Talal Ali", ...DETAILS },
      opts,
    )) as Record<string, unknown>;
    expect(result.intake_staged).toBe(true);
    expect(mocks.stageIntake.mock.calls[0]![0]).not.toHaveProperty("bloodType");
  });

  it("treats 'skip' the same way", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        ...settledName,
        bookingStage: { ...settledName.bookingStage, bloodTypeAsks: 1 },
      }),
    );
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "skip",
      conversationEscalated: false,
    });
    expect(stageWrites().at(-1)).toMatchObject({ bloodTypeResolved: true });
  });

  it("asks once more, and files nothing, when the answer is unreadable", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        ...settledName,
        bookingStage: { ...settledName.bookingStage, bloodTypeAsks: 1 },
      }),
    );
    await openBookingStageTurn(ctx, "patient_booking", {
      latestPatientText: "زائد",
      conversationEscalated: false,
    });
    // Unreadable is not a decline: nothing is resolved and nothing is stored.
    expect(collectedWrites()).toEqual([]);
    const written = stageWrites().at(-1);
    expect(written?.bloodTypeResolved).toBe(false);

    const result = (await registerPatientTool(ctx).execute!(
      { full_name: "Anas Talal Ali", ...DETAILS },
      opts,
    )) as Record<string, unknown>;
    expect(result.reason).toBe("blood_type_invalid");
    expect(mocks.stageIntake).not.toHaveBeenCalled();
  });

  it("never fabricates a blood type", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        ...settledName,
        bookingStage: {
          ...settledName.bookingStage,
          bloodTypeAsks: 1,
          bloodTypeResolved: true,
        },
      }),
    );
    await registerPatientTool(ctx).execute!(
      { full_name: "Anas Talal Ali", ...DETAILS },
      opts,
    );
    expect(mocks.stageIntake.mock.calls[0]![0]).not.toHaveProperty("bloodType");
  });
});
