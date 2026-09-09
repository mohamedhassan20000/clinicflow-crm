/**
 * The optional blood-type question, end to end on the conversation side.
 *
 * Four properties, and every one of them is a property of the flow definition
 * rather than of the copy:
 *
 *   1. it is **asked**, for a new self file and for a third-party file alike;
 *   2. it is **optional** — «تخطي», «مش عارف», "skip" and anything else that is
 *      not a readable group all resolve, so the question can never become a
 *      wall in front of a booking;
 *   3. a **skip is a null at the write**, not the sentinel the frame carries:
 *      the frame needs to know "we asked and they don't know" so it does not
 *      ask twice, and the patient file must hold only one of the eight stored
 *      groups or nothing at all;
 *   4. a **real value survives** to the staging call unchanged.
 *
 * The staging RPC and `approve_ai_patient_intake` — which copies the group onto
 * the new `patients` row — are untouched by this pass and are asserted against
 * the migration text in `tests/unit/db`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const stubs = vi.hoisted(() => ({
  readDepartments: vi.fn(),
  readDoctors: vi.fn(),
  resolveDoctorSpoken: vi.fn(),
  resolveDepartmentSpoken: vi.fn(),
  resolveDepartmentNamed: vi.fn(),
  readAvailableDays: vi.fn(),
  readAvailableSlots: vi.fn(),
  readPatientPackages: vi.fn(),
  readPublicPackages: vi.fn(),
  readServices: vi.fn(),
  readPatientDocuments: vi.fn(),
  readDocumentLink: vi.fn(),
  readMyAppointments: vi.fn(),
  readTreatingDoctors: vi.fn(),
  readClinicInfo: vi.fn(),
  readClinicFaq: vi.fn(),
  readClinicInsurance: vi.fn(),
  readRescheduleTarget: vi.fn(),
  readKnownDepartments: vi.fn(),
  resolveIdentity: vi.fn(),
  stageIntake: vi.fn(),
  commitBooking: vi.fn(),
  commitCancellation: vi.fn(),
  commitReschedule: vi.fn(),
}));

vi.mock("@/lib/ai/v2/tools", () => stubs);

import type { Command } from "@/lib/ai/v2/commands";
import {
  EMPTY_FLOW_STATE,
  newFrame,
  type FlowFrame,
  type FlowState,
} from "@/lib/ai/v2/flow-state";
import { runEngine, type Effect } from "@/lib/ai/v2/engine";
import { BLOOD_TYPE_UNKNOWN, FLOW_REGISTRY } from "@/lib/ai/v2/flows";
import { COMPOSER_COPY, composeDeterministic } from "@/lib/ai/v2/composer";
import type { TurnContext } from "@/lib/ai/v2/context";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const AT = NOW.toISOString();

function slotValue(value: string) {
  return { value, provenance: "spoken" as const, at: AT };
}

/** Everything a booking intake needs except the blood group. */
function collected(forThirdParty: boolean): FlowFrame["slots"] {
  return {
    beneficiary: {
      value: forThirdParty ? "other" : "self",
      label: forThirdParty ? "لحد تاني" : "ليك إنت",
      provenance: "affirmed",
      at: AT,
    },
    department: { value: "dept-physio", label: "العلاج الطبيعي", provenance: "affirmed", at: AT },
    doctor: { value: "doc-youssef", label: "د. يوسف عادل", provenance: "affirmed", at: AT },
    day: { value: "2026-09-18", label: "الجمعة — 18-09-2026", provenance: "affirmed", at: AT },
    time: { value: "11:15", label: "11:15 صباحًا", provenance: "affirmed", at: AT },
    full_name: slotValue("حسام حسن محمد"),
    // The English spelling, confirmed. `intakeFieldsFor` asks for it right
    // after the Arabic name — see `latinNameOutcome`.
    full_name_latin: slotValue("Hossam Hassan Mohamed"),
    national_id: slotValue("29009120123456"),
    date_of_birth: slotValue("1995-04-12"),
    email: slotValue("hossam@example.com"),
    ...(forThirdParty ? { phone: slotValue("+201111111111") } : {}),
  };
}

function bookingState(slots: FlowFrame["slots"]): FlowState {
  return {
    ...EMPTY_FLOW_STATE,
    stack: [
      {
        ...newFrame({ flow: "book_appointment", at: AT }),
        slots,
        memo: { "done:package_offer": true },
      },
    ],
  };
}

