/**
 * The presentation and continuity contracts, through the real turn.
 *
 * Every other test in this pass hands the engine a `TurnContext` it built
 * itself. That is the right shape for asserting a flow rule, and it is exactly
 * how a whole family of defects survived a green suite: the assembled context
 * is where the locale, the clinic timezone and the `time_format` setting come
 * from, and a fixture that hard-codes them cannot notice when nothing reads
 * them. This one starts at `runPatientTurnV2` — the seam
 * `runPatientInboundAiReply` actually calls — and stubs only the two
 * boundaries a unit test has no business crossing: the database, and the model.
 *
 * So the flow-state store, `buildTurnContext`, the interpreter view and its
 * parser, the engine, the real tool layer, the flow definitions and the
 * composer are all the production ones, and what is asserted is the string a
 * patient would have received on WhatsApp.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const model = vi.hoisted(() => ({ generateText: vi.fn() }));
vi.mock("ai", () => ({ generateText: model.generateText }));

const db = vi.hoisted(() => ({
  flowState: { current: null as unknown },
  authorize: vi.fn(),
  clinicRow: vi.fn(),
  departments: vi.fn(),
  directory: vi.fn(),
  availableDays: vi.fn(),
  availableSlots: vi.fn(),
  setFlowState: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  probeConversationFlowStateColumn: async () => ({ data: null, error: null }),
  getConversationFlowState: async () => ({
    data: { ai_flow_state: db.flowState.current },
    error: null,
  }),
  setConversationFlowState: async (input: unknown) => {
    db.setFlowState(input);
    return { error: null };
  },
  resetConversationFlowState: async () => ({ error: null }),
  getClinicAiReplyContext: async () => db.clinicRow(),
  // The patient's own care row — read by the durable-facts loader. A thread
  // with no assigned doctor is the ordinary case and the one this fixture
  // models, so nothing from history is offered and the roster stands alone.
  createClinicScopedAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }),
  }),
  getPatientClinicPublicInfo: async () => ({ data: null }),
  getClinicCurrency: async () => null,
  listClinicPublicPackages: async () => [],
  listPatientAiPackages: async () => [],
  listPatientAiDocuments: async () => [],
  listPatientAiAppointments: async () => [],
  signClinicDocumentUrl: async () => null,
  findClinicPatientByIdentity: async () => null,
  createPatientPreliminaryBookingWithPackage: async () => ({ ok: false }),
  cancelPatientAiAppointment: async () => ({ ok: false }),
  preparePatientAiReschedule: async () => null,
  reschedulePatientAiAppointment: async () => ({ ok: false }),
  searchPatientClinicFaq: async () => ({ data: [] }),
  stagePatientIntakeFromConversation: async () => ({ ok: false }),
}));

vi.mock("@/lib/ai/patient-authorization", () => ({
  authorizePatientConversation: async () => db.authorize(),
}));

vi.mock("@/lib/ai/doctor-directory", async () => {
  // The resolver itself is the real one — a doctor name still has to be matched
  // against the clinic's roster the way production matches it. Only the two
  // loaders, which are database reads, are replaced.
  const actual = await vi.importActual<typeof import("@/lib/ai/doctor-directory")>(
    "@/lib/ai/doctor-directory",
  );
  return {
    ...actual,
    loadClinicDepartments: async () => db.departments(),
    loadDoctorDirectory: async () => db.directory(),
  };
});

vi.mock("@/lib/booking/patient", () => ({
  getPatientAvailableDays: async (input: { startDate?: string }) =>
    db.availableDays(input),
  getPatientAvailableSlots: async () => db.availableSlots(),
  createPatientPendingBooking: async () => ({ ok: false }),
}));

vi.mock("@/lib/ai/audit", () => ({ logAgentTool: async () => undefined }));

import { runPatientTurnV2 } from "@/lib/ai/v2/runtime";
import type { AiExecutionHandle } from "@/lib/ai/client";

const CLINIC = "clinic-1";
const CONVERSATION = "conv-1";
const NOW = new Date("2026-09-05T09:00:00.000Z");

const DEPARTMENTS = [
  { id: "dept-derma", name: "Dermatology" },
  { id: "dept-cardio", name: "Cardiology" },
  { id: "dept-physio", name: "Physical Therapy" },
];

const DOCTORS = [
  {
    id: "doc-haneen",
    name: "Haneen Samir",
    departmentId: "dept-derma",
    departmentName: "Dermatology",
    state: "available" as const,
    unavailableUntil: null,
  },
  {
    id: "doc-youssef",
    name: "Youssef Adel",
    departmentId: "dept-derma",
    departmentName: "Dermatology",
    state: "available" as const,
    unavailableUntil: null,
  },
];

const execution = {
  model: {} as never,
  providerOptions: undefined,
} as unknown as AiExecutionHandle;

/** The interpreter's answer for the next turn, as raw model output. */
function interpretAs(commands: unknown) {
  model.generateText.mockResolvedValueOnce({ text: JSON.stringify(commands) });
}

