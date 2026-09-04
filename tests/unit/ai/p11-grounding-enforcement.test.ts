import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11 — the repair loop, end to end.
 *
 * `p11-grounded-presentation.test.ts` proves the *judgement*: given a string
 * and two lists, is anybody named who should not be? This file proves what
 * happens next, which is the half that actually reaches a patient: one
 * regeneration with the true roster in front of the model, and — if that also
 * fails — a sentence composed from the roster itself rather than from anything
 * the model wrote.
 */

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const GAMMA = "d0000000-0000-4000-8000-00000000000c";

const mocks = vi.hoisted(() => ({
  directory: vi.fn(),
  context: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: mocks.audit }));
vi.mock("@/lib/ai/doctor-directory", async (original) => {
  const actual = await original<typeof import("@/lib/ai/doctor-directory")>();
  return { ...actual, loadDoctorDirectory: mocks.directory };
});
vi.mock("@/lib/supabase/admin", () => ({
  resolvePatientAiContext: mocks.context,
}));

import { enforcePatientReplyGrounding } from "@/lib/ai/patient-reply-grounding";
import { createGroundingLedger } from "@/lib/ai/patient-grounding";

const DIRECTORY = {
  departments: [{ id: GAMMA, name: "Gamma Suite" }],
  doctors: [
    {
      id: "1",
      name: "Rana Wasfy",
      departmentId: GAMMA,
      departmentName: "Gamma Suite",
      state: "available" as const,
      unavailableUntil: null,
    },
    {
      id: "2",
      name: "Hoda Fahmy",
      departmentId: "other",
      departmentName: "Elsewhere",
      state: "available" as const,
      unavailableUntil: null,
    },
  ],
};

function ledgerWithRoster() {
  const ledger = createGroundingLedger();
  ledger.record("prepare_booking", {
    department: { id: GAMMA, name: "Gamma Suite" },
    doctors: [{ id: "1", name: "Rana Wasfy" }],
  });
  return ledger;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.audit.mockResolvedValue(undefined);
  mocks.directory.mockResolvedValue(DIRECTORY);
  mocks.context.mockResolvedValue({
    data: [{ collected_data: { department_id: GAMMA, department_name: "Gamma Suite" } }],
    error: null,
  });
});

const base = {
  clinicId: CLINIC,
  conversationId: CONVERSATION,
  locale: "ar" as const,
};

describe("P11 §16 · repair", () => {
  it("leaves a grounded reply exactly as written", async () => {
    const regenerate = vi.fn();
    const result = await enforcePatientReplyGrounding({
      ...base,
      text: "الدكتور المتاح في القسم هو د. Rana Wasfy. تحب أحجزلك؟",
      ledger: ledgerWithRoster(),
      regenerate,
    });
    expect(result.outcome).toBe("grounded");
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("regenerates once when a name was added, and keeps the fixed reply", async () => {
    const regenerate = vi
      .fn()
      .mockResolvedValue("الدكتور المتاح دلوقتي هو د. Rana Wasfy بس.");
    const result = await enforcePatientReplyGrounding({
      ...base,
      text: "الدكاترة: د. Rana Wasfy و د. Hoda Fahmy",
      ledger: ledgerWithRoster(),
      regenerate,
    });
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(String(regenerate.mock.calls[0]![0])).toContain("Rana Wasfy");
    expect(result.outcome).toBe("repaired");
    expect(result.text).toContain("Rana Wasfy");
    expect(result.text).not.toContain("Hoda Fahmy");
  });

  it("falls back to the authoritative roster when the retry fails too", async () => {
    const regenerate = vi.fn().mockResolvedValue("برضه د. Hoda Fahmy متاحة");
    const result = await enforcePatientReplyGrounding({
      ...base,
      text: "الدكاترة: د. Rana Wasfy و د. Hoda Fahmy",
      ledger: ledgerWithRoster(),
      regenerate,
    });
    expect(result.outcome).toBe("deterministic");
    expect(result.text).toContain("Rana Wasfy");
    expect(result.text).toContain("Gamma Suite");
    expect(result.text).not.toContain("Hoda Fahmy");
  });

  it("answers in the patient's language, from the clinic's own department list", async () => {
    mocks.context.mockResolvedValue({ data: [{ collected_data: {} }], error: null });
    const result = await enforcePatientReplyGrounding({
      ...base,
      locale: "en",
      text: "Dr Fatima Khalil is free tomorrow.",
      ledger: createGroundingLedger(),
      regenerate: vi.fn().mockResolvedValue("Dr Fatima Khalil is still free."),
    });
    expect(result.outcome).toBe("deterministic");
    expect(result.text).toContain("Gamma Suite");
    expect(result.text).not.toContain("Fatima");
  });

  it("never fails a turn when the directory cannot be read", async () => {
    mocks.directory.mockRejectedValue(new Error("down"));
    const result = await enforcePatientReplyGrounding({
      ...base,
      text: "الدكاترة: د. Hoda Fahmy",
      ledger: createGroundingLedger(),
      regenerate: vi.fn(),
    });
    expect(result.outcome).toBe("unchecked");
    expect(result.text).toContain("Hoda Fahmy");
  });

  it("survives a regeneration that throws", async () => {
    const result = await enforcePatientReplyGrounding({
      ...base,
      text: "الدكاترة: د. Rana Wasfy و د. Hoda Fahmy",
      ledger: ledgerWithRoster(),
      regenerate: vi.fn().mockRejectedValue(new Error("provider down")),
    });
    expect(result.outcome).toBe("deterministic");
    expect(result.text).toContain("Rana Wasfy");
  });

  it("audits the violation with labels and counts, never with the name", async () => {
    await enforcePatientReplyGrounding({
      ...base,
      text: "الدكاترة: د. Rana Wasfy و د. Hoda Fahmy",
      ledger: ledgerWithRoster(),
      regenerate: vi.fn().mockResolvedValue("د. Rana Wasfy"),
    });
    const call = mocks.audit.mock.calls.find(
      ([input]) => (input as { tool: string }).tool === "patient_reply_grounding",
    );
    expect(call).toBeDefined();
    expect(JSON.stringify(call![0])).not.toContain("Hoda");
  });
});
