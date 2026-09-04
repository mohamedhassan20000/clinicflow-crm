import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  directory: vi.fn(),
  entitlements: vi.fn(),
  resolveContext: vi.fn(),
  verifyDob: vi.fn(),
  registerPatient: vi.fn(),
  availability: vi.fn(),
  availableDays: vi.fn(),
  createBooking: vi.fn(),
  cancelAppointment: vi.fn(),
  listAppointments: vi.fn(),
  searchFaq: vi.fn(),
  clinicInfo: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: mocks.entitlements,
  hasFeature: (
    entitlements: { subscriptionAllowed: boolean; features: Record<string, boolean> },
    feature: string,
  ) => entitlements.subscriptionAllowed && entitlements.features[feature] === true,
}));
vi.mock("@/lib/supabase/admin", () => ({
  resolvePatientAiContext: mocks.resolveContext,
  verifyPatientConversationDob: mocks.verifyDob,
  stagePatientIntakeFromConversation: mocks.registerPatient,
  listPatientAiAppointments: mocks.listAppointments,
  cancelPatientAiAppointment: mocks.cancelAppointment,
  searchPatientClinicFaq: mocks.searchFaq,
  getPatientClinicPublicInfo: mocks.clinicInfo,
  getPendingConversationIntake: vi
    .fn()
    .mockResolvedValue({ data: null, error: null }),
  logAgentToolCall: vi.fn().mockResolvedValue({ data: "audit", error: null }),
  setConversationAiState: vi.fn().mockResolvedValue({ data: null, error: null }),
}));

/**
 * P9B: the availability and booking tools now resolve their doctor against the
 * clinic's directory before touching the schedule, so a doctor id the clinic
 * never issued cannot reach the engine. The directory itself has its own tests;
 * here it only needs to know the one doctor these cases book with.
 */
vi.mock("@/lib/ai/doctor-directory", async (original) => {
  const actual = await original<typeof import("@/lib/ai/doctor-directory")>();
  return { ...actual, loadDoctorDirectory: mocks.directory };
});
vi.mock("@/lib/booking/patient", () => ({
  getPatientAvailableSlots: mocks.availability,
  getPatientAvailableDays: mocks.availableDays,
  createPatientPendingBooking: mocks.createBooking,
}));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: mocks.audit }));

import { buildPatientTools } from "@/lib/ai/patient-tools";

/**
 * P8 §3, §4, §5, §6 — the patient assistant, from the patient's side.
 *
 * Four things are being pinned here, in ascending order of how badly getting
 * them wrong would hurt:
 *
 *   1. everyday input is accepted, and a format is never demanded;
 *   2. a genuinely ambiguous date is asked about rather than guessed at, *before*
 *      a rate-limited verification attempt is spent on it;
 *   3. an unknown sender can be registered — through the reviewed boundary, with
 *      the phone number structurally out of the model's reach;
 *   4. a conversation a staff member has taken over is not acted on at all.
 */

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const PATIENT = "33333333-3333-4333-8333-333333333333";
const DEPARTMENT = "55555555-5555-4555-8555-555555555555";
const DOCTOR = "44444444-4444-4444-8444-444444444444";
const opts = {} as never;
const context = { clinicId: CLINIC, conversationId: CONVERSATION, locale: "en" as const };

function resolved(overrides: Record<string, unknown> = {}) {
  return {
    clinic_id: CLINIC,
    conversation_id: CONVERSATION,
    patient_id: PATIENT,
    linked: true,
    identity_verified_at: null,
    identity_locked_until: null,
    booking_identity_confirmed_at: null,
    clinic_name: "Clinic",
    clinic_locale: "en",
    clinic_timezone: "Africa/Cairo",
    clinic_country: "EG",
    participant_address: "+201111111111",
    ai_paused: false,
    collected_data: {
      department_id: DEPARTMENT,
      department_name: "Cardiology",
      doctor_id: DOCTOR,
      doctor_name: "Ahmed Ali",
    },
    // The blood-type step and the English spelling of an Arabic name are both
    // asked once before a new file is staged; both are covered in
    // `tests/unit/ai/new-patient-intake-name-and-blood-type.test.ts` and
    // neither is what this file is about.
    booking_stage: { bloodTypeResolved: true, nameSpellingConfirmed: true },
    ...overrides,
  };
}

