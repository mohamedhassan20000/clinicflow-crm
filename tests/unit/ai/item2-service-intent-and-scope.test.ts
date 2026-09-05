/**
 * Item #2 — a services/prices question is one intent, and its scope is asked
 * for rather than assumed.
 *
 * ## The two halves
 *
 * **Recognition.** `patient-turn-intent.SERVICE` and
 * `clinic-information-intent` carry two independent lexicons for the same idea,
 * and neither covers the way people actually open a conversation. "بتقدموا
 * إيه؟" matched nothing in either, so the turn fell through to `topic: "other"`
 * with `informationalOnly: false`, `resolveBookingAuthority` pinned
 * `prepare_booking` at the `department` rung, and a question about services was
 * answered with a booking funnel — the "departments/services unavailable"
 * wording from manual QA. Paraphrases of one intent must reach one intent.
 *
 * **Scope.** A generic services question names no department. Dumping the whole
 * clinic at it is not the intended UX; asking one short question — all
 * departments, or a particular one — is. A question that already names a
 * department is answered directly and is never asked back.
 *
 * The data behind every answer stays live: departments, services, prices and
 * currency are read from the clinic's own configuration on the turn, so a
 * department added or a price changed in Settings is reflected with no code
 * change. Nothing here hardcodes a roster or a number.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const SENDER = "33333333-3333-4333-8333-333333333333";
const DERMATOLOGY = "55555555-5555-4555-8555-555555555555";
const PHYSIO = "66666666-6666-4666-8666-666666666666";
const SARA = "44444444-4444-4444-8444-444444444444";

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

import { classifyPatientTurn } from "@/lib/ai/patient-turn-intent";
import { listDepartmentServicesTool } from "@/lib/ai/tools/list-department-services";

import { isServiceInquiry, readServiceScope } from "@/lib/ai/service-intent";
import { isClinicInformationQuestion } from "@/lib/ai/clinic-information-intent";

const opts = {} as never;
const ctx = { clinicId: CLINIC, conversationId: CONVERSATION, locale: "ar" as const };

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

/** Two active departments, as configured. Nothing here is hardcoded in source. */
function twoDepartments() {
  return {
    departments: [
      { id: DERMATOLOGY, name: "Dermatology" },
      { id: PHYSIO, name: "Physical Therapy" },
    ],
    doctors: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.persist.mockResolvedValue({ data: null, error: null });
  mocks.currency.mockResolvedValue("TRY");
  mocks.pendingIntake.mockResolvedValue({ data: null, error: null });
  mocks.recordStage.mockResolvedValue(null);
  mocks.directory.mockResolvedValue(twoDepartments());
  mocks.authorize.mockResolvedValue(identity());
  mocks.scoped.mockReturnValue({ from: () => tableStub(ALL_SERVICES) });
});

