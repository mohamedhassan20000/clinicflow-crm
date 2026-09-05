/**
 * Item #3 — the beneficiary who already has a file here, through the real tool.
 *
 * The pure shaping is pinned in `item3-existing-patient-discovery.test.ts` and
 * the identity rule in `tests/unit/db/`. What is pinned here is the thing the
 * QA report was actually about: `register_patient`, handed a third-party
 * beneficiary who is already a patient, must not propose a second file.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const SENDER = "33333333-3333-4333-8333-333333333333";
const DERM = "55555555-5555-4555-8555-555555555555";
const CARDIO = "66666666-6666-4666-8666-666666666666";
const JIHAD = "77777777-7777-4777-8777-777777777777";
const D_NABIL = "88888888-8888-4888-8888-888888888888";
const D_SARA = "99999999-9999-4999-8999-999999999999";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  directory: vi.fn(),
  recordStage: vi.fn(),
  stageIntake: vi.fn(),
  stageMatched: vi.fn(),
  findPatient: vi.fn(),
  persist: vi.fn(),
  pendingIntake: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/ai/patient-authorization", async (original) => {
  const actual = await original<typeof import("@/lib/ai/patient-authorization")>();
  return { ...actual, authorizePatientConversation: mocks.authorize };
});
vi.mock("@/lib/ai/doctor-directory", async (original) => {
  const actual = await original<typeof import("@/lib/ai/doctor-directory")>();
  return { ...actual, loadDoctorDirectory: mocks.directory };
});
vi.mock("@/lib/ai/booking-stage-store", async (original) => {
  const actual = await original<typeof import("@/lib/ai/booking-stage-store")>();
  return { ...actual, recordStageTurn: mocks.recordStage };
});
vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => ({ from: () => ({}) }),
  getClinicCurrency: vi.fn(),
  getPatientClinicPublicInfo: vi.fn(),
  setConversationAiState: mocks.persist,
  stagePatientIntakeFromConversation: mocks.stageIntake,
  stageMatchedThirdPartyIntake: mocks.stageMatched,
  findClinicPatientByIdentity: mocks.findPatient,
  getPendingConversationIntake: mocks.pendingIntake,
}));

import { EMPTY_BOOKING_STAGE_STATE } from "@/lib/ai/booking-stage";
import { registerPatientTool } from "@/lib/ai/tools/register-patient";

const opts = {} as never;
const ctx = {
  clinicId: CLINIC,
  conversationId: CONVERSATION,
  locale: "ar" as const,
  // Every field said by the patient in their own words: `checkIntakeProvenance`
  // refuses anything the assistant did not hear them type.
  episodeUtterances: [
    "عايز احجز لأختي جهاد علي",
    "الرقم القومي 29001011234567",
    "مواليد 1 يناير 1990",
    "jihad@example.com",
    "01000000002",
    "O+",
  ],
};

/** Everything `register_patient` needs, for a third-party beneficiary. */
const INTAKE = {
  for_someone_else: true,
  full_name: "جهاد علي",
  national_id: "29001011234567",
  date_of_birth: "1 يناير 1990",
  email: "jihad@example.com",
  phone: "01000000002",
  department: "الجلدية",
  doctor: "أحمد نبيل",
};

function relationship(over: Record<string, unknown> = {}) {
  return {
    patient_id: JIHAD,
    full_name: "جهاد علي",
    department_id: DERM,
    department_name: "الجلدية",
    doctor_id: D_NABIL,
    doctor_name: "أحمد نبيل",
    is_primary: true,
    ...over,
  };
}

