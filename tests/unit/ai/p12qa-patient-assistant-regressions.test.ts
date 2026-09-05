/**
 * P12-QA — the manual-QA pass that found four Patient Assistant defects, and
 * the capabilities that must survive fixing them.
 *
 * Two halves, deliberately in one file.
 *
 *   * **The four defects.** Services and prices answered with a question
 *     instead of the clinic's own data; a phone number normalized against the
 *     clinic's country whatever country it was actually from; "بعد 9" read as
 *     "the 10th"; and a correction to a choice already made either ignored or
 *     answered by restarting the booking.
 *
 *   * **The regression contract.** The behaviour each fix ran through and must
 *     not have moved — the boundary reader still refusing a bare day, the
 *     department change still invalidating the doctor, the third-party latch
 *     still one-way once a file is staged. Every fix in this pass touched a
 *     module several certified behaviours run through, and a capability that
 *     silently disappears is worse than the defect it was traded for.
 *
 * Pure modules are asserted directly. The three tools involved are asserted
 * through their own `execute` with the database boundary mocked, in the style
 * `p10-whatsapp-device-regressions.test.ts` established.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const SENDER = "33333333-3333-4333-8333-333333333333";
const DERMATOLOGY = "55555555-5555-4555-8555-555555555555";
const PHYSIO = "66666666-6666-4666-8666-666666666666";
const SARA = "44444444-4444-4444-8444-444444444444";
const OMAR = "77777777-7777-4777-8777-777777777777";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  directory: vi.fn(),
  persist: vi.fn().mockResolvedValue({ data: null, error: null }),
  scoped: vi.fn(),
  currency: vi.fn().mockResolvedValue("TRY"),
  clinicInfo: vi.fn().mockResolvedValue({ data: { phone: null }, error: null }),
  stageIntake: vi.fn(),
  pendingIntake: vi.fn().mockResolvedValue({ data: null, error: null }),
  recordStage: vi.fn().mockResolvedValue(null),
}));

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
  createClinicScopedAdminClient: () => mocks.scoped(),
  getClinicCurrency: mocks.currency,
  getPatientClinicPublicInfo: mocks.clinicInfo,
  setConversationAiState: mocks.persist,
  stagePatientIntakeFromConversation: mocks.stageIntake,
  getPendingConversationIntake: mocks.pendingIntake,
  confirmPatientBookingIdentity: vi.fn(),
  identifyPatientForBooking: vi.fn(),
}));

import { EMPTY_BOOKING_STAGE_STATE } from "@/lib/ai/booking-stage";
import { detectBookingBeneficiary } from "@/lib/ai/booking-beneficiary";
import { resolveField } from "@/lib/ai/collected-state";
import {
  readDateBoundary,
  readDayOfMonthReference,
  resolveUpcomingDayOfMonth,
} from "@/lib/ai/day-of-month";
import {
  readPatientPhone,
  readStatedPhoneCountry,
} from "@/lib/ai/patient-phone-intake";
import { parsePatientAfterTime } from "@/lib/ai/patient-time-constraint";
import { classifyPatientTurn, toolsForInformationalTurn } from "@/lib/ai/patient-turn-intent";
import { listDepartmentServicesTool } from "@/lib/ai/tools/list-department-services";
import { prepareBookingTool } from "@/lib/ai/tools/prepare-booking";
import { registerPatientTool } from "@/lib/ai/tools/register-patient";

const opts = {} as never;
const ctx = { clinicId: CLINIC, conversationId: CONVERSATION, locale: "ar" as const };
/** The clinic in the QA report: configured in Türkiye. */
const NOW = new Date("2026-09-03T09:00:00Z");