async function reply(message: string, locale: "ar" | "en" = "ar") {
  const result = await runPatientTurnV2({
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    message,
    locale,
    style: {
      language: locale,
      arabicStyle: "egyptian",
      tone: "friendly",
      styleInstruction: null,
    },
    episode: [],
    execution,
    now: NOW,
  });
  // The state this turn wrote becomes the state the next turn loads, exactly as
  // the column does in production.
  const written = db.setFlowState.mock.calls.at(-1)?.[0] as
    | { flowState?: unknown }
    | undefined;
  if (written?.flowState) db.flowState.current = written.flowState;
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  db.flowState.current = null;
  process.env.AI_PATIENT_ENGINE = "v2";
  delete process.env.AI_PATIENT_ENGINE_CLINICS;
  db.authorize.mockReturnValue({
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    patientId: "patient-1",
    linked: true,
    identityVerifiedAt: null,
    clinicName: "Clinic",
    clinicTimezone: "Africa/Cairo",
    clinicLocale: "ar",
    clinicCountry: "EG",
    patientDisplayName: null,
  });
  // `time_format: "12h"` is the setting the day and time rendering has to read.
  // A hand-built context cannot prove it is read; this can.
  db.clinicRow.mockReturnValue({ data: { time_format: "12h" } });
  db.departments.mockReturnValue(DEPARTMENTS);
  db.directory.mockReturnValue({
    departments: DEPARTMENTS.map((entry) => ({ id: entry.id, name: entry.name })),
    doctors: DOCTORS,
  });
  db.availableDays.mockReturnValue({
    ok: true,
    availableDays: [
      { date: "2026-09-07" },
      { date: "2026-09-08" },
      { date: "2026-09-09" },
      { date: "2026-09-10" },
      { date: "2026-09-11" },
    ],
  });
  db.availableSlots.mockReturnValue({
    ok: true,
    availableSlots: ["09:00", "09:15", "09:30"],
  });
});

