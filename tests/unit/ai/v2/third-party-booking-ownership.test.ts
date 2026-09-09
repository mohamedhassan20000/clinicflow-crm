/**
 * A booking for somebody else never lands on the requester's record.
 *
 * ## The manual QA this exists for
 *
 * A requester was linked to his WhatsApp thread and booked for his son:
 *
 * ```
 *   assistant: الحجز ده ليك إنت ولا لحد تاني؟
 *   patient:   لا مش ليا لإبني                 -> beneficiary = other
 *   ...
 *   assistant: ممكن رقم تليفون المريض؟
 *   patient:   نفس رقم تلفوني                  -> phone = the thread's own number
 *   ...
 *   assistant: تمام، سجلت بيانات المريض للمراجعة   <- said, and untrue
 *   assistant: الطلب في انتظار تأكيد العيادة       <- said, and untrue
 * ```
 *
 * What Production actually held afterwards: no intake for the son, no
 * appointment request, and one real `appointments` row for the **father**.
 *
 * Two defects composed, and each is covered separately below.
 *
 *   * **`stageIntake` reported a staging that did not happen.** The RPC is a
 *     `RETURNS TABLE(status, ...)` function and signals most outcomes as a
 *     status row rather than an exception; the boundary read only
 *     `result.error`. `ai_patient_intakes` carries a unique
 *     `(clinic_id, conversation_id)`, the upsert only updates
 *     `where review_status = 'pending_review'`, and this thread's one intake
 *     row had been approved an hour earlier — so the RPC returned
 *     `already_reviewed`, wrote nothing, and the flow recorded `intake_staged`.
 *   * **the write re-derived who the booking was for.**
 *     `createPatientPendingBooking` asked the database whether a *pending*
 *     third-party intake existed and read "no row" as "this is the sender's
 *     own booking" — so the linked branch created a real appointment on the
 *     father's file.
 *
 * The invariant these tests hold: **`beneficiary === "other"` can never create
 * an appointment for `conversations.patient_id`.** It is asserted at every
 * layer that could break it, and end to end through the engine.
 *
 * "Use my number" is not the defect and never was — it is covered here only to
 * prove that the sentence which unblocked this path fills a *contact* field and
 * nothing else. Phone equality collapses no identities: discovery is the
 * national id plus the canonical name, and two files sharing a number is a
 * family.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("server-only", () => ({}));

const CAIRO = "Africa/Cairo";
const NOW = new Date("2026-09-05T09:00:00.000Z");
const AT = NOW.toISOString();

/** The father. Linked to the thread, and the one record at risk. */
const REQUESTER_A = "patient-requester-a";
/** The number the father is messaging from, which the son's file will carry. */
const SENDER = "+905384316956";

// ---------------------------------------------------------------------------
// Module doubles
// ---------------------------------------------------------------------------

const booking = vi.hoisted(() => ({
  getPatientAvailableDays: vi.fn(),
  getPatientAvailableSlots: vi.fn(),
  createPatientPendingBooking: vi.fn(),
}));
vi.mock("@/lib/booking/patient", () => booking);

const identity = vi.hoisted(() => ({ authorizePatientConversation: vi.fn() }));
vi.mock("@/lib/ai/patient-authorization", () => identity);