function tools(overrides: Record<string, unknown> = {}) {
  mocks.resolveContext.mockResolvedValue({ data: [resolved(overrides)], error: null });
  return buildPatientTools(context, "patient_booking");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.directory.mockResolvedValue({
    departments: [{ id: DEPARTMENT, name: "Dermatology" }],
    doctors: [
      {
        id: DOCTOR,
        name: "Sara Ali",
        departmentId: DEPARTMENT,
        departmentName: "Dermatology",
        state: "available",
        unavailableUntil: null,
      },
    ],
  });
  mocks.entitlements.mockResolvedValue({
    clinicId: CLINIC,
    planSlug: "pro_ai",
    subscriptionAllowed: true,
    features: {
      ai_assistant: true,
      "ai.patient_suggest": true,
      "ai.scheduling": true,
    },
  });
  mocks.verifyDob.mockResolvedValue({
    data: [{ verified: true, attempts_remaining: 3, locked_until: null }],
    error: null,
  });
  mocks.availability.mockResolvedValue({ ok: true, availableSlots: [] });
  mocks.availableDays.mockResolvedValue({
    ok: true,
    doctorId: DOCTOR,
    doctorName: "Ahmed Ali",
    availableDays: [{ date: "2026-08-25", slotCount: 4 }],
    minimumNoticeHours: 24,
  });
  mocks.clinicInfo.mockResolvedValue({
    data: { phone: "+201234567890" },
    error: null,
  });
});