function context(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    clinicId: "clinic-1",
    conversationId: "conv-1",
    turn: { text: "", receivedAt: AT, locale: "ar", attachments: [] },
    episode: { turns: [] },
    flows: EMPTY_FLOW_STATE,
    durable: {
      treatingDoctors: async () => [],
      knownDepartments: async () => [],
      activePackages: async () => [],
      issuedDocuments: async () => [],
      appointments: async () => [],
      canonicalName: async () => null,
    },
    history: { search: async () => [] },
    identity: "anonymous",
    patientId: null,
    clinic: {
      name: "عيادة الابتسامة",
      timeZone: "Africa/Cairo",
      locale: "ar",
      country: "EG",
      timeFormat: "12h",
    },
    style: {
      language: "ar",
      arabicStyle: "egyptian",
      tone: "friendly",
      styleInstruction: null,
    },
    now: NOW,
    ...overrides,
  };
}

async function turn(commands: readonly Command[], ctx: TurnContext) {
  return runEngine({ context: ctx, commands, registry: FLOW_REGISTRY });
}

function reply(effects: readonly Effect[]) {
  return composeDeterministic({ effects, locale: "ar" }).text;
}

beforeEach(() => {
  vi.clearAllMocks();
  stubs.resolveIdentity.mockResolvedValue({ kind: "none" });
  stubs.stageIntake.mockResolvedValue({ ok: true, intakeId: "intake-1" });
  stubs.readAvailableSlots.mockResolvedValue({ ok: true, times: [] });
  stubs.readAvailableDays.mockResolvedValue({ ok: true, days: [] });
});

describe("the blood-type question", () => {
  it("is asked when a new file is opened for the sender themself", async () => {
    const result = await turn(
      [],
      context({ flows: bookingState(collected(false)) }),
    );
    expect(reply(result.effects)).toBe(COMPOSER_COPY["intake.ask_blood_type"]!.ar);
    // Optional, and the question says so, so a patient is never left guessing
    // whether they are allowed not to answer.
    expect(reply(result.effects)).toContain("اختيارية");
    expect(stubs.stageIntake).not.toHaveBeenCalled();
  });

  it("is asked about the patient when the file is for somebody else", async () => {
    const result = await turn(
      [],
      context({ flows: bookingState(collected(true)), identity: "linked" }),
    );
    expect(reply(result.effects)).toBe(
      COMPOSER_COPY["intake.ask_blood_type.other"]!.ar,
    );
  });

  it("is asked last, after everything the record actually requires", async () => {
    // Blood type must never be the reason a file is not opened, so it comes
    // after the required fields rather than before them.
    const withoutEmail = { ...collected(false) };
    delete (withoutEmail as Record<string, unknown>).email;
    const result = await turn([], context({ flows: bookingState(withoutEmail) }));
    expect(reply(result.effects)).toBe(COMPOSER_COPY["intake.ask_email"]!.ar);
  });

  it.each(["تخطي", "مش عارف", "معرفش", "لا أعرف", "skip", "not sure"])(
    "records %s as unknown rather than re-asking",
    async (answer) => {
      const result = await turn(
        [{ kind: "set_slot", slot: "blood_type", value: answer }],
        context({ flows: bookingState(collected(false)) }),
      );
      const frame = result.state.stack[0]!;
      expect(frame.slots.blood_type?.value).toBe(BLOOD_TYPE_UNKNOWN);
      // The question is answered, so it does not come back.
      expect(reply(result.effects)).not.toContain("فصيلة");
    },
  );

  it("writes null to the intake when the patient does not know", async () => {
    await turn(
      [{ kind: "set_slot", slot: "blood_type", value: "مش عارف" }],
      context({ flows: bookingState(collected(false)) }),
    );
    expect(stubs.stageIntake).toHaveBeenCalledWith(
      expect.objectContaining({ bloodType: null }),
    );
  });

  it.each([
    ["O+", "O+"],
    ["او موجب", "O+"],
    ["A-", "A-"],
    ["AB+", "AB+"],
  ])("carries a real group (%s) through to the intake", async (spoken, stored) => {
    const result = await turn(
      [{ kind: "set_slot", slot: "blood_type", value: spoken }],
      context({ flows: bookingState(collected(false)) }),
    );
    expect(result.state.stack[0]!.slots.blood_type?.value).toBe(stored);
    expect(stubs.stageIntake).toHaveBeenCalledWith(
      expect.objectContaining({ bloodType: stored }),
    );
  });

  it("never blocks the staging on an unreadable answer", async () => {
    // Anything that is not a blood group is recorded as unknown rather than
    // returned unresolved, because a step has no way past a slot it cannot
    // fill — and an optional field that can stall a booking is not optional.
    await turn(
      [{ kind: "set_slot", slot: "blood_type", value: "مش فاكر بصراحة" }],
      context({ flows: bookingState(collected(false)) }),
    );
    expect(stubs.stageIntake).toHaveBeenCalledWith(
      expect.objectContaining({ bloodType: null }),
    );
  });
});
