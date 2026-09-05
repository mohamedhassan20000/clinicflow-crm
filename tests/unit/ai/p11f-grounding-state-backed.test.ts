import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11F §10 — the grounding ledger was one turn too narrow.
 *
 * P11B made a roster-bearing turn with no server-returned doctor unanswerable
 * by the model, and answered it from the directory instead. That is right when
 * the model has invented somebody. It is wrong — and was the immediate cause of
 * the P11F backward jump — when the name in the reply is the doctor the *server
 * itself* committed three turns ago:
 *
 * ```
 *   ai_collected_data.doctor_id  committed on turn 40 by the continuation
 *   turn 42  patient: "الساعه ٩ الصبح"
 *            model:   "تمام، هحجزلك مع <that same doctor> …"
 *            ledger:  empty — no tool ran this turn
 *            → violation → deterministic → the doctor roster, again
 * ```
 *
 * The ledger records *this turn's* tool results. `ai_collected_data` and
 * `offeredDoctorIds` record what the server said on every previous turn, and
 * both are server-owned and unwritable by the model. So a name backed by either
 * is grounded, and a valid forward-progress reply survives.
 *
 * The names here are generated. The property under test is which *source* backs
 * a name, never which name it is.
 */

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const DEPT = "d0000000-0000-4000-8000-00000000000c";
const CHOSEN = "e0000000-0000-4000-8000-0000000000f1";
const OFFERED = "e0000000-0000-4000-8000-0000000000f2";
const STRANGER = "e0000000-0000-4000-8000-0000000000f3";

const mocks = vi.hoisted(() => ({
  directory: vi.fn(),
  context: vi.fn(),
  audit: vi.fn(),
  authorize: vi.fn(),
  continuation: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: mocks.audit }));
vi.mock("@/lib/ai/doctor-directory", async (original) => {
  const actual = await original<typeof import("@/lib/ai/doctor-directory")>();
  return { ...actual, loadDoctorDirectory: mocks.directory };
});
vi.mock("@/lib/supabase/admin", () => ({ resolvePatientAiContext: mocks.context }));
vi.mock("@/lib/ai/patient-authorization", () => ({
  authorizePatientConversation: mocks.authorize,
  AI_SCHEDULING_FEATURE: "ai_scheduling",
}));
vi.mock("@/lib/ai/patient-roster-continuation", () => ({
  continuePatientBookingFromRoster: mocks.continuation,
}));

import { enforcePatientReplyGrounding } from "@/lib/ai/patient-reply-grounding";
import { createGroundingLedger } from "@/lib/ai/patient-grounding";

const DIRECTORY = {
  departments: [{ id: DEPT, name: "Kinesis Hall" }],
  doctors: [
    { id: CHOSEN, name: "Dr. Wren Halloway", departmentId: DEPT, departmentName: "Kinesis Hall", state: "available" as const, unavailableUntil: null },
    { id: OFFERED, name: "Dr. Ilias Vantorre", departmentId: DEPT, departmentName: "Kinesis Hall", state: "available" as const, unavailableUntil: null },
    { id: STRANGER, name: "Dr. Perri Callowhill", departmentId: "other", departmentName: "Elsewhere", state: "available" as const, unavailableUntil: null },
  ],
};

function context(options: {
  doctorId?: string | null;
  offeredDoctorIds?: readonly string[];
}) {
  return {
    data: [
      {
        collected_data: {
          department_id: DEPT,
          ...(options.doctorId ? { doctor_id: options.doctorId } : {}),
        },
        booking_stage: {
          stage: "selecting_time",
          offeredDoctorIds: options.offeredDoctorIds ?? [],
        },
      },
    ],
    error: null,
  };
}

