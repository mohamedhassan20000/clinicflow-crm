/**
 * F-8 — the intake provenance gate, asserted on the PRODUCTION tool.
 *
 * `tests/unit/ai/acceptance/intake-provenance.test.ts` proves the decision and
 * proves it holds across the acceptance matrix. This file proves the other half:
 * that `register_patient` — the only path that can stage a patient file —
 * actually consults it, refuses before the write, and refuses without telling
 * the patient which value looked invented.
 *
 * The mocks are the same ones `p11j2-new-patient-intake-flow.test.ts` uses, so
 * everything below the tool is the real code path: the same resolution, the same
 * normalization, the same intake contract, the same refusal shape.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "763b1c6b-c388-4f36-b8ca-965f71f20f86";
const DERMATOLOGY = "dddddddd-0000-4000-8000-000000000001";
const NABIL = "aaaaaaaa-0000-4000-8000-000000000001";
const INTAKE = "eeeeeeee-0000-4000-8000-000000000001";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  persist: vi.fn(),
  clinicInfo: vi.fn(),
  stageIntake: vi.fn(),
  pendingIntake: vi.fn(),
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
  getPatientClinicPublicInfo: mocks.clinicInfo,
  stagePatientIntakeFromConversation: mocks.stageIntake,
  getPendingConversationIntake: mocks.pendingIntake,
  resolvePatientAiContext: vi.fn(),
  createClinicScopedAdminClient: () => {
    throw new Error("no table access is expected on these paths");
  },
}));
vi.mock("@/lib/ai/booking-stage-store", async (original) => {
  const actual = await original<typeof import("@/lib/ai/booking-stage-store")>();
  return { ...actual, recordStageTurn: vi.fn().mockResolvedValue(null) };
});

import { EMPTY_BOOKING_STAGE_STATE, offeredSlotKey } from "@/lib/ai/booking-stage";
import { containsInternalFieldName } from "@/lib/ai/patient-intake-contract";
import { registerPatientTool } from "@/lib/ai/tools/register-patient";

const opts = {} as never;

/** The stranger from the failing live case: everything settled except the file. */
function stranger() {
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
      appointment_date: "2026-09-07",
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
      offeredDays: ["2026-09-07"],
      offeredSlots: [offeredSlotKey("2026-09-07", "10:00")],
    },
  };
}

/** Exactly what the live run's model produced, and nobody typed. */
const FABRICATED = {
  full_name: "Kareem Selim Fathy",
  national_id: "30105129900871",
  date_of_birth: "1985-11-23",
  email: "kareem.selim.fathy@example.com",
};

/** The same details, as the patient would actually have written them. */
const SUPPLIED_UTTERANCES = [
  "عايز احجز في الجلدية",
  "اسمي عمر حسن",
  "الرقم القومي ٢٩٠٠٤١٢١٢٠٠٣٤٥",
  // Day 24: unambiguous under either reading, so the pre-existing
  // ambiguous-date branch does not answer before the provenance gate does.
  "مواليد ٢٤/٣/١٩٩٠",
  "ايميلي omar.hassan@example.com",
];

const SUPPLIED = {
  full_name: "عمر حسن",
  national_id: "29004121200345",
  date_of_birth: "24/3/1990",
  email: "omar.hassan@example.com",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.persist.mockResolvedValue({ data: null, error: null });
  mocks.pendingIntake.mockResolvedValue({ data: null, error: null });
  mocks.clinicInfo.mockResolvedValue({ data: { phone: null }, error: null });
  mocks.audit.mockResolvedValue(undefined);
  mocks.stageIntake.mockResolvedValue({
    data: [{ status: "staged", intake_id: INTAKE, attempts_remaining: null }],
    error: null,
  });
  mocks.authorize.mockResolvedValue(stranger());
});