describe("P8 — identity verification accepts human dates", () => {
  // Unambiguous spellings only: a bare `12/9/2000` has two readings and is
  // covered by the clarification case below.
  it.each(["25/12/1990", "1990-12-25", "25 December 1990", "٢٥ ديسمبر ١٩٩٠"])(
    "normalizes %s to one canonical date before checking it",
    async (written) => {
      const result = await tools().verify_patient_identity.execute!(
        { date_of_birth: written },
        opts,
      );
      expect(result).toMatchObject({ verified: true });
      expect(mocks.verifyDob).toHaveBeenCalledWith(
        expect.objectContaining({ dateOfBirth: "1990-12-25" }),
      );
    },
  );

  it("asks which month was meant instead of guessing, and spends no attempt", async () => {
    const result = (await tools().verify_patient_identity.execute!(
      { date_of_birth: "12/9/2000" },
      opts,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({
      verified: false,
      needs_clarification: true,
      reason: "ambiguous_date",
    });
    expect(result.candidate_months).toEqual([9, 12]);
    // The database was never asked, so the patient's limited attempts are intact.
    expect(mocks.verifyDob).not.toHaveBeenCalled();
  });

  it("asks again without spending an attempt when the date is unreadable", async () => {
    const result = (await tools().verify_patient_identity.execute!(
      { date_of_birth: "sometime in the nineties" },
      opts,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ needs_clarification: true, reason: "unrecognized" });
    // The patient is asked for the day, month and year — never for a format
    // specification to copy.
    expect(String(result.guidance)).not.toMatch(/YYYY|DD\/MM|MM\/DD/i);
    expect(String(result.guidance)).toMatch(/do not name a format/i);
    expect(mocks.verifyDob).not.toHaveBeenCalled();
  });

  it("does not tell the model to demand a format anywhere in its guidance", async () => {
    const result = (await tools().verify_patient_identity.execute!(
      { date_of_birth: "12/9/2000" },
      opts,
    )) as Record<string, unknown>;
    expect(String(result.guidance)).toMatch(/months in words/);
  });
});

describe("Clinic settings are dynamic patient-facing data", () => {
  it("returns the clinic's stored contact details and working hours", async () => {
    mocks.clinicInfo.mockResolvedValue({
      data: {
        name: "Nile Clinic",
        address: "12 River Street",
        phone: "+201234567890",
        website: "https://clinic.example",
        working_hours: [
          { day_of_week: 1, shift_start: "09:00:00", shift_end: "17:00:00" },
        ],
        default_working_hours: null,
      },
      error: null,
    });
    const result = (await tools({
      patient_id: null,
      linked: false,
    }).get_clinic_info.execute!({ question: "فين العيادة ومواعيدها؟" }, opts)) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({
      found: true,
      clinic: {
        name: "Nile Clinic",
        address: "12 River Street",
        phone: "+201234567890",
        website: "https://clinic.example",
      },
    });
  });
});

describe("P8 — availability understands how people describe a day", () => {
  it("lists real days before exposing any times", async () => {
    const result = (await tools({
      identity_verified_at: "2026-08-22T08:00:00Z",
    }).list_available_days.execute!(
      { doctor_id: DOCTOR, duration_minutes: 30, search_days: 21 },
      opts,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({
      ok: true,
      availableDays: [{ date: "2026-08-25", slotCount: 4 }],
      minimumNoticeHours: 24,
    });
    expect(result).not.toHaveProperty("availableSlots");
  });

  it("resolves a relative day in the clinic's own timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T09:00:00Z"));
    try {
      await tools().check_availability.execute!({ date: "بكرا" }, opts);
      expect(mocks.availability).toHaveBeenCalledWith(
        expect.objectContaining({ date: "2026-08-18" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a written date in the clinic's convention", async () => {
    await tools().check_availability.execute!({ date: "18/8/2026" }, opts);
    expect(mocks.availability).toHaveBeenCalledWith(
      expect.objectContaining({ date: "2026-08-18" }),
    );
  });

  it("asks which day rather than inventing one", async () => {
    const result = (await tools().check_availability.execute!(
      { date: "whenever suits you" },
      opts,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ needs_clarification: true, field: "date" });
    expect(mocks.availability).not.toHaveBeenCalled();
  });
});

describe("AI booking understands natural time and option answers", () => {
  it("turns Arabic natural time into the clinic-local real slot", async () => {
    mocks.createBooking.mockResolvedValue({
      ok: true,
      appointmentId: "66666666-6666-4666-8666-666666666666",
      expiresAt: "2026-08-19T10:00:00.000Z",
      provisional: false,
    });
    await tools({ identity_verified_at: "2026-08-17T08:00:00.000Z" })
      .create_preliminary_booking.execute!(
        {
          doctor_id: DOCTOR,
          date: "18/8/2026",
          time: "٣ العصر",
          duration_minutes: 30,
        },
        opts,
      );
    expect(mocks.createBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        doctorId: DOCTOR,
        scheduledAt: "2026-08-18T12:00:00.000Z",
      }),
    );
  });

  it("resolves second option only from the real availability result", async () => {
    mocks.availability.mockResolvedValue({
      ok: true,
      availableSlots: ["09:00", "10:30"],
    });
    mocks.createBooking.mockResolvedValue({
      ok: true,
      appointmentId: "66666666-6666-4666-8666-666666666666",
      expiresAt: "2026-08-19T10:00:00.000Z",
      provisional: false,
    });
    await tools({ identity_verified_at: "2026-08-17T08:00:00.000Z" })
      .create_preliminary_booking.execute!(
        {
          doctor_id: DOCTOR,
          date: "18/8/2026",
          time: "second option",
          duration_minutes: 30,
        },
        opts,
      );
    expect(mocks.createBooking).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledAt: "2026-08-18T07:30:00.000Z" }),
    );
  });
});

