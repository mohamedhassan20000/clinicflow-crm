/**
 * The three follow-ups closed before DB integration:
 *
 *   1. a booking write that loses the slot no longer ends the flow;
 *   2. `verified` requires linkage as well as verification evidence;
 *   3. a signed document URL never enters the model's input.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const stubs = vi.hoisted(() => ({
  readDepartments: vi.fn(),
  readDoctors: vi.fn(),
  resolveDoctorSpoken: vi.fn(),
  readAvailableDays: vi.fn(),
  readAvailableSlots: vi.fn(),
  readPatientPackages: vi.fn(),
  readPublicPackages: vi.fn(),
  readPatientDocuments: vi.fn(),
  readDocumentLink: vi.fn(),
  readMyAppointments: vi.fn(),
  readTreatingDoctors: vi.fn(),
  readKnownDepartments: vi.fn(),
  readClinicInfo: vi.fn(),
  readClinicFaq: vi.fn(),
  readRescheduleTarget: vi.fn(),
  resolveIdentity: vi.fn(),
  stageIntake: vi.fn(),
  commitBooking: vi.fn(),
  commitCancellation: vi.fn(),
  commitReschedule: vi.fn(),
}));
vi.mock("@/lib/ai/v2/tools", () => stubs);

/** Captures exactly what the provider was asked, on every generation. */
const generateText = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({ generateText }));

const identity = vi.hoisted(() => ({ authorizePatientConversation: vi.fn() }));
vi.mock("@/lib/ai/patient-authorization", () => identity);
vi.mock("@/lib/supabase/admin", () => ({
  getClinicAiReplyContext: vi.fn(async () => ({ data: { time_format: "24h" }, error: null })),
}));

import { activeFrame, newFrame, type FlowState, type Slot } from "@/lib/ai/v2/flow-state";
import { runEngine, type Effect } from "@/lib/ai/v2/engine";
import { FLOW_REGISTRY } from "@/lib/ai/v2/flows";
import { compose, composeDeterministic } from "@/lib/ai/v2/composer";
import { buildTurnContext } from "@/lib/ai/v2/assemble";
import { EMPTY_FLOW_STATE } from "@/lib/ai/v2/flow-state";
import type { TurnContext } from "@/lib/ai/v2/context";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const AT = NOW.toISOString();
const STYLE = {
  language: "ar" as const,
  arabicStyle: "egyptian" as const,
  tone: "friendly" as const,
  styleInstruction: null,
};

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
    identity: "verified",
    patientId: "patient-1",
    clinic: {
      name: "Clinic",
      timeZone: "Africa/Cairo",
      locale: "ar",
      country: "EG",
      timeFormat: "24h",
    },
    style: STYLE,
    now: NOW,
    ...overrides,
  };
}

function slotValue(value: string): Slot {
  return { value, provenance: "spoken", at: AT };
}

function frameWith(
  flow: Parameters<typeof newFrame>[0]["flow"],
  slots: Record<string, Slot> = {},
  extra: Partial<ReturnType<typeof newFrame>> = {},
): FlowState {
  return { version: 1, stack: [{ ...newFrame({ flow, at: AT }), slots, ...extra }] };
}

const CONFIRMED_BOOKING = frameWith(
  "book_appointment",
  {
    beneficiary: slotValue("self"),
    department: slotValue("dept-derma"),
    doctor: slotValue("doc-nabil"),
    day: slotValue("2026-09-10"),
    time: slotValue("10:00"),
  },
  { memo: { confirmed: true, confirmed_at: AT } },
);