describe("an Arabic booking, end to end through the runtime", () => {
  it("numbers every choice, keeps the language, and reads a paused refinement", async () => {
    // 1. «عايز احجز» → who is it for. A yes/no, so prose and no list.
    interpretAs([{ kind: "start_flow", flow: "book_appointment" }]);
    const opened = await reply("عايز احجز");
    expect(opened.handled).toBe(true);
    expect(opened.handled && opened.text).toContain("ليك إنت ولا لحد تاني");
    expect(opened.handled && opened.text).not.toMatch(/^\d+-\s/m);

    // 2. «ليا» → the departments, numbered, one per line, in Arabic copy with
    //    the clinic's own English row names.
    interpretAs([{ kind: "set_slot", slot: "beneficiary", value: "ليا" }]);
    const departments = await reply("ليا");
    const departmentText = (departments.handled && departments.text) || "";
    expect(departmentText).toContain("الأقسام النشطة الموجودة في العيادة");
    expect(departmentText).toContain("1- Dermatology");
    expect(departmentText).toContain("2- Cardiology");
    expect(departmentText).toContain("3- Physical Therapy");
    expect(departmentText).not.toContain("Dermatology، Cardiology");
    expect(departmentText).not.toContain("dept-derma");

    // 3. A bare number answers the offer the patient is looking at.
    interpretAs([{ kind: "set_slot", slot: "department", value: "1" }]);
    const doctors = await reply("1");
    const doctorText = (doctors.handled && doctors.text) || "";
    expect(doctorText).toContain("1- د. Haneen Samir");
    expect(doctorText).toContain("2- د. Youssef Adel");
    expect(doctorText).not.toContain("Dr. Haneen Samir, Dr. Youssef Adel");

    // 4. «دكتور يوسف» — Arabic, against a Latin-stored roster. This is the turn
    //    that used to fail and then succeed only for "Dr.youssef".
    interpretAs([{ kind: "set_slot", slot: "doctor", value: "دكتور يوسف" }]);
    const days = await reply("دكتور يوسف");
    const dayText = (days.handled && days.text) || "";
    expect(dayText).toContain("الأيام المتاحة");
    expect(dayText).toContain("1- الاثنين — 07-09-2026");
    expect(dayText).toContain("5- الجمعة — 11-09-2026");
    expect(dayText).not.toContain("2026-09-07");

    // 5. The pause, and the refinement. The model returns what it returned in
    //    the failing session; the deterministic reading overrules it.
    db.availableDays.mockReturnValue({
      ok: true,
      availableDays: [{ date: "2026-09-12" }, { date: "2026-09-13" }],
    });
    interpretAs([{ kind: "answer_question", topic: "my_appointments" }]);
    const refined = await reply("ايه الايام المتاحة بعد يوم 11");
    const refinedText = (refined.handled && refined.text) || "";

    // Still the booking, and still the same doctor — no identity challenge and
    // no restart, which is the whole of defect G.
    expect(refinedText).not.toContain("نتأكد من هويتك");
    expect(refinedText).not.toContain("اتفضل، أقدر أساعدك في إيه؟");
    expect(refinedText).toContain("12-09-2026");
    expect(refinedText).toContain("13-09-2026");
    // The bound reached the calendar, not a guess.
    expect(db.availableDays).toHaveBeenLastCalledWith(
      expect.objectContaining({ startDate: "2026-09-12" }),
    );
    const stack = (
      db.setFlowState.mock.calls.at(-1)?.[0] as {
        flowState: { stack: { flow: string; status: string; slots: Record<string, unknown> }[] };
      }
    ).flowState.stack;
    expect(stack).toHaveLength(1);
    expect(stack[0]!.flow).toBe("book_appointment");
    expect(stack[0]!.status).toBe("active");
    expect(stack[0]!.slots.doctor).toMatchObject({ value: "doc-youssef" });

    // 6. The times, in the clinic's configured 12-hour clock — read from the
    //    settings row, through the assembled context.
    interpretAs([{ kind: "set_slot", slot: "day", value: "1" }]);
    const times = await reply("1");
    const timeText = (times.handled && times.text) || "";
    expect(timeText).toContain("1- 9:00 صباحًا");
    expect(timeText).toContain("2- 9:15 صباحًا");
    expect(timeText).toContain("3- 9:30 صباحًا");
  });

  it("answers an English conversation in English", async () => {
    interpretAs([{ kind: "start_flow", flow: "book_appointment" }]);
    const opened = await reply("I'd like to book", "en");
    expect(opened.handled && opened.text).toContain("for you, or for someone else");

    interpretAs([{ kind: "set_slot", slot: "beneficiary", value: "for me" }]);
    const departments = await reply("for me", "en");
    const text = (departments.handled && departments.text) || "";
    expect(text).toContain("Our departments");
    expect(text).toContain("1- Dermatology");
    expect(text).not.toContain("الأقسام");
  });
});