function register(input: Record<string, unknown>) {
  return registerPatientTool(ctx).execute!(input as never, opts) as unknown as Promise<
    Record<string, unknown>
  >;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.persist.mockResolvedValue({ data: null, error: null });
  mocks.pendingIntake.mockResolvedValue({ data: null, error: null });
  mocks.recordStage.mockResolvedValue(null);
  mocks.stageIntake.mockResolvedValue({
    data: [{ status: "staged", intake_id: "intake-new", attempts_remaining: null }],
    error: null,
  });
  mocks.stageMatched.mockResolvedValue({
    data: [{ status: "staged_existing", intake_id: "intake-1", matched_patient_id: JIHAD }],
    error: null,
  });
  mocks.findPatient.mockResolvedValue({ data: [], error: null });
  mocks.directory.mockResolvedValue({
    departments: [
      { id: DERM, name: "الجلدية" },
      { id: CARDIO, name: "القلب" },
    ],
    doctors: [
      { id: D_NABIL, name: "أحمد نبيل", departmentId: DERM, departmentName: "الجلدية", state: "available", unavailableUntil: null },
      { id: D_SARA, name: "سارة علي", departmentId: CARDIO, departmentName: "القلب", state: "available", unavailableUntil: null },
    ],
  });
  mocks.authorize.mockResolvedValue({
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    patientId: SENDER,
    linked: true,
    identityVerifiedAt: "2026-09-01T10:00:00.000Z",
    identityLockedUntil: null,
    clinicName: "ClinicFlow",
    clinicLocale: "ar" as const,
    clinicTimezone: "Africa/Cairo",
    clinicCountry: "EG",
    participantAddress: "+201000000000",
    aiPaused: false,
    // The department and doctor the conversation has settled. The
    // "she is already ours, which department?" turn happens before this one and
    // has its own test below.
    collectedData: { department_id: DERM, doctor_id: D_NABIL },
    pendingClarification: null,
    bookingStage: { ...EMPTY_BOOKING_STAGE_STATE, bookingForOther: true, beneficiary: "other" },
    bookingIdentityConfirmedAt: "2026-09-01T10:00:00.000Z",
    patientDisplayName: "Mohamed Hassan",
    patientNationalIdSuffix: null,
  });
});

describe("a beneficiary who is already a patient here", () => {
  beforeEach(() => {
    mocks.findPatient.mockResolvedValue({ data: [relationship()], error: null });
  });

  it("does not propose a second file for her", async () => {
    await register(INTAKE);
    expect(mocks.stageIntake).not.toHaveBeenCalled();
    expect(mocks.stageMatched).toHaveBeenCalledTimes(1);
  });

  it("says the file is already here, and where", async () => {
    const result = await register(INTAKE);
    expect(result.existing_patient).toBe(true);
    expect(result.patient_name).toBe("جهاد علي");
    expect(result.department).toMatchObject({ id: DERM, name: "الجلدية" });
    expect(result.treating_doctor).toMatchObject({ id: D_NABIL, name: "أحمد نبيل" });
  });

  it("uses the beneficiary's own relationships, not the sender's", async () => {
    await register(INTAKE);
    // The identity handed to the lookup is hers: her id, her name.
    expect(mocks.findPatient).toHaveBeenCalledWith(
      expect.objectContaining({ clinicId: CLINIC, nationalId: "29001011234567" }),
    );
    expect(mocks.findPatient.mock.calls[0]![0].fullName).toContain("جهاد");
  });

  it("leaves the booking able to continue to real availability", async () => {
    const result = await register(INTAKE);
    expect(result.can_request_appointment).toBe(true);
    expect(result.intake_staged).toBe(true);
  });

  it("names no contact detail of hers back to the sender", async () => {
    const serialized = JSON.stringify(await register(INTAKE));
    expect(serialized).not.toContain("29001011234567");
    expect(serialized).not.toContain("jihad@example.com");
    expect(serialized).not.toContain("01000000002");
  });

  it("offers her existing department before anything is staged", async () => {
    // The turn the QA report never reached: nothing settled yet, so the answer
    // is her own clinical home rather than "which department would you like?".
    mocks.authorize.mockResolvedValue({
      ...(await mocks.authorize()),
      collectedData: {},
    });
    const result = await register(INTAKE);
    expect(result.existing_patient).toBe(true);
    expect(result.intake_staged).toBe(false);
    expect(result.department).toMatchObject({ id: DERM });
    expect(result.treating_doctor).toMatchObject({ id: D_NABIL });
    expect(mocks.stageIntake).not.toHaveBeenCalled();
    expect(mocks.stageMatched).not.toHaveBeenCalled();
  });

  it("asks which department when she is known in more than one", async () => {
    mocks.authorize.mockResolvedValue({
      ...(await mocks.authorize()),
      collectedData: {},
    });
    mocks.findPatient.mockResolvedValue({
      data: [
        relationship(),
        relationship({
          department_id: CARDIO,
          department_name: "القلب",
          doctor_id: D_SARA,
          doctor_name: "سارة علي",
          is_primary: false,
        }),
      ],
      error: null,
    });
    const result = await register(INTAKE);
    expect(result.needs_selection).toBe(true);
    expect(result.field).toBe("department");
    expect((result.departments as Array<{ id: string }>).map((item) => item.id)).toEqual([
      DERM,
      CARDIO,
    ]);
    expect(result.treating_doctor_by_department).toMatchObject({
      [DERM]: { id: D_NABIL },
      [CARDIO]: { id: D_SARA },
    });
  });

  it("never opens a duplicate when the matched staging refuses", async () => {
    mocks.stageMatched.mockResolvedValue({ data: [{ status: "no_match" }], error: null });
    const result = await register(INTAKE);
    expect(mocks.stageIntake).not.toHaveBeenCalled();
    expect(result.reason).toBe("needs_staff_review");
  });
});