const admin = vi.hoisted(() => ({
  createClinicScopedAdminClient: vi.fn(),
  getPatientClinicPublicInfo: vi.fn(async () => ({ data: null })),
  getClinicCurrency: vi.fn(async () => null),
  findClinicPatientByIdentity: vi.fn(),
  stagePatientIntakeFromConversation: vi.fn(),
  createPatientPreliminaryBookingWithPackage: vi.fn(),
  cancelPatientAiAppointment: vi.fn(),
  listClinicPublicPackages: vi.fn(),
  listPatientAiDocuments: vi.fn(),
  listPatientAiPackages: vi.fn(),
  signClinicDocumentUrl: vi.fn(),
  listPatientAiAppointments: vi.fn(),
  preparePatientAiReschedule: vi.fn(),
  reschedulePatientAiAppointment: vi.fn(),
  searchPatientClinicFaq: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => admin);

import { commitBooking, stageIntake } from "@/lib/ai/v2/tools";
import type { TurnContext } from "@/lib/ai/v2/context";

/** The RPC's real return shape: one row, carrying a status. */
function rpcStatus(status: string, intakeId: string | null = "intake-1") {
  return { error: null, data: [{ status, intake_id: intakeId, attempts_remaining: null }] };
}

function context(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    clinicId: "clinic-1",
    conversationId: "conv-1",
    turn: { text: "", receivedAt: AT, locale: "ar", attachments: [] },
    episode: { turns: [] },
    flows: { version: 1, stack: [] },
    durable: {
      treatingDoctors: async () => [],
      knownDepartments: async () => [],
      activePackages: async () => [],
      issuedDocuments: async () => [],
      appointments: async () => [],
      canonicalName: async () => null,
    },
    history: { search: async () => [] },
    identity: "linked",
    patientId: REQUESTER_A,
    participantAddress: SENDER,
    clinic: { name: "Clinic", timeZone: CAIRO, locale: "ar", country: "EG", timeFormat: "12h" },
    style: { language: "ar", arabicStyle: "egyptian", tone: "friendly", styleInstruction: null },
    now: NOW,
    ...overrides,
  } as unknown as TurnContext;
}

const INTAKE = {
  fullName: "Nour Mohamad Ali",
  nationalId: "500080807615",
  dateOfBirth: "2015-03-12",
  email: "nour@ex.com",
  departmentId: "dept-pt",
  doctorId: "doc-youssef",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  identity.authorizePatientConversation.mockResolvedValue({
    clinicId: "clinic-1",
    conversationId: "conv-1",
    clinicTimezone: CAIRO,
    linked: true,
    patientId: REQUESTER_A,
    collectedData: {},
  });
  booking.getPatientAvailableSlots.mockResolvedValue({
    ok: true,
    doctorId: "doc-youssef",
    doctorName: "Youssef Adel",
    date: "2026-09-09",
    availableSlots: ["09:00"],
    availabilityReason: "available",
    workingHours: [],
  });
  booking.createPatientPendingBooking.mockResolvedValue({
    ok: true,
    appointmentId: "req-1",
    expiresAt: AT,
    provisional: true,
  });
  admin.stagePatientIntakeFromConversation.mockResolvedValue(rpcStatus("staged"));
});

// ---------------------------------------------------------------------------
// Fix A — the staging boundary reads the status it is given
// ---------------------------------------------------------------------------