function services(input: Record<string, unknown>, utterance?: string) {
  return listDepartmentServicesTool(
    utterance ? { ...ctx, episodeUtterances: [utterance] } : ctx,
  ).execute!(input as never, opts) as unknown as Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// A — one intent, however it is phrased
// ---------------------------------------------------------------------------

const PARAPHRASES = [
  "عايز استفسر عن الخدمات اللي موجودة",
  "عايز أعرف الخدمات",
  "إيه الخدمات الموجودة؟",
  "ممكن أعرف الخدمات والأسعار؟",
  "بتقدموا إيه؟",
  "What services do you offer?",
  "What services and prices do you have?",
];

describe("every paraphrase of the services question reaches the same intent", () => {
  it.each(PARAPHRASES)("recognises %s", (text) => {
    expect(isServiceInquiry(text)).toBe(true);
  });

  it.each(PARAPHRASES)("classifies %s as a service turn", (text) => {
    expect(classifyPatientTurn(text).topic).toBe("service");
  });

  it.each(PARAPHRASES)("treats %s as informational, not as a booking", (text) => {
    const classification = classifyPatientTurn(text);
    expect(classification.informationalOnly).toBe(true);
  });

  it.each(PARAPHRASES)("reads %s as a clinic-information question", (text) => {
    expect(isClinicInformationQuestion(text)).toBe(true);
  });
});

describe("a booking frame still wins", () => {
  it.each([
    "عايز احجز",
    "عايز أعرف الخدمات وأحجز",
    "بكام الكشف ولو حلو احجز",
    "I want to book an appointment",
  ])("does not strip %s of its booking intent", (text) => {
    expect(isClinicInformationQuestion(text)).toBe(false);
  });

  it("does not read an unrelated question as a services question", () => {
    expect(isServiceInquiry("فين العيادة؟")).toBe(false);
    expect(isServiceInquiry("مين الدكاترة؟")).toBe(false);
    expect(isServiceInquiry("عايز أغير موعدي")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// B — scope is asked for, not assumed
// ---------------------------------------------------------------------------

describe("a generic services question asks which scope", () => {
  it.each(PARAPHRASES)("asks all-vs-specific for %s", async (text) => {
    const result = await services({}, text);
    expect(result.needs_scope).toBe(true);
    // The question is asked with the clinic's own live department list, so it
    // can be asked and answered in one turn.
    expect((result.departments as Array<{ name: string }>).map((item) => item.name)).toEqual([
      "Dermatology",
      "Physical Therapy",
    ]);
    // Nothing is dumped while the scope is unknown.
    expect(result.services).toBeUndefined();
    expect(result.scope).not.toBe("all_departments");
  });

  it("does not ask when the clinic has only one department", async () => {
    mocks.directory.mockResolvedValue({
      departments: [{ id: DERMATOLOGY, name: "Dermatology" }],
      doctors: [],
    });
    const result = await services({}, "إيه الخدمات الموجودة؟");
    expect(result.needs_scope).toBeUndefined();
    expect(result.scope).toBe("department");
  });
});

describe("answering the scope question", () => {
  it("gives every department when the patient says «كلهم»", async () => {
    const result = await services({}, "كلهم");
    expect(result.scope).toBe("all_departments");
    expect(result.needs_scope).toBeUndefined();
    const departments = result.departments as Array<{
      name: string;
      services: Array<{ name: string; price: number; currency: string }>;
    }>;
    expect(departments.map((item) => item.name)).toEqual(["Dermatology", "Physical Therapy"]);
    expect(departments[0]!.services.map((service) => [service.name, service.price])).toEqual([
      ["Dermatology Consultation", 900],
      ["Laser Session", 2400],
    ]);
    expect(departments[1]!.services[0]!.currency).toBe("TRY");
  });

  it("gives every department for «كل الأقسام» too", async () => {
    expect((await services({}, "كل الأقسام")).scope).toBe("all_departments");
  });

  it("gives every department for «all departments»", async () => {
    expect((await services({}, "all departments")).scope).toBe("all_departments");
  });

  it("gives one department when the patient names one", async () => {
    mocks.scoped.mockReturnValue({
      from: () =>
        tableStub([
          { id: "s1", name: "Dermatology Consultation", price: 900 },
          { id: "s2", name: "Laser Session", price: 2400 },
        ]),
    });
    const result = await services({ department: "الجلدية" }, "الجلدية");
    expect(result.scope).toBe("department");
    expect((result.department as { name: string }).name).toBe("Dermatology");
    expect(result.service_count).toBe(2);
  });
});

describe("a question that already names its scope is answered directly", () => {
  it("never asks back for «خدمات الجلدية وأسعارها؟»", async () => {
    mocks.scoped.mockReturnValue({
      from: () => tableStub([{ id: "s1", name: "Dermatology Consultation", price: 900 }]),
    });
    const result = await services({ department: "الجلدية" }, "خدمات الجلدية وأسعارها؟");
    expect(result.needs_scope).toBeUndefined();
    expect(result.scope).toBe("department");
  });

  it("uses the department a booking already settled, and never asks again", async () => {
    mocks.authorize.mockResolvedValue(
      identity({ collectedData: { department_id: DERMATOLOGY, doctor_id: SARA } }),
    );
    mocks.scoped.mockReturnValue({
      from: () => tableStub([{ id: "s1", name: "Dermatology Consultation", price: 900 }]),
    });
    const result = await services({}, "بكام الكشف؟");
    expect(result.needs_scope).toBeUndefined();
    expect(result.scope).toBe("department");
    expect((result.department as { id: string }).id).toBe(DERMATOLOGY);
  });
});

// ---------------------------------------------------------------------------
// C — the data stays the clinic's own
// ---------------------------------------------------------------------------

describe("the answer follows the clinic's live configuration", () => {
  it("reflects a department added since the last deploy, with no code change", async () => {
    const CARDIO = "99999999-9999-4999-8999-999999999999";
    mocks.directory.mockResolvedValue({
      departments: [
        { id: DERMATOLOGY, name: "Dermatology" },
        { id: PHYSIO, name: "Physical Therapy" },
        { id: CARDIO, name: "Cardiology" },
      ],
      doctors: [],
    });
    mocks.scoped.mockReturnValue({
      from: () =>
        tableStub([
          ...ALL_SERVICES,
          { id: "s4", name: "Echo", price: 1500, department_id: CARDIO },
        ]),
    });
    const result = await services({}, "كلهم");
    const departments = result.departments as Array<{ name: string; services: unknown[] }>;
    expect(departments.map((item) => item.name)).toContain("Cardiology");
    expect(departments.find((item) => item.name === "Cardiology")!.services).toHaveLength(1);
  });

  it("reflects a changed price rather than a remembered one", async () => {
    mocks.scoped.mockReturnValue({
      from: () =>
        tableStub([{ id: "s1", name: "Dermatology Consultation", price: 1234, department_id: DERMATOLOGY }]),
    });
    const result = await services({}, "كلهم");
    const departments = result.departments as Array<{ services: Array<{ price: number }> }>;
    expect(departments[0]!.services[0]!.price).toBe(1234);
  });

  it("says so plainly when a clinic has no departments configured", async () => {
    mocks.directory.mockResolvedValue({ departments: [], doctors: [] });
    const result = await services({}, "إيه الخدمات؟");
    expect(result.found).toBe(false);
    expect(result.needs_scope).toBeUndefined();
  });

  it("says so plainly when the scope is known but nothing is configured in it", async () => {
    mocks.scoped.mockReturnValue({ from: () => tableStub([]) });
    const result = await services({}, "كلهم");
    expect(result.scope).toBe("all_departments");
    expect(result.service_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D — the scope reader itself
// ---------------------------------------------------------------------------

describe("the scope reader", () => {
  it.each(["كلهم", "كلها", "الكل", "كل الأقسام", "جميع الاقسام", "all", "all departments", "every department"])(
    "reads %s as every department",
    (text) => {
      expect(readServiceScope(text)).toBe("all");
    },
  );

  it.each(["الجلدية", "بكام الكشف؟", "", "  "])("reads %s as no explicit scope", (text) => {
    expect(readServiceScope(text)).toBeNull();
  });
});