beforeEach(() => {
  vi.clearAllMocks();
  stubs.readDepartments.mockResolvedValue([
    { value: "dept-derma", label: "الجلدية", source: "clinic_directory" },
  ]);
  stubs.readDoctors.mockResolvedValue([
    { value: "doc-nabil", label: "Ahmed Nabil", source: "clinic_directory" },
  ]);
  stubs.readAvailableDays.mockResolvedValue({
    ok: true,
    windowStart: "2026-09-05",
    windowEnd: "2026-09-11",
    days: [{ value: "2026-09-10", label: "2026-09-10", source: "clinic_directory" }],
  });
  stubs.readAvailableSlots.mockResolvedValue({
    ok: true,
    times: [
      { value: "11:00", label: "11:00", source: "clinic_directory" },
      { value: "12:00", label: "12:00", source: "clinic_directory" },
    ],
  });
  stubs.readPatientPackages.mockResolvedValue([]);
  stubs.readMyAppointments.mockResolvedValue([]);
  stubs.readTreatingDoctors.mockResolvedValue([]);
  stubs.readKnownDepartments.mockResolvedValue([]);
  stubs.stageIntake.mockResolvedValue({ ok: true });
  stubs.commitBooking.mockResolvedValue({
    ok: true,
    appointmentId: "appt-1",
    packageSessionNumber: null,
  });
  generateText.mockResolvedValue({ text: "polished" });
});

async function turn(ctx: TurnContext) {
  return runEngine({ context: ctx, commands: [], registry: FLOW_REGISTRY });
}

// ===========================================================================
// 1 — the booking collision
// ===========================================================================

describe("follow-up 1: a lost slot does not end the booking", () => {
  beforeEach(() => {
    stubs.commitBooking.mockResolvedValue({ ok: false, reason: "slot_taken" });
  });

  it("keeps the flow alive instead of completing it", async () => {
    const result = await turn(context({ flows: CONFIRMED_BOOKING }));

    expect(result.trace).toContain("step_confirm_invalidate");
    expect(result.trace).not.toContain("flow_completed");
    // The defect: the stack emptied and the patient's next message started over.
    expect(result.state.stack).toHaveLength(1);
    expect(activeFrame(result.state)?.status).toBe("active");
  });

  it("clears the time and the confirmation that was about it", async () => {
    const frame = activeFrame(
      (await turn(context({ flows: CONFIRMED_BOOKING }))).state,
    )!;
    expect(frame.slots.time).toBeUndefined();
    expect(frame.memo.confirmed).toBeUndefined();
    expect(frame.memo.confirmed_at).toBeUndefined();
  });

  it("keeps everything upstream of the time", async () => {
    const frame = activeFrame(
      (await turn(context({ flows: CONFIRMED_BOOKING }))).state,
    )!;
    expect(frame.slots.department?.value).toBe("dept-derma");
    expect(frame.slots.doctor?.value).toBe("doc-nabil");
    expect(frame.slots.day?.value).toBe("2026-09-10");
    expect(frame.slots.beneficiary?.value).toBe("self");
  });

  it("keeps an accepted package, which was never consumed", async () => {
    const withPackage = frameWith(
      "book_appointment",
      {
        beneficiary: slotValue("self"),
        department: slotValue("dept-derma"),
        doctor: slotValue("doc-nabil"),
        day: slotValue("2026-09-10"),
        time: slotValue("10:00"),
      },
      { memo: { confirmed: true, package_accepted: true, package_id: "pkg-1" } },
    );
    const frame = activeFrame((await turn(context({ flows: withPackage }))).state)!;
    expect(frame.memo.package_accepted).toBe(true);
    expect(frame.memo.package_id).toBe("pkg-1");
  });

  it("returns the patient to the time step with live availability", async () => {
    const result = await turn(context({ flows: CONFIRMED_BOOKING }));

    expect(result.trace).toContain("step_time_offer");
    const offer = result.effects.find((effect) => effect.kind === "offer");
    expect(offer).toMatchObject({ key: "booking.choose_time" });
    const options = (offer as Extract<Effect, { kind: "offer" }>).offer.options;
    expect(options.map((option) => option.value)).toEqual(["11:00", "12:00"]);
    // Said and offered in one message.
    const text = composeDeterministic({ effects: result.effects, locale: "ar" }).text;
    expect(text).toContain("اتحجز للأسف");
    expect(text).toContain("11:00");
  });

  it("attempts the write exactly once and does not retry it", async () => {
    const result = await turn(context({ flows: CONFIRMED_BOOKING }));
    expect(stubs.commitBooking).toHaveBeenCalledTimes(1);

    // The next turn cannot write either: consent went with the time.
    stubs.commitBooking.mockClear();
    const next = await turn(context({ flows: result.state }));
    expect(stubs.commitBooking).not.toHaveBeenCalled();
    expect(activeFrame(next.state)?.memo.confirmed).toBeUndefined();
  });

  it("requires a fresh confirmation before writing again", async () => {
    const collided = await turn(context({ flows: CONFIRMED_BOOKING }));
    stubs.commitBooking.mockReset();
    stubs.commitBooking.mockResolvedValue({
      ok: true,
      appointmentId: "appt-2",
      packageSessionNumber: null,
    });

    // Pick a new time...
    const picked = await runEngine({
      context: context({ flows: collided.state }),
      commands: [{ kind: "set_slot", slot: "time", value: "11:00" }],
      registry: FLOW_REGISTRY,
    });
    expect(stubs.commitBooking).not.toHaveBeenCalled();
    const summary = picked.effects.find((effect) => effect.kind === "offer");
    expect(summary).toMatchObject({ key: "booking.review" });

    // ...and only affirming the new summary writes.
    const confirmed = await runEngine({
      context: context({ flows: picked.state }),
      commands: [
        {
          kind: "affirm_offer",
          offerId: (summary as Extract<Effect, { kind: "offer" }>).offer.id,
        },
      ],
      registry: FLOW_REGISTRY,
    });
    expect(stubs.commitBooking).toHaveBeenCalledTimes(1);
    expect(stubs.commitBooking).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledAt: "2026-09-10T11:00:00" }),
    );
    expect(confirmed.trace).toContain("step_confirm_complete");
  });

  it("still hands over when there is nothing left to offer", async () => {
    stubs.readAvailableSlots.mockResolvedValue({ ok: true, times: [] });
    const result = await turn(context({ flows: CONFIRMED_BOOKING }));
    // Not a loop and not a silent turn: the time step asks, and the flow lives.
    expect(result.trace).toContain("step_time_ask");
    expect(activeFrame(result.state)?.status).toBe("active");
  });
});