describe("register_patient, with the episode transcript supplied", () => {
  const ctx = {
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    locale: "ar" as const,
    episodeUtterances: SUPPLIED_UTTERANCES,
  };

  it("refuses fabricated details and writes nothing", async () => {
    const result = (await registerPatientTool(ctx).execute!(
      FABRICATED,
      opts,
    )) as Record<string, unknown>;

    // The write boundary was never reached.
    expect(mocks.stageIntake).not.toHaveBeenCalled();
    expect(result.registered).toBe(false);
    expect(result.intake_staged).toBeUndefined();
    expect(result.reason).toBe("unreadable_fields");
    expect(result.fields).toEqual(
      expect.arrayContaining(["full_name", "national_id", "date_of_birth", "email"]),
    );
  });

  it("commits the identical fields when the patient actually supplied them", async () => {
    // The gate must refuse a fabrication without refusing a registration.
    const result = (await registerPatientTool(ctx).execute!(
      // The English spelling of an Arabic name is the server's own proposal and
      // is shown to the patient once before it becomes their record; confirming
      // it is a separate step from supplying the name, and not what is under
      // test here.
      { ...SUPPLIED, name_spelling_confirmed: true },
      opts,
    )) as Record<string, unknown>;

    expect(result.intake_staged).toBe(true);
    expect(mocks.stageIntake).toHaveBeenCalledTimes(1);
    const staged = mocks.stageIntake.mock.calls[0]![0] as Record<string, unknown>;
    // Normalization is preserved end to end: Arabic-Indic digits folded, the
    // conversational date resolved to ISO, the email lower-cased.
    expect(staged.nationalId).toBe("29004121200345");
    expect(staged.dateOfBirth).toBe("1990-03-24");
    expect(staged.email).toBe("omar.hassan@example.com");
  });

  it("refuses a single fabricated field even when the rest were supplied", async () => {
    const result = (await registerPatientTool(ctx).execute!(
      { ...SUPPLIED, national_id: FABRICATED.national_id },
      opts,
    )) as Record<string, unknown>;

    expect(mocks.stageIntake).not.toHaveBeenCalled();
    expect(result.fields).toEqual(["national_id"]);
  });

  it("refuses a name the assistant extended beyond what was typed", async () => {
    const result = (await registerPatientTool(ctx).execute!(
      { ...SUPPLIED, full_name: "عمر حسن محمد" },
      opts,
    )) as Record<string, unknown>;

    expect(mocks.stageIntake).not.toHaveBeenCalled();
    expect(result.fields).toEqual(["full_name"]);
  });

  it("says nothing to the patient about which value looked invented", async () => {
    const result = (await registerPatientTool(ctx).execute!(
      FABRICATED,
      opts,
    )) as Record<string, unknown>;
    const question = String(result.patient_question ?? "");
    expect(question.length).toBeGreaterThan(0);
    // Indistinguishable, to the patient, from a value that was unreadable.
    expect(containsInternalFieldName(question, "ar")).toBe(false);
    expect(question).not.toContain(FABRICATED.national_id);
    expect(question).not.toContain(FABRICATED.email);
    expect(question).not.toContain(FABRICATED.full_name);
  });

  it("audits the refusal without recording a single value", async () => {
    await registerPatientTool(ctx).execute!(FABRICATED, opts);
    const call = mocks.audit.mock.calls.find(
      ([entry]) =>
        (entry as { params?: { outcome?: string } }).params?.outcome ===
        "intake_provenance_refused",
    );
    expect(call).toBeDefined();
    // The content-free ledger rule is unchanged: field NAMES, never values.
    const serialized = JSON.stringify(call![0]);
    expect(serialized).toContain("national_id");
    expect(serialized).not.toContain(FABRICATED.national_id);
    expect(serialized).not.toContain(FABRICATED.email);
    expect(serialized).not.toContain(FABRICATED.full_name);
    expect(serialized).not.toContain(FABRICATED.date_of_birth);
  });

  it("refuses everything when the transcript is empty, which is the safe direction", async () => {
    const emptyCtx = { ...ctx, episodeUtterances: [] as readonly string[] };
    const result = (await registerPatientTool(emptyCtx).execute!(
      SUPPLIED,
      opts,
    )) as Record<string, unknown>;
    expect(mocks.stageIntake).not.toHaveBeenCalled();
    expect(result.reason).toBe("unreadable_fields");
  });
});

describe("register_patient, with no transcript supplied at all", () => {
  it("behaves exactly as it did before the gate existed", async () => {
    // `undefined` means "this caller has no episode transcript", which is not a
    // claim about the patient. Refusing it would replace a real safety property
    // with a wiring accident — so the wiring is asserted separately, below.
    const result = (await registerPatientTool({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      locale: "ar",
    }).execute!(FABRICATED, opts)) as Record<string, unknown>;
    expect(result.intake_staged).toBe(true);
  });
});

describe("the wiring, so the gate cannot be silently unconfigured in production", () => {
  it("loads the episode transcript and threads it to the tools", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

    // The turn reads the episode's inbound messages...
    const reply = read("lib/ai/patient-reply.ts");
    expect(reply).toContain("loadEpisodeUtterances");
    expect(reply).toMatch(/episodeUtterances/);

    // ...the agent puts them in the tool context...
    const agent = read("lib/ai/patient-agent.ts");
    expect(agent).toMatch(/episodeUtterances: ctx\.episodeUtterances/);

    // ...and the tool consults the gate before the write.
    const register = read("lib/ai/tools/register-patient.ts");
    const gateAt = register.indexOf("checkIntakeProvenance");
    const writeAt = register.indexOf("stagePatientIntakeFromConversation({");
    expect(gateAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(writeAt);
  });
});