function identity(overrides: Record<string, unknown> = {}) {
  return {
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    patientId: SENDER,
    linked: true,
    identityVerifiedAt: "2026-09-01T10:00:00.000Z",
    identityLockedUntil: null,
    clinicName: "ClinicFlow",
    clinicLocale: "ar" as const,
    clinicTimezone: "Europe/Istanbul",
    clinicCountry: "TR",
    participantAddress: "+905384567890",
    aiPaused: false,
    collectedData: {},
    pendingClarification: null,
    bookingStage: EMPTY_BOOKING_STAGE_STATE,
    bookingIdentityConfirmedAt: "2026-09-01T10:00:00.000Z",
    patientDisplayName: "Mohamed Hassan",
    patientNationalIdSuffix: null,
    ...overrides,
  };
}

/** A clinic-scoped table, one call at a time, paged reads included. */
function tableStub(rows: Record<string, unknown>[], error: unknown = null) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const method of ["select", "eq", "is", "not", "order", "limit", "gt", "lte"]) {
    builder[method] = vi.fn(chain);
  }
  let page = 0;
  builder.range = vi.fn(() =>
    Promise.resolve({ data: page++ === 0 ? rows : [], error }),
  );
  builder.maybeSingle = vi.fn().mockResolvedValue({ data: rows[0] ?? null, error });
  builder.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: rows, error }).then(resolve);
  return builder;
}

const ALL_SERVICES = [
  { id: "s1", name: "Dermatology Consultation", price: 900, department_id: DERMATOLOGY },
  { id: "s2", name: "Laser Session", price: 2400, department_id: DERMATOLOGY },
  { id: "s3", name: "Physio Session", price: 700, department_id: PHYSIO },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.persist.mockResolvedValue({ data: null, error: null });
  mocks.currency.mockResolvedValue("TRY");
  mocks.pendingIntake.mockResolvedValue({ data: null, error: null });
  mocks.recordStage.mockResolvedValue(null);
  mocks.directory.mockResolvedValue({
    departments: [
      { id: DERMATOLOGY, name: "Dermatology" },
      { id: PHYSIO, name: "Physical Therapy" },
    ],
    doctors: [
      {
        id: SARA,
        name: "Sara Ali",
        departmentId: DERMATOLOGY,
        departmentName: "Dermatology",
        state: "available",
        unavailableUntil: null,
      },
      {
        id: OMAR,
        name: "Omar Fathy",
        departmentId: DERMATOLOGY,
        departmentName: "Dermatology",
        state: "available",
        unavailableUntil: null,
      },
    ],
  });
});

// ---------------------------------------------------------------------------
// 1. Services and prices
// ---------------------------------------------------------------------------