// ===========================================================================
// 2 — identity level
// ===========================================================================

describe("follow-up 2: `verified` requires linkage and evidence", () => {
  function resolved(overrides: Record<string, unknown>) {
    identity.authorizePatientConversation.mockResolvedValue({
      patientId: "patient-1",
      linked: true,
      identityVerifiedAt: "2026-09-01T00:00:00.000Z",
      patientDisplayName: "أنس طلال",
      clinicName: "Clinic",
      clinicTimezone: "Africa/Cairo",
      clinicLocale: "ar",
      clinicCountry: "EG",
      ...overrides,
    });
    return buildTurnContext({
      clinicId: "clinic-1",
      conversationId: "conv-1",
      message: "أهلا",
      locale: "ar",
      style: STYLE,
      episode: [],
      flows: EMPTY_FLOW_STATE,
      now: NOW,
    });
  }

  it("is verified only when linked, identified and proven", async () => {
    expect((await resolved({})).identity).toBe("verified");
  });

  it("is linked when the file is selected but nothing was proven", async () => {
    expect((await resolved({ identityVerifiedAt: null })).identity).toBe("linked");
  });

  it("refuses to call a stamp without linkage `verified`", async () => {
    // The inconsistent record: a verification stamp on a thread that no longer
    // selects a file. It used to be the most trusted state there is.
    const context = await resolved({ linked: false });
    expect(context.identity).toBe("anonymous");
    expect(context.patientId).toBeNull();
  });

  it("refuses to call a stamp without a patient `verified`", async () => {
    const context = await resolved({ patientId: null });
    expect(context.identity).toBe("anonymous");
    expect(context.patientId).toBeNull();
  });

  it("treats a linked flag with no patient id as anonymous", async () => {
    const context = await resolved({ patientId: null, identityVerifiedAt: null });
    expect(context.identity).toBe("anonymous");
  });

  it("withholds patient-scoped facts in every inconsistent state", async () => {
    for (const broken of [{ linked: false }, { patientId: null }]) {
      const context = await resolved(broken);
      expect(await context.durable.activePackages()).toEqual([]);
      expect(await context.durable.issuedDocuments()).toEqual([]);
      expect(await context.durable.treatingDoctors()).toEqual([]);
      expect(await context.durable.canonicalName()).toBeNull();
    }
    expect(stubs.readPatientPackages).not.toHaveBeenCalled();
    expect(stubs.readPatientDocuments).not.toHaveBeenCalled();
  });

  it("blocks a document retrieval that an unlinked stamp used to unlock", async () => {
    const unlinked = await resolved({ linked: false });
    const result = await runEngine({
      context: { ...unlinked, flows: frameWith("retrieve_document") },
      commands: [],
      registry: FLOW_REGISTRY,
    });
    expect(result.trace).toContain("step_identity_required");
    expect(stubs.readPatientDocuments).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 3 — the signed document URL
// ===========================================================================

describe("follow-up 3: a signed URL never reaches the model", () => {
  const URL = "https://storage.example/documents/inv.pdf?token=SECRET-BEARER-TOKEN";
  const effects: Effect[] = [
    {
      kind: "say",
      key: "documents.delivered",
      facts: { url: URL, label: "INVOICE INV-2026-0001" },
    },
  ];

  it("keeps it out of the deterministic sentence", () => {
    const base = composeDeterministic({ effects, locale: "ar" });
    expect(base.text).not.toContain(URL);
    expect(base.text).not.toContain("SECRET-BEARER-TOKEN");
    expect(base.links).toEqual([URL]);
    // The label is ordinary text and stays where the model can improve it.
    expect(base.text).toContain("INVOICE INV-2026-0001");
  });

  it("keeps it out of the facts the grounding check is built from", () => {
    expect(Object.values(composeDeterministic({ effects, locale: "ar" }).facts)).not.toContain(URL);
  });

  it("never appears anywhere in the model's input", async () => {
    await compose({
      effects,
      locale: "ar",
      style: STYLE,
      execution: { model: "m", providerOptions: {} } as never,
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    // The whole request, not just the parts we expect to be risky.
    const request = JSON.stringify(generateText.mock.calls[0]![0]);
    expect(request).not.toContain(URL);
    expect(request).not.toContain("SECRET-BEARER-TOKEN");
    expect(request).not.toContain("storage.example");
  });

  it("still delivers the link to the patient, unaltered", async () => {
    generateText.mockResolvedValue({ text: "اتفضل INVOICE INV-2026-0001. الرابط ده صالح لمدة قصيرة:" });
    const result = await compose({
      effects,
      locale: "ar",
      style: STYLE,
      execution: { model: "m", providerOptions: {} } as never,
    });
    expect(result.text).toContain(URL);
    // Appended after the prose, byte for byte.
    expect(result.text.endsWith(URL)).toBe(true);
  });

  it("delivers it even when the model is unavailable", async () => {
    const result = await compose({ effects, locale: "ar", style: STYLE, execution: null });
    expect(result.text).toContain(URL);
    expect(result.outcome).toBe("deterministic");
    expect(generateText).not.toHaveBeenCalled();
  });

  it("delivers it even when the polish is rejected by the grounding gate", async () => {
    // A rewrite that dropped the label falls back to the deterministic text;
    // the link must survive that path too.
    generateText.mockResolvedValue({ text: "اتفضل" });
    const result = await compose({
      effects,
      locale: "ar",
      style: STYLE,
      execution: { model: "m", providerOptions: {} } as never,
    });
    expect(result.outcome).toBe("deterministic");
    expect(result.text).toContain(URL);
  });

  it("adds no link line when there is no link", async () => {
    const result = await compose({
      effects: [{ kind: "say", key: "small_talk.greeting" }],
      locale: "ar",
      style: STYLE,
      execution: null,
    });
    expect(result.text.trim()).toBe(result.text);
    expect(result.text).not.toContain("\n");
  });
});