describe("a beneficiary who is genuinely new", () => {
  // A new file still goes through the English-spelling confirmation before it
  // is staged — unchanged, and the reason the matched branch runs *before* it:
  // nobody should be approving a transliteration for a file that exists. These
  // two answer that question so the staging call itself is reached.
  // Blood type is optional but still asked once before a new file is staged, so
  // it is answered here too.
  const CONFIRMED = { ...INTAKE, name_spelling_confirmed: true, blood_type: "O+" };

  it("stages a new file exactly as before", async () => {
    mocks.findPatient.mockResolvedValue({ data: [], error: null });
    const result = await register(CONFIRMED);
    expect(mocks.stageMatched).not.toHaveBeenCalled();
    expect(mocks.stageIntake).toHaveBeenCalledTimes(1);
    expect(result.intake_staged).toBe(true);
    expect(result.existing_patient).toBeUndefined();
  });

  it("stages a new file when the lookup itself fails, rather than guessing a match", async () => {
    mocks.findPatient.mockResolvedValue({ data: null, error: { message: "boom" } });
    await register(CONFIRMED);
    expect(mocks.stageMatched).not.toHaveBeenCalled();
    expect(mocks.stageIntake).toHaveBeenCalledTimes(1);
  });
});

describe("the sender's own path is untouched", () => {
  it("never runs the identity lookup when booking for themself", async () => {
    mocks.authorize.mockResolvedValue({
      ...(await mocks.authorize.mock.results[0]?.value ?? {}),
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      patientId: SENDER,
      linked: true,
      identityVerifiedAt: "2026-09-01T10:00:00.000Z",
      identityLockedUntil: null,
      clinicName: "ClinicFlow",
      clinicLocale: "ar" as const,
      clinicTimezone: "Africa/Cairo",
      clinicCountry: "EG",
      participantAddress: "+201000000000",
      aiPaused: false,
      collectedData: {},
      pendingClarification: null,
      bookingStage: { ...EMPTY_BOOKING_STAGE_STATE },
      bookingIdentityConfirmedAt: "2026-09-01T10:00:00.000Z",
      patientDisplayName: "Mohamed Hassan",
      patientNationalIdSuffix: null,
    });
    await register({ department: "الجلدية", doctor: "أحمد نبيل" });
    expect(mocks.findPatient).not.toHaveBeenCalled();
    expect(mocks.stageMatched).not.toHaveBeenCalled();
  });
});