const base = {
  clinicId: CLINIC,
  conversationId: CONVERSATION,
  locale: "ar" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.audit.mockResolvedValue(undefined);
  mocks.directory.mockResolvedValue(DIRECTORY);
  mocks.context.mockResolvedValue(context({}));
  mocks.continuation.mockResolvedValue({
    text: "SERVER_ROSTER_SENTENCE",
    committed: "none",
    outcome: "roster_offered",
    step: "doctor",
  });
  mocks.authorize.mockResolvedValue({ clinicId: CLINIC, conversationId: CONVERSATION });
});

describe("P11F §10 · a name the server already committed is grounded", () => {
  it("does not overwrite a forward-progress reply naming the chosen doctor", async () => {
    mocks.context.mockResolvedValue(context({ doctorId: CHOSEN }));
    const result = await enforcePatientReplyGrounding({
      ...base,
      text: "تمام، هحجزلك مع Dr. Wren Halloway الساعة ٩ الصبح.",
      ledger: createGroundingLedger(),
      regenerate: async () => "",
      latestPatientText: "الساعه ٩ الصبح",
    });
    expect(result.outcome).toBe("grounded");
    expect(result.text).toContain("Wren Halloway");
    expect(mocks.continuation).not.toHaveBeenCalled();
  });

  it("accepts a doctor recorded in offeredDoctorIds on an earlier turn", async () => {
    mocks.context.mockResolvedValue(context({ offeredDoctorIds: [CHOSEN, OFFERED] }));
    const result = await enforcePatientReplyGrounding({
      ...base,
      text: "الدكاترة اللي عرضتهم: Dr. Wren Halloway و Dr. Ilias Vantorre.",
      ledger: createGroundingLedger(),
      regenerate: async () => "",
      latestPatientText: "مين الدكاترة؟",
    });
    expect(result.outcome).toBe("grounded");
    expect(mocks.continuation).not.toHaveBeenCalled();
  });

  it("still rejects a real doctor the server never offered here", async () => {
    mocks.context.mockResolvedValue(context({ doctorId: CHOSEN }));
    const result = await enforcePatientReplyGrounding({
      ...base,
      text: "تحب تحجز مع Dr. Perri Callowhill؟",
      ledger: createGroundingLedger(),
      regenerate: async () => "",
      latestPatientText: "مين الدكاترة؟",
    });
    expect(result.outcome).toBe("deterministic");
    expect(result.text).toBe("SERVER_ROSTER_SENTENCE");
  });

  it("still rejects a doctor who exists nowhere at all", async () => {
    mocks.context.mockResolvedValue(context({ doctorId: CHOSEN }));
    const result = await enforcePatientReplyGrounding({
      ...base,
      text: "تحب تحجز مع د. Zephyrine Quillbottom؟",
      ledger: createGroundingLedger(),
      regenerate: async () => "",
      latestPatientText: "مين الدكاترة؟",
    });
    expect(result.outcome).toBe("deterministic");
  });

  it("a read failure degrades to the pre-P11F behaviour, never to an invention", async () => {
    mocks.context.mockRejectedValue(new Error("transient"));
    const result = await enforcePatientReplyGrounding({
      ...base,
      text: "تمام، هحجزلك مع Dr. Wren Halloway.",
      ledger: createGroundingLedger(),
      regenerate: async () => "",
      latestPatientText: "الساعه ٩ الصبح",
    });
    expect(result.outcome).toBe("deterministic");
  });

  it("logs the widened acceptance with a label and no name", async () => {
    mocks.context.mockResolvedValue(context({ doctorId: CHOSEN }));
    await enforcePatientReplyGrounding({
      ...base,
      text: "تمام، هحجزلك مع Dr. Wren Halloway.",
      ledger: createGroundingLedger(),
      regenerate: async () => "",
      latestPatientText: "الساعه ٩ الصبح",
    });
    const logged = mocks.audit.mock.calls.map((call) => call[0]);
    const line = logged.find((entry) => entry.params?.reason === "state_backed");
    expect(line).toBeDefined();
    expect(JSON.stringify(line)).not.toContain("Wren");
  });
});