describe("stageIntake reports only a staging that actually happened", () => {
  const stage = (extra: Record<string, unknown> = {}) =>
    stageIntake({ context: context(), ...INTAKE, forThirdParty: true, phone: SENDER, ...extra });

  it("is ok for a row it wrote", async () => {
    admin.stagePatientIntakeFromConversation.mockResolvedValue(rpcStatus("staged"));
    expect(await stage()).toEqual({ ok: true });
  });

  it("is ok for a self-intake the RPC linked to the sender's own file", async () => {
    // `linked_existing` is a real patient — the RPC proved the sender's
    // identity and linked the conversation. A booking may proceed on it.
    admin.stagePatientIntakeFromConversation.mockResolvedValue(rpcStatus("linked_existing", null));
    expect(
      await stageIntake({ context: context(), ...INTAKE, forThirdParty: false, phone: null }),
    ).toEqual({ ok: true });
  });

  it("is NOT ok for already_reviewed — the exact Production outcome", async () => {
    // One intake row per conversation, and this thread's had been approved.
    // The RPC wrote nothing, raised nothing, and returned this.
    admin.stagePatientIntakeFromConversation.mockResolvedValue(rpcStatus("already_reviewed", null));
    expect(await stage()).toEqual({ ok: false, reason: "already_reviewed" });
  });

  it.each([
    "duplicate_review",
    "identity_mismatch",
    "identity_locked",
    "already_linked",
    "duplicate_ambiguous",
  ])("is NOT ok for %s", async (status) => {
    admin.stagePatientIntakeFromConversation.mockResolvedValue(rpcStatus(status, null));
    expect(await stage()).toEqual({ ok: false, reason: status });
  });

  it("is NOT ok for a result that carries no status row at all", async () => {
    // A shape nothing should produce. It must not read as success.
    admin.stagePatientIntakeFromConversation.mockResolvedValue({ error: null, data: [] });
    expect(await stage()).toEqual({ ok: false, reason: "unknown_status" });
  });

  it("still reports a transport error as the error it is", async () => {
    admin.stagePatientIntakeFromConversation.mockResolvedValue({
      error: { code: "PGRST301" },
      data: null,
    });
    expect(await stage()).toEqual({ ok: false, reason: "PGRST301" });
  });

  it("still refuses a third-party staging with no phone, before the RPC", async () => {
    expect(await stage({ phone: null })).toEqual({
      ok: false,
      reason: "third_party_phone_required",
    });
    expect(admin.stagePatientIntakeFromConversation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Fix B — the beneficiary reaches the write
// ---------------------------------------------------------------------------

describe("commitBooking carries the beneficiary to the write", () => {
  const commit = (forThirdParty: boolean, extra: Record<string, unknown> = {}) =>
    commitBooking({
      context: context(),
      doctorId: "doc-youssef",
      date: "2026-09-09",
      time: "09:00",
      durationMinutes: 30,
      forThirdParty,
      ...extra,
    });

  it("passes forThirdParty: true explicitly", async () => {
    await commit(true);
    expect(booking.createPatientPendingBooking).toHaveBeenCalledWith(
      expect.objectContaining({ forThirdParty: true }),
    );
  });

  it("passes forThirdParty: false for the sender's own booking", async () => {
    await commit(false);
    expect(booking.createPatientPendingBooking).toHaveBeenCalledWith(
      expect.objectContaining({ forThirdParty: false }),
    );
  });

  it("never spends the requester's package on somebody else's appointment", async () => {
    // `create_patient_preliminary_booking_v2` books for the conversation's
    // patient and decrements that patient's package. It cannot express a
    // third-party booking, so a third party must never reach it.
    const result = await commit(true, { packageId: "pkg-1" });
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(admin.createPatientPreliminaryBookingWithPackage).not.toHaveBeenCalled();
    expect(booking.createPatientPendingBooking).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// End to end, through the real engine and the real flow definitions
// ---------------------------------------------------------------------------

describe("the whole third-party path, through the engine", () => {
  it("holds the invariant end to end", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));

    const tools = {
      readDepartments: vi.fn(async () => []),
      readDoctors: vi.fn(async () => []),
      resolveDoctorSpoken: vi.fn(async () => ({ kind: "unresolved" })),
      resolveDepartmentSpoken: vi.fn(async () => []),
      resolveDepartmentNamed: vi.fn(async () => ({ kind: "unresolved" })),
      readAvailableDays: vi.fn(async () => ({ ok: true, days: [] })),
      readAvailableSlots: vi.fn(async () => ({ ok: true, times: [] })),
      readPatientPackages: vi.fn(async () => []),
      readPublicPackages: vi.fn(async () => []),
      readServices: vi.fn(async () => ({ groups: [], currency: "TRY", total: 0 })),
      readPatientDocuments: vi.fn(async () => []),
      readDocumentLink: vi.fn(),
      readMyAppointments: vi.fn(async () => []),
      readTreatingDoctors: vi.fn(async () => []),
      readClinicInfo: vi.fn(async () => null),
      readClinicFaq: vi.fn(async () => []),
      readRescheduleTarget: vi.fn(),
      readKnownDepartments: vi.fn(async () => []),
      resolveIdentity: vi.fn(async () => ({ kind: "none" })),
      stageIntake: vi.fn(async () => ({ ok: true })),
      commitBooking: vi.fn(async () => ({
        ok: true,
        appointmentId: "req-for-b",
        packageSessionNumber: null,
      })),
      commitCancellation: vi.fn(),
      commitReschedule: vi.fn(),
    };
    vi.doMock("@/lib/ai/v2/tools", () => tools);

    const { runEngine } = await import("@/lib/ai/v2/engine");
    const { FLOW_REGISTRY } = await import("@/lib/ai/v2/flows");
    const { newFrame } = await import("@/lib/ai/v2/flow-state");
    type State = Awaited<ReturnType<typeof runEngine>>["state"];

    const slot = (value: string) => ({ value, provenance: "spoken" as const, at: AT });
    /** «لا مش ليا لإبني», then the calendar, as the QA left it. */
    const started = {
      version: 1 as const,
      stack: [
        {
          ...newFrame({ flow: "book_appointment", at: AT }),
          slots: {
            beneficiary: slot("other"),
            department: slot("dept-pt"),
            doctor: slot("doc-youssef"),
            day: slot("2026-09-09"),
            time: slot("12:30"),
            full_name: slot("نور محمد علي"),
            full_name_latin: slot("Nour Mohamad Ali"),
            national_id: slot("500080807615"),
            date_of_birth: slot("2015-03-12"),
            email: slot("nour@ex.com"),
          },
        },
      ],
    };

    const ctx = (text: string, flows: unknown, extra: Record<string, unknown> = {}) =>
      ({
        ...context(),
        flows,
        turn: { text, receivedAt: AT, locale: "ar", attachments: [] },
        ...extra,
      }) as unknown as TurnContext;

    const turn = (commands: unknown[], on: TurnContext) =>
      runEngine({ context: on, commands: commands as never, registry: FLOW_REGISTRY });

    const frameOf = (state: State) => state.stack[state.stack.length - 1]!;
    const asked = (effects: readonly { kind: string }[]) =>
      effects.find((effect) => effect.kind === "ask") as { slot?: string } | undefined;

    // --- the phone question, answered with «نفس رقم تلفوني» ---------------
    const atPhone = await turn([], ctx("", started));
    expect(asked(atPhone.effects)?.slot).toBe("phone");

    const phoned = await turn(
      [{ kind: "ask_clarification", reason: "ambiguous_value" }],
      ctx("نفس رقم تلفوني", atPhone.state),
    );
    // Contact data, and nothing else: the beneficiary and the thread's owner
    // are exactly what they were.
    expect(frameOf(phoned.state).slots.phone?.value).toBe(SENDER);
    expect(frameOf(phoned.state).slots.beneficiary?.value).toBe("other");
    expect(frameOf(phoned.state).slots.full_name?.value).toBe("نور محمد علي");

    // --- staging fails the way Production failed --------------------------
    tools.stageIntake.mockResolvedValue({ ok: false, reason: "already_reviewed" } as never);
    const refused = await turn(
      [{ kind: "set_slot", slot: "blood_type", value: "B+" }],
      ctx("B+", phoned.state),
    );
    // The sender's number went to staging as the beneficiary's contact number.
    expect(tools.stageIntake).toHaveBeenCalledWith(
      expect.objectContaining({ forThirdParty: true, phone: SENDER }),
    );
    // And a staging that did not happen is not recorded as one.
    expect(frameOf(refused.state).memo.intake_staged).toBeUndefined();
    expect(refused.effects.some((effect) => effect.kind === "handoff")).toBe(true);
    expect(tools.commitBooking).not.toHaveBeenCalled();

    // --- even if the patient says yes, nothing is written -----------------
    const pressed = await turn(
      [{ kind: "affirm_offer", offerId: "any" }],
      ctx("اه اكد الطلب", refused.state),
    );
    expect(tools.commitBooking).not.toHaveBeenCalled();
    expect(frameOf(pressed.state).memo.intake_staged).toBeUndefined();

    // --- the clean path: staging works, and the write is told who it is for
    tools.stageIntake.mockResolvedValue({ ok: true } as never);
    const staged = await turn(
      [{ kind: "set_slot", slot: "blood_type", value: "B+" }],
      ctx("B+", phoned.state),
    );
    expect(frameOf(staged.state).memo.intake_staged).toBe(true);
    const summary = staged.effects.find((effect) => effect.kind === "offer");
    expect(summary).toBeDefined();

    const confirmed = await turn(
      [
        {
          kind: "affirm_offer",
          offerId: (summary as unknown as { offer: { id: string } }).offer.id,
        },
      ],
      ctx("اه", staged.state),
    );
    expect(tools.commitBooking).toHaveBeenCalledTimes(1);
    expect(tools.commitBooking).toHaveBeenCalledWith(
      expect.objectContaining({ forThirdParty: true }),
    );
    expect(confirmed.effects.some((effect) => effect.kind === "handoff")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Approval — the far end of the path, asserted against the deployed SQL
// ---------------------------------------------------------------------------

describe("approval creates the file for B and leaves the thread A's", () => {
  const migration = readFileSync(
    "supabase/migrations/20260918120000_bilingual_patient_names_and_package_service.sql",
    "utf8",
  );
  const approve = migration.slice(migration.indexOf("function public.approve_ai_patient_intake"));

  it("creates the beneficiary's own patient row and books the appointment on it", () => {
    expect(approve).toContain("insert into public.patients");
    expect(approve).toContain("insert into public.appointments");
    // `v_patient_id` is the beneficiary throughout — never the requester.
    expect(approve).toContain("v_request.clinic_id, v_patient_id, v_request.doctor_id");
    expect(approve).toContain("set status = 'linked', appointment_id = v_appointment_id");
  });

  it("never moves the conversation onto the beneficiary on a third-party approval", () => {
    // The relink block is gated, so `conversations.patient_id` stays the
    // requester's and the thread keeps its own verification state.
    expect(approve).toContain("if not v_third_party then");
    const relink = approve.slice(approve.indexOf("if not v_third_party then"));
    expect(relink).toContain("set patient_id = v_patient_id, patient_link_status = 'manual'");
  });

  it("does not consult the phone when choosing whose file this is", () => {
    // Identity is the national id and the canonical name. A shared number is
    // contact data, so a son on his father's number gets his own file.
    const decision = approve.slice(
      approve.indexOf("v_third_party := "),
      approve.indexOf("insert into public.patients"),
    );
    expect(decision).not.toContain("p.phone = ");
    expect(decision).toContain("matched_patient_id");
  });
});

// ---------------------------------------------------------------------------
// The invariant, stated once more against the source
// ---------------------------------------------------------------------------

describe("the invariant is structural, not incidental", () => {
  it("the confirm step reads the beneficiary at the moment of the write", () => {
    const flows = readFileSync("lib/ai/v2/flows.ts", "utf8");
    const confirm = flows.slice(flows.indexOf("const result = await tools.commitBooking({"));
    expect(confirm).toContain('forThirdParty: frame.slots.beneficiary?.value === "other"');
  });

  it("the write treats the caller's beneficiary as authority, the lookup as a guard", () => {
    const patient = readFileSync("lib/booking/patient.ts", "utf8");
    expect(patient).toContain(
      "input.forThirdParty === true || pendingIntake.data?.is_third_party === true",
    );
  });
});