describe("P12-QA §1 · the clinic's configured services and prices", () => {
  // Item #2 — retargeted, not weakened.
  //
  // Old expectation: a scopeless services question returns every department's
  // services immediately, and the patient is explicitly *not* asked to pick.
  // That is now the wrong first move: the intended UX is one short
  // all-vs-specific question, and only then the authoritative answer. The
  // conflict is with the first move alone.
  //
  // Everything this test was actually protecting is unchanged and still
  // asserted below — the payload is grouped by department, every number comes
  // from the clinic's stored configuration, the currency is the clinic's own,
  // and nothing is invented. The only edit is that the scope is now stated
  // ("كلهم" / "all departments"), which is exactly what the patient says one
  // turn later. The new first move has its own coverage in
  // `item2-service-intent-and-scope.test.ts`.
  it("answers «ما هي الخدمات والأسعار؟» from every department, with real prices", async () => {
    mocks.authorize.mockResolvedValue(identity());
    mocks.scoped.mockReturnValue({ from: () => tableStub(ALL_SERVICES) });

    const result = (await listDepartmentServicesTool({
      ...ctx,
      episodeUtterances: ["ما هي الخدمات والأسعار؟ كل الأقسام"],
    }).execute!({}, opts)) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect(result.scope).toBe("all_departments");
    // The claim that still matters: once the scope is known the clinic answers
    // in full from its own configuration, and never sends the patient round
    // another selection.
    expect(result.needs_selection).toBeUndefined();
    expect(result.needs_scope).toBeUndefined();
    expect(result.service_count).toBe(3);
    const departments = result.departments as Array<{ name: string; services: Array<{ name: string; price: number; currency: string }> }>;
    expect(departments.map((item) => item.name)).toEqual(["Dermatology", "Physical Therapy"]);
    expect(departments[0]!.services.map((service) => [service.name, service.price])).toEqual([
      ["Dermatology Consultation", 900],
      ["Laser Session", 2400],
    ]);
    // Never pre-formatted, and never converted: the stored number and the
    // clinic's own currency code.
    expect(departments[1]!.services[0]!.currency).toBe("TRY");
  });

  it("filters to the department the patient named", async () => {
    mocks.authorize.mockResolvedValue(identity());
    mocks.scoped.mockReturnValue({
      from: () =>
        tableStub([
          { id: "s1", name: "Dermatology Consultation", price: 900 },
          { id: "s2", name: "Laser Session", price: 2400 },
        ]),
    });

    const result = (await listDepartmentServicesTool(ctx).execute!(
      { department: "الجلدية" },
      opts,
    )) as Record<string, unknown>;

    expect(result.found).toBe(true);
    expect(result.scope).toBe("department");
    expect((result.department as { name: string }).name).toBe("Dermatology");
    expect(result.service_count).toBe(2);
  });

  it("uses the department a booking already settled, and never asks again", async () => {
    mocks.authorize.mockResolvedValue(
      identity({ collectedData: { department_id: DERMATOLOGY, doctor_id: SARA } }),
    );
    mocks.scoped.mockReturnValue({
      from: () => tableStub([{ id: "s1", name: "Dermatology Consultation", price: 900 }]),
    });

    const result = (await listDepartmentServicesTool(ctx).execute!({}, opts)) as Record<string, unknown>;

    expect(result.needs_selection).toBeUndefined();
    expect((result.department as { name: string }).name).toBe("Dermatology");
    // A price question does not move the booking: no collected state is written.
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("still asks when the patient named a department this clinic does not have", async () => {
    mocks.authorize.mockResolvedValue(identity());
    mocks.scoped.mockReturnValue({ from: () => tableStub([]) });

    const result = (await listDepartmentServicesTool(ctx).execute!(
      { department: "قسم القلب" },
      opts,
    )) as Record<string, unknown>;

    expect(result.found).toBe(false);
    expect(result.needs_clarification).toBe(true);
    expect(result.departments).toHaveLength(2);
  });

  it("says the clinic has none configured rather than naming one", async () => {
    mocks.authorize.mockResolvedValue(identity());
    mocks.scoped.mockReturnValue({ from: () => tableStub([]) });

    const result = (await listDepartmentServicesTool(ctx).execute!(
      { all_departments: true },
      opts,
    )) as Record<string, unknown>;

    expect(result.service_count).toBe(0);
    expect(String(result.guidance)).toContain("no services configured");
    expect(String(result.guidance)).toContain("do not name a service or a price");
  });

  it("routes a service question to the service tools, mid-booking included", () => {
    for (const question of [
      "ما هي الخدمات والأسعار؟",
      "ما هي الخدمات التي تقدمها العيادة؟",
      "ما هي خدمات قسم الجلدية وأسعارها؟",
    ]) {
      const classification = classifyPatientTurn(question, { workflowEngaged: true });
      expect(classification.topic).toBe("service");
      // A side question does not lose the booking: it is answered on its own
      // tools and the booking is resumed afterwards.
      expect(classification.relation).toBe("side_question");
      expect(toolsForInformationalTurn(classification.topic)).toContain(
        "list_department_services",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Country-aware phone intake
// ---------------------------------------------------------------------------

describe("P12-QA §2 · a phone number belongs to a country", () => {
  const clinic = { clinicCountry: "TR" as const };

  it("normalizes a local number of the clinic's own country", () => {
    expect(readPatientPhone("0538 456 78 90", clinic)).toEqual({
      status: "accepted",
      e164: "+905384567890",
      country: "TR",
      source: "clinic_country",
    });
    expect(readPatientPhone("٠٥٣٨٤٥٦٧٨٩٠", clinic)).toMatchObject({
      status: "accepted",
      e164: "+905384567890",
    });
  });

  it("keeps an explicit +90 as it is", () => {
    expect(readPatientPhone("+90 538 456 78 90", clinic)).toMatchObject({
      status: "accepted",
      e164: "+905384567890",
      source: "international",
    });
  });

  it("does not force a foreign number into the clinic's country code", () => {
    expect(readPatientPhone("+96551234567", clinic)).toEqual({
      status: "accepted",
      e164: "+96551234567",
      country: "KW",
      source: "international",
    });
    expect(readPatientPhone("0096551234567", clinic)).toMatchObject({
      e164: "+96551234567",
      country: "KW",
    });
  });

  it("asks which country a number with no country code and no local shape is from", () => {
    // The exact number from the QA report.
    expect(readPatientPhone("3030308765156", clinic)).toEqual({
      status: "needs_country",
      digits: "3030308765156",
    });
    // A Kuwaiti mobile typed bare is the same question, not a rejection.
    expect(readPatientPhone("51234567", clinic)).toMatchObject({ status: "needs_country" });
  });

  it("normalizes with the country the patient then names, using the real parser", () => {
    expect(readStatedPhoneCountry("الكويت")).toBe("KW");
    expect(readStatedPhoneCountry("Kuwait")).toBe("KW");
    expect(readStatedPhoneCountry("+965")).toBe("KW");
    expect(readStatedPhoneCountry("الرقم ده كويتي")).toBe("KW");
    expect(readStatedPhoneCountry("مش عارف")).toBeNull();

    expect(
      readPatientPhone("51234567", { ...clinic, statedCountry: "KW" }),
    ).toEqual({
      status: "accepted",
      e164: "+96551234567",
      country: "KW",
      source: "stated_country",
    });
  });

  it("says a local number looks a digit short or a digit long, and never edits it", () => {
    expect(readPatientPhone("0538456789", clinic)).toEqual({
      status: "needs_confirmation",
      digits: "0538456789",
      problem: "too_short",
      country: "TR",
    });
    expect(readPatientPhone("053845678901234", clinic)).toMatchObject({
      status: "needs_confirmation",
      problem: "too_long",
    });
    // The digits come back exactly as sent. Nothing is padded or truncated.
    expect(
      (readPatientPhone("0538456789", clinic) as { digits: string }).digits,
    ).toBe("0538456789");
  });

  it("reads nothing at all as unreadable rather than as a number", () => {
    expect(readPatientPhone("مش فاكر", clinic)).toEqual({ status: "unreadable" });
    expect(readPatientPhone("12", clinic)).toEqual({ status: "unreadable" });
  });

  it("asks the country question through register_patient, keeping the rest of the draft", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          bookingForOther: true,
          bloodTypeResolved: true,
        },
      }),
    );

    const result = (await registerPatientTool({
      ...ctx,
      episodeUtterances: ["3030308765156"],
    }).execute!(
      {
        for_someone_else: true,
        full_name: "Ali Hassan",
        national_id: "12345678901",
        date_of_birth: "3 February 2001",
        email: "ali@example.com",
        phone: "3030308765156",
        name_spelling_confirmed: true,
      },
      opts,
    )) as Record<string, unknown>;

    expect(result.registered).toBe(false);
    expect(result.reason).toBe("phone_country_unknown");
    // Only the phone is outstanding — nothing else is asked for again.
    expect(result.fields).toEqual(["phone"]);
    expect(result.provided_phone).toBe("3030308765156");
    expect(String(result.guidance)).toContain("which country");
    expect(String(result.guidance)).toContain("do not start");
    // Nothing was staged: an unresolved number never becomes a patient file.
    expect(mocks.stageIntake).not.toHaveBeenCalled();
    // The details the patient did give are recorded, so the correction turn
    // does not re-collect them.
    const draft = mocks.recordStage.mock.calls
      .map(([, patch]) => patch as Record<string, unknown>)
      .find((patch) => patch.thirdPartyIntake);
    expect(draft?.thirdPartyIntake).toMatchObject({
      fullName: "Ali Hassan",
      nationalId: "12345678901",
      dateOfBirth: "2001-02-03",
      phone: null,
    });
  });

  it("accepts the number once the patient names the country, and keeps the draft", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          bookingForOther: true,
          bloodTypeResolved: true,
          thirdPartyIntake: {
            fullName: "Ali Hassan",
            nationalId: "12345678901",
            dateOfBirth: "2001-02-03",
            email: "ali@example.com",
            phone: null,
            bloodType: null,
            nameSpellingConfirmed: true,
          },
        },
      }),
    );
    mocks.stageIntake.mockResolvedValue({
      data: [{ status: "staged", intake_id: "ee000000-0000-4000-8000-000000000001" }],
      error: null,
    });

    await registerPatientTool({
      ...ctx,
      episodeUtterances: ["الكويت"],
    }).execute!(
      { for_someone_else: true, phone: "51234567", phone_country: "الكويت" },
      opts,
    );

    const draft = mocks.recordStage.mock.calls
      .map(([, patch]) => patch as Record<string, unknown>)
      .find((patch) => patch.thirdPartyIntake);
    // The canonical form is the parser's, for the country the patient named —
    // never the clinic's country code glued onto a foreign number.
    expect(draft?.thirdPartyIntake).toMatchObject({
      fullName: "Ali Hassan",
      dateOfBirth: "2001-02-03",
      phone: "+96551234567",
    });
  });

  it("asks about the digits, not the country, when the number is written locally", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          bookingForOther: true,
          bloodTypeResolved: true,
        },
      }),
    );

    const result = (await registerPatientTool({
      ...ctx,
      episodeUtterances: ["0538456789"],
    }).execute!(
      {
        for_someone_else: true,
        full_name: "Ali Hassan",
        national_id: "12345678901",
        date_of_birth: "3 February 2001",
        email: "ali@example.com",
        phone: "0538456789",
        name_spelling_confirmed: true,
      },
      opts,
    )) as Record<string, unknown>;

    expect(result.reason).toBe("phone_missing_digits");
    expect(String(result.guidance)).toContain("confirm or correct");
    expect(String(result.guidance)).toContain("Never add, drop or change a digit");
    expect(mocks.stageIntake).not.toHaveBeenCalled();
  });

  it("takes a correction as the new number without touching anything else", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        bookingStage: {
          ...EMPTY_BOOKING_STAGE_STATE,
          bookingForOther: true,
          bloodTypeResolved: true,
          thirdPartyIntake: {
            fullName: "Ali Hassan",
            nationalId: "12345678901",
            dateOfBirth: "2001-02-03",
            email: "ali@example.com",
            phone: "+905384567890",
            bloodType: null,
            nameSpellingConfirmed: true,
          },
        },
      }),
    );
    mocks.stageIntake.mockResolvedValue({
      data: [{ status: "staged", intake_id: "ee000000-0000-4000-8000-000000000002" }],
      error: null,
    });

    await registerPatientTool({
      ...ctx,
      episodeUtterances: ["لا الرقم غلط، هو +96551234567"],
    }).execute!({ for_someone_else: true, phone: "+96551234567" }, opts);

    const draft = mocks.recordStage.mock.calls
      .map(([, patch]) => patch as Record<string, unknown>)
      .find((patch) => patch.thirdPartyIntake);
    expect(draft?.thirdPartyIntake).toMatchObject({
      fullName: "Ali Hassan",
      nationalId: "12345678901",
      dateOfBirth: "2001-02-03",
      email: "ali@example.com",
      phone: "+96551234567",
    });
  });
});