describe("P8 — registering an unknown sender", () => {
  const details = {
    full_name: " محمد   حسن ",
    national_id: "٢٩٠-٠٩١٢-٠١٢٣٤٥٦",
    date_of_birth: "25/12/1990",
    email: " Foo.Bar@Example.COM ",
  };

  it("is mounted for a conversation with no patient record", () => {
    expect(Object.keys(tools({ patient_id: null, linked: false }))).toContain("register_patient");
  });

  it("normalizes every field and never passes a phone number", async () => {
    mocks.registerPatient.mockResolvedValue({
      data: [{ status: "staged", intake_id: PATIENT }],
      error: null,
    });
    const result = await tools({ patient_id: null, linked: false }).register_patient.execute!(
      details,
      opts,
    );

    expect(mocks.registerPatient).toHaveBeenCalledWith({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      // P10: filed in the Latin-script form the patient file convention uses.
      // Every part of "محمد حسن" has a curated reading, so this is a lookup
      // rather than a guess and no confirmation round-trip is needed.
      fullName: "Mohamed Hassan",
      fullNameOriginal: "محمد حسن",
      nationalId: "29009120123456",
      dateOfBirth: "1990-12-25",
      email: "foo.bar@example.com",
      // P9C: the subject of the registration is now explicit. False is the
      // sender registering themselves, which is what this case is.
      forThirdParty: false,
      departmentId: DEPARTMENT,
      doctorId: DOCTOR,
    });
    // The phone number is not an argument at all: the boundary takes it from the
    // conversation, so no prompt can register a patient against another number.
    const [call] = mocks.registerPatient.mock.calls;
    expect(Object.keys(call[0])).not.toContain("phone");
    expect(result).toMatchObject({
      registered: false,
      intake_staged: true,
      awaiting_staff_review: true,
    });
  });

  it("asks about an ambiguous date of birth before creating anything", async () => {
    const result = (await tools({ patient_id: null, linked: false }).register_patient.execute!(
      { ...details, date_of_birth: "12/9/2000" },
      opts,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ registered: false, reason: "ambiguous_date" });
    expect(mocks.registerPatient).not.toHaveBeenCalled();
    expect(mocks.createBooking).not.toHaveBeenCalled();
  });

  it.each([
    ["12/9", "incomplete_date"],
    ["sometime in the nineties", "unreadable_fields"],
  ])("clarifies %s without a patient, intake, or appointment write", async (date, reason) => {
    const result = (await tools({ patient_id: null, linked: false }).register_patient.execute!(
      { ...details, date_of_birth: date },
      opts,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({
      registered: false,
      needs_clarification: true,
      reason,
    });
    expect(mocks.registerPatient).not.toHaveBeenCalled();
    expect(mocks.createBooking).not.toHaveBeenCalled();
  });

  it("clarifies a conflicting date without overwriting or writing a record", async () => {
    const result = (await tools({
      patient_id: null,
      linked: false,
      collected_data: {
        ...resolved().collected_data,
        date_of_birth: "1990-12-25",
      },
    }).register_patient.execute!(
      { ...details, date_of_birth: "1991" },
      opts,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({
      registered: false,
      needs_clarification: true,
      reason: "conflicting_date",
    });
    expect(mocks.registerPatient).not.toHaveBeenCalled();
    expect(mocks.createBooking).not.toHaveBeenCalled();
  });

  it("names the one field it could not read", async () => {
    const result = (await tools({ patient_id: null, linked: false }).register_patient.execute!(
      { ...details, email: "not an email" },
      opts,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ registered: false, reason: "unreadable_fields" });
    expect(result.fields).toEqual(["email"]);
    expect(mocks.registerPatient).not.toHaveBeenCalled();
  });

  it("links an existing record rather than creating a duplicate", async () => {
    mocks.registerPatient.mockResolvedValue({
      data: [{ status: "linked_existing", patient_id: PATIENT, file_number: "CF-0007" }],
      error: null,
    });
    const result = await tools({ patient_id: null, linked: false }).register_patient.execute!(
      details,
      opts,
    );
    expect(result).toMatchObject({ registered: true, matched_existing: true });
  });

  it("stops and hands over when more than one record could be this person", async () => {
    mocks.registerPatient.mockResolvedValue({
      data: [{ status: "duplicate_ambiguous", patient_id: null, file_number: null }],
      error: null,
    });
    const result = (await tools({ patient_id: null, linked: false }).register_patient.execute!(
      details,
      opts,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ registered: false, reason: "duplicate_ambiguous" });
    expect(String(result.guidance)).toMatch(/clinic staff/i);
  });

  it("does not re-register a conversation that already has a patient", async () => {
    const result = await tools().register_patient.execute!(details, opts);
    expect(result).toMatchObject({ registered: false, reason: "already_linked" });
    expect(mocks.registerPatient).not.toHaveBeenCalled();
  });

  it("logs only the outcome, never the patient's details", async () => {
    mocks.registerPatient.mockResolvedValue({
      data: [{ status: "staged", intake_id: PATIENT }],
      error: null,
    });
    await tools({ patient_id: null, linked: false }).register_patient.execute!(details, opts);
    expect(mocks.audit).toHaveBeenCalledWith({
      clinicId: CLINIC,
      actorId: null,
      tool: "register_patient",
      params: { outcome: "staged" },
    });
  });

  it("does not link, and does not say why, when the details need staff review", async () => {
    // C1: the sender supplied a national id that belongs to somebody whose
    // number this is not. The tool must refuse *and* must not confirm that the
    // id exists — an assistant that said "we already have that national id"
    // would be an existence oracle for every id a sender cared to try.
    mocks.registerPatient.mockResolvedValue({
      data: [{ status: "duplicate_review", patient_id: null, file_number: null }],
      error: null,
    });
    const result = (await tools({ patient_id: null, linked: false }).register_patient.execute!(
      details,
      opts,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ registered: false, reason: "needs_staff_review" });
    expect(String(result.guidance)).toMatch(/clinic staff/i);
    expect(String(result.guidance)).toMatch(/do not say which detail/i);
    expect(result).not.toHaveProperty("file_number");
  });

  it("gives the same answer for a mismatch as for a duplicate, so neither is distinguishable", async () => {
    mocks.registerPatient.mockResolvedValue({
      data: [{ status: "identity_mismatch", patient_id: null, file_number: null }],
      error: null,
    });
    const mismatch = (await tools({ patient_id: null, linked: false }).register_patient.execute!(
      details,
      opts,
    )) as Record<string, unknown>;
    mocks.registerPatient.mockResolvedValue({
      data: [{ status: "duplicate_review", patient_id: null, file_number: null }],
      error: null,
    });
    const duplicate = (await tools({ patient_id: null, linked: false }).register_patient.execute!(
      details,
      opts,
    )) as Record<string, unknown>;
    expect(mismatch.reason).toBe(duplicate.reason);
    expect(mismatch.guidance).toBe(duplicate.guidance);
  });

  it("stops retrying once registration is locked out", async () => {
    mocks.registerPatient.mockResolvedValue({
      data: [{ status: "identity_locked", patient_id: null, file_number: null }],
      error: null,
    });
    const result = (await tools({ patient_id: null, linked: false }).register_patient.execute!(
      details,
      opts,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({
      registered: false,
      reason: "identity_verification_locked",
    });
    expect(String(result.guidance)).toMatch(/Do not retry/i);
  });

  it("allows a reviewed provisional intake to hold a real pending slot", async () => {
    mocks.createBooking.mockResolvedValue({
      ok: true,
      appointmentId: "66666666-6666-4666-8666-666666666666",
      expiresAt: "2026-08-19T10:00:00.000Z",
      provisional: true,
    });
    const result = (await tools({
      patient_id: null,
      linked: false,
    }).create_preliminary_booking.execute!(
      {
        doctor_id: "44444444-4444-4444-8444-444444444444",
        scheduled_at: "2026-08-18T10:00:00.000Z",
        duration_minutes: 30,
      },
      opts,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({
      created: true,
      status: "pending",
      provisional_intake: true,
      requires_staff_confirmation: true,
    });
  });

  it("returns the stored clinic phone and creates nothing inside the 24-hour window", async () => {
    mocks.createBooking.mockResolvedValue({ ok: false, reason: "minimum_notice" });
    const result = (await tools({
      identity_verified_at: "2026-08-22T08:00:00Z",
    }).create_preliminary_booking.execute!(
      {
        doctor_id: DOCTOR,
        scheduled_at: "2026-08-23T07:59:00.000Z",
        duration_minutes: 30,
      },
      opts,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({
      created: false,
      reason: "minimum_notice",
      minimum_notice_hours: 24,
      clinic_phone: "+201234567890",
    });
  });
});

describe("P8/P10 · booking requires booking identity, not clinical disclosure identity", () => {
  const slot = {
    doctor_id: "44444444-4444-4444-8444-444444444444",
    scheduled_at: "2026-08-18T10:00:00.000Z",
    duration_minutes: 30,
  };

  it("refuses to book on a linked conversation whose booking identity is unsettled", async () => {
    // This is the second half of the C1 exploit. Even if a link were somehow
    // established without proof — an automatic phone match on first contact, or
    // a future linking path — a booking in that patient's name must not follow
    // from it. `create_preliminary_booking` used to require only `requireLinked`.
    const result = (await tools({
      identity_verified_at: null,
    }).create_preliminary_booking.execute!(slot, opts)) as Record<string, unknown>;
    expect(result).toMatchObject({
      permission_denied: true,
      reason: "booking_identity_required",
    });
    expect(mocks.createBooking).not.toHaveBeenCalled();
  });

  it("keeps clinical lockout separate and still requires booking identity", async () => {
    const result = (await tools({
      identity_verified_at: null,
      identity_locked_until: new Date(Date.now() + 60_000).toISOString(),
    }).create_preliminary_booking.execute!(slot, opts)) as Record<string, unknown>;
    expect(result).toMatchObject({
      permission_denied: true,
      reason: "booking_identity_required",
    });
    expect(mocks.createBooking).not.toHaveBeenCalled();
  });

  it("books after booking-only identity confirmation without unlocking clinical disclosure", async () => {
    mocks.createBooking.mockResolvedValue({
      ok: true,
      appointmentId: "66666666-6666-4666-8666-666666666666",
      expiresAt: "2026-08-18T12:00:00.000Z",
      provisional: false,
    });
    const result = (await tools({
      identity_verified_at: null,
      booking_identity_confirmed_at: "2026-08-17T10:00:00.000Z",
    }).create_preliminary_booking.execute!(slot, opts)) as Record<string, unknown>;
    expect(result.created).toBe(true);
    expect(mocks.createBooking).toHaveBeenCalledOnce();
  });

  it("books once the conversation is verified", async () => {
    // The legitimate patient pays nothing for the gate: register_patient stamps
    // the conversation verified inside the same transaction, so a freshly
    // registered sender arrives here already able to book.
    mocks.createBooking.mockResolvedValue({
      ok: true,
      appointmentId: "55555555-5555-4555-8555-555555555555",
      expiresAt: "2026-08-19T10:00:00.000Z",
    });
    const result = (await tools({
      identity_verified_at: "2026-08-17T08:00:00Z",
    }).create_preliminary_booking.execute!(slot, opts)) as Record<string, unknown>;
    expect(result).toMatchObject({ created: true, status: "pending" });
    expect(mocks.createBooking).toHaveBeenCalledTimes(1);
  });
});

describe("P8 — human takeover stops the assistant acting", () => {
  it("refuses to create a booking on a paused conversation", async () => {
    const result = (await tools({ ai_paused: true }).create_preliminary_booking.execute!(
      {
        doctor_id: "44444444-4444-4444-8444-444444444444",
        scheduled_at: "2026-08-18T10:00:00.000Z",
        duration_minutes: 30,
      },
      opts,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ permission_denied: true, reason: "human_takeover" });
    expect(mocks.createBooking).not.toHaveBeenCalled();
    expect(String(result.guidance)).toMatch(/Do not act/);
  });

  it("refuses to cancel an appointment on a paused conversation", async () => {
    const result = (await tools({
      ai_paused: true,
      identity_verified_at: "2026-08-17T08:00:00Z",
    }).cancel_my_appointment.execute!({ appointment_id: PATIENT }, opts)) as Record<string, unknown>;
    expect(result).toMatchObject({ permission_denied: true, reason: "human_takeover" });
    expect(mocks.cancelAppointment).not.toHaveBeenCalled();
  });

  it("refuses to register a patient on a paused conversation", async () => {
    const result = (await tools({
      ai_paused: true,
      patient_id: null,
      linked: false,
    }).register_patient.execute!(
      {
        full_name: "محمد حسن",
        national_id: "29009120123456",
        date_of_birth: "25/12/1990",
        email: "a@b.com",
      },
      opts,
    )) as Record<string, unknown>;
    expect(result).toMatchObject({ permission_denied: true, reason: "human_takeover" });
    expect(mocks.registerPatient).not.toHaveBeenCalled();
  });
});