// ---------------------------------------------------------------------------
// 3. "بعد 9" is a lower bound
// ---------------------------------------------------------------------------

describe("P12-QA §3 · a date boundary is not a date", () => {
  const at = { now: NOW, timeZone: "Europe/Istanbul" };

  it("reads a bare «بعد ٩» as a lower bound, not as the 10th", () => {
    for (const text of ["بعد 9", "بعد ٩", "بعد يوم 9", "after 9", "after the 9th"]) {
      expect(readDayOfMonthReference(text)).toMatchObject({ day: 9, boundary: true });
      expect(readDateBoundary(text, at)).toEqual({ day: 9, after: "2026-09-09", window: null });
      // The one claim the defect was: it never resolves to a chosen day.
      expect(resolveUpcomingDayOfMonth(text, at)).toBeNull();
    }
  });

  it("hands the turn to the availability search rather than answering it", () => {
    const resolution = resolveField({
      field: "appointment_date",
      raw: "بعد 9",
      collected: {},
      pending: null,
      timeZone: "Europe/Istanbul",
      now: NOW,
    });
    expect(resolution).toEqual({
      status: "unresolved",
      field: "appointment_date",
      reason: "date_boundary",
    });
  });

  it("reads a week window as a window", () => {
    expect(readDateBoundary("الأسبوع اللي بعد يوم 9", at)).toMatchObject({ window: "week" });
    expect(readDateBoundary("الأسبوع اللي بعد 9", at)).toMatchObject({ window: "week" });
  });

  it("leaves the time constraint, the duration and the relative day alone", () => {
    // "بعد الساعة ٩" is a lower bound on the *clock*, and still is.
    expect(readDateBoundary("بعد الساعة 9", at)).toBeNull();
    expect(readDateBoundary("بعد 9 مساءً", at)).toBeNull();
    expect(parsePatientAfterTime("بعد الساعة 9")).toBe(9 * 60);
    // "بعد ٣ أيام" counts days; it names no day of the month.
    expect(readDateBoundary("بعد 3 ايام", at)).toBeNull();
    // "بعد بكرة" and "بعد الضهر" carry no digit and never did.
    expect(readDateBoundary("بعد بكرة", at)).toBeNull();
    expect(readDateBoundary("بعد الضهر", at)).toBeNull();
  });

  it("still resolves an exact day the patient chose", () => {
    expect(resolveUpcomingDayOfMonth("يوم 10", at)).toBe("2026-09-10");
    expect(readDayOfMonthReference("يوم 10")).toMatchObject({ boundary: false });
    // A bare number with no marker and no "بعد" is still nobody's day.
    expect(readDayOfMonthReference("10")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Going back and correcting a choice
// ---------------------------------------------------------------------------

describe("P12-QA §4 · corrections change one thing", () => {
  it("reads «قصدي أحجز لنفسي مش لشخص تاني» as a booking for the sender", () => {
    expect(detectBookingBeneficiary("أنا قصدي أحجز لنفسي مش لشخص تاني")).toBe("self");
    expect(detectBookingBeneficiary("actually it's for me, not for someone else")).toBe("self");
    // Negating one person while naming another is still a third-party booking.
    expect(detectBookingBeneficiary("مش لمراتي، لابني")).toBe("other");
    // And the ordinary readings are untouched.
    expect(detectBookingBeneficiary("عايز احجز لصاحبي")).toBe("other");
    expect(detectBookingBeneficiary("لنفسي")).toBe("self");
    // Ruling out a third party without saying who it *is* for settles nothing,
    // so the server still asks.
    expect(detectBookingBeneficiary("مش لشخص تاني")).toBeNull();
  });

  it("clears the day and the time when the doctor changes, and keeps the rest", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        collectedData: {
          department_id: DERMATOLOGY,
          department_name: "Dermatology",
          doctor_id: SARA,
          doctor_name: "Sara Ali",
          appointment_date: "2026-09-10",
          appointment_time: 600,
        },
      }),
    );

    await prepareBookingTool(ctx).execute!({ doctor: "Omar Fathy" }, opts);

    const written = mocks.persist.mock.calls.at(-1)![0] as {
      collected: Record<string, unknown>;
    };
    expect(written.collected).toMatchObject({
      department_id: DERMATOLOGY,
      doctor_id: OMAR,
      // The old doctor's day and time are not the new doctor's.
      appointment_date: "",
      appointment_time: "",
    });
    const patch = mocks.recordStage.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(patch).toMatchObject({
      outcome: "doctor_changed",
      clearOfferedDays: true,
      clearOfferedSlots: true,
    });
  });

  it("keeps the day and the time when the doctor is merely re-confirmed", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        collectedData: {
          department_id: DERMATOLOGY,
          department_name: "Dermatology",
          doctor_id: SARA,
          doctor_name: "Sara Ali",
          appointment_date: "2026-09-10",
          appointment_time: 600,
        },
      }),
    );

    await prepareBookingTool(ctx).execute!({ doctor: "Sara Ali" }, opts);

    const written = mocks.persist.mock.calls.at(-1)![0] as {
      collected: Record<string, unknown>;
    };
    expect(written.collected.appointment_date).toBeUndefined();
    expect(written.collected.appointment_time).toBeUndefined();
    const patch = mocks.recordStage.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(patch.outcome).toBe("doctor_resolved");
  });

  it("releases a third-party draft when the patient corrects it to themself", async () => {
    // The real `recordStageTurn`, not the mock the tool tests use: the claim is
    // about what the patch does to the stored state.
    const store = await vi.importActual<typeof import("@/lib/ai/booking-stage-store")>(
      "@/lib/ai/booking-stage-store",
    );
    const staged = {
      ...EMPTY_BOOKING_STAGE_STATE,
      bookingForOther: true,
      beneficiary: "other" as const,
      thirdPartyIntake: {
        fullName: "Ali Hassan",
        nationalId: "12345678901",
        dateOfBirth: "2001-02-03",
        email: "ali@example.com",
        phone: "+96551234567",
        bloodType: null,
        nameSpellingConfirmed: true,
      },
    };

    const released = await store.recordStageTurn(
      identity({ bookingStage: staged, collectedData: { department_id: DERMATOLOGY } }) as never,
      { bookingIntent: true, beneficiary: "self", releaseBookingForOther: true },
    );
    expect(released?.state.bookingForOther).toBe(false);
    expect(released?.state.beneficiary).toBe("self");
    // The other person's details go with the latch — nothing of theirs is left
    // staged on a booking that is no longer theirs.
    expect(released?.state.thirdPartyIntake).toBeNull();

    // Without the release flag the latch is still one-way, which is what stops
    // "ليا" moving a booking already staged for somebody else.
    const untouched = await store.recordStageTurn(
      identity({ bookingStage: staged }) as never,
      { bookingIntent: true, beneficiary: "self" },
    );
    expect(untouched?.state.bookingForOther).toBe(true);
    expect(untouched?.state.thirdPartyIntake).not.toBeNull();
  });

  it("still invalidates the doctor, day and time when the department changes", async () => {
    mocks.authorize.mockResolvedValue(
      identity({
        collectedData: {
          department_id: DERMATOLOGY,
          department_name: "Dermatology",
          doctor_id: SARA,
          doctor_name: "Sara Ali",
          appointment_date: "2026-09-10",
          appointment_time: 600,
        },
      }),
    );

    await prepareBookingTool(ctx).execute!({ department: "Physical Therapy" }, opts);

    const cleared = mocks.persist.mock.calls
      .map(([call]) => (call as { collected: Record<string, unknown> }).collected)
      .find((collected) => collected.department_id === PHYSIO);
    expect(cleared).toMatchObject({
      doctor_id: "",
      doctor_name: "",
      appointment_date: "",
      appointment_time: "",
    });
  });
});
