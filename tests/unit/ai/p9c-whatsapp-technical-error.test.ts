/**
 * P9C — the real WhatsApp turns that ended in "there is a technical problem".
 *
 * Production conversation 763b1c6b-c388-4f36-b8ca-965f71f20f86, replayed as the
 * boundary that actually broke. The audit trail is unambiguous about where that
 * was, and it is *not* where the previous fix looked:
 *
 *   turn 5  "احمد نبيل"        → `list_available_days` ran, `service_not_found`
 *   turn 7  "بكرا ايه متاح؟"   → two model steps, **zero** `agent_tool:` rows
 *   turn 8  "طيب بعد بكرا؟"    → one step, no tool, the apology again
 *
 * A turn with model steps and no audit row is a turn whose tool call never
 * reached `execute`. The tools declared `doctor_id: z.string().uuid()`, and the
 * model — answering a patient who had just said a doctor's *name* out loud —
 * sent the name. Zod refused it inside the AI SDK's `parseToolCall`, so:
 * nothing ran, nothing was audited, none of the recoverable-roster machinery in
 * `booking-target.ts` could run, and the model received a raw validator error,
 * which is exactly the input that produces "sorry, technical problem, here is
 * the clinic's phone number".
 *
 * So the assertions here are about the boundary, not about the wording:
 *
 *   1. every one of these calls is *accepted* by the schema — a rejected call
 *      is unrecoverable by construction, whatever the code behind it does;
 *   2. a doctor named in Arabic resolves to the real doctor and the days come
 *      back;
 *   3. no result on a valid, recoverable booking state carries
 *      `technical_error`; and
 *   4. anything still unparseable is repaired into a real call rather than
 *      handed to the model as an error.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "763b1c6b-c388-4f36-b8ca-965f71f20f86";
const DERMATOLOGY = "dddddddd-0000-4000-8000-000000000001";
const NABIL = "aaaaaaaa-0000-4000-8000-000000000001";
const SARA = "aaaaaaaa-0000-4000-8000-000000000002";
const PATIENT = "bbbbbbbb-0000-4000-8000-000000000001";

const mocks = vi.hoisted(() => ({
  directory: vi.fn(),
  authorize: vi.fn(),
  persist: vi.fn().mockResolvedValue({ data: null, error: null }),
  clinicInfo: vi.fn().mockResolvedValue({ data: { phone: "+20 2 1111 2222" }, error: null }),
  pendingIntake: vi.fn().mockResolvedValue({ data: null, error: null }),
  availableDays: vi.fn(),
  availableSlots: vi.fn(),
  createBooking: vi.fn(),
  audit: vi.fn().mockResolvedValue(undefined),
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
  getPendingConversationIntake: mocks.pendingIntake,
  createClinicScopedAdminClient: () => {
    throw new Error("no table access is expected on these paths");
  },
}));
vi.mock("@/lib/ai/doctor-directory", async (original) => {
  const actual = await original<typeof import("@/lib/ai/doctor-directory")>();
  return { ...actual, loadDoctorDirectory: mocks.directory };
});
vi.mock("@/lib/booking/patient", () => ({
  getPatientAvailableDays: mocks.availableDays,
  getPatientAvailableSlots: mocks.availableSlots,
  createPatientPendingBooking: mocks.createBooking,
}));

import { EMPTY_BOOKING_STAGE_STATE } from "@/lib/ai/booking-stage";
import { checkPatientAvailabilityTool } from "@/lib/ai/tools/check-patient-availability";
import { createPreliminaryBookingTool } from "@/lib/ai/tools/create-preliminary-booking";
import { listAvailableDaysTool } from "@/lib/ai/tools/list-available-days";
import { createPatientToolCallRepair } from "@/lib/ai/tool-call-repair";
import { recordOfferedDays, recordOfferedSlots } from "@/lib/ai/booking-stage";

const opts = {} as never;
const ctx = { clinicId: CLINIC, conversationId: CONVERSATION, locale: "ar" as const };

/** The conversation exactly as production had it: a date, and nothing else. */
function identity(collected: Record<string, string | number> = {}) {
  return {
    clinicId: CLINIC,
    conversationId: CONVERSATION,
    patientId: PATIENT,
    linked: true,
    identityVerifiedAt: "2026-08-22T19:00:00.000Z",
    identityLockedUntil: null,
    clinicName: "ClinicFlow",
    clinicLocale: "ar" as const,
    clinicTimezone: "Africa/Cairo",
    clinicCountry: "EG",
    participantAddress: "+201000000000",
    aiPaused: false,
    collectedData: collected,
    pendingClarification: null,
    bookingStage: { ...EMPTY_BOOKING_STAGE_STATE },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AI_PATIENT_STAGE_ORCHESTRATION;
  mocks.directory.mockResolvedValue({
    departments: [{ id: DERMATOLOGY, name: "Dermatology" }],
    doctors: [
      {
        id: NABIL,
        name: "Ahmed Nabil",
        departmentId: DERMATOLOGY,
        departmentName: "Dermatology",
        state: "available",
        unavailableUntil: null,
      },
      {
        id: SARA,
        name: "Sara Ali",
        departmentId: DERMATOLOGY,
        departmentName: "Dermatology",
        state: "available",
        unavailableUntil: null,
      },
    ],
  });
  mocks.persist.mockResolvedValue({ data: null, error: null });
  mocks.pendingIntake.mockResolvedValue({ data: null, error: null });
  mocks.availableDays.mockResolvedValue({
    ok: true,
    doctorId: NABIL,
    doctorName: "Ahmed Nabil",
    availableDays: [
      { date: "2026-08-24", slotCount: 6 },
      { date: "2026-08-25", slotCount: 4 },
    ],
    minimumNoticeHours: 24,
  });
  mocks.availableSlots.mockResolvedValue({
    ok: true,
    doctorId: NABIL,
    doctorName: "Ahmed Nabil",
    date: "2026-08-24",
    availableSlots: ["10:00", "10:30"],
    availabilityReason: "open",
    workingHours: [],
  });
});

/** Every payload the model can ever see must be free of the technical fallback. */
function expectRecoverable(result: unknown) {
  expect(result).toBeTypeOf("object");
  expect((result as Record<string, unknown>).technical_error).toBeUndefined();
}

describe("P9C · the turns that produced the technical-error fallback", () => {
  it("accepts the doctor named in Arabic, where the schema used to refuse", () => {
    // The exact argument the model produced on turn 5. `.uuid()` rejected this
    // before `execute`, which is the whole bug: a refused call cannot recover.
    const schema = listAvailableDaysTool(ctx).inputSchema as unknown as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ doctor_id: "احمد نبيل" }).success).toBe(true);
    expect(schema.safeParse({ doctor_id: "Dr. Ahmed Nabil" }).success).toBe(true);
    expect(schema.safeParse({ doctor_id: NABIL }).success).toBe(true);

    const availability = checkPatientAvailabilityTool(ctx).inputSchema as unknown as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(
      availability.safeParse({ date: "بكرا", doctor_id: "احمد نبيل" }).success,
    ).toBe(true);
    // A service the model invented in words is a filter it got wrong, not a
    // reason to refuse the turn.
    expect(
      availability.safeParse({ date: "24", doctor_id: NABIL, service_id: "كشف جلدية" })
        .success,
    ).toBe(true);
  });

  it('"احمد نبيل" → the real doctor, real days, and the selection is written down', async () => {
    mocks.authorize.mockResolvedValue(identity({ appointment_date: "2026-08-23" }));

    const result = (await listAvailableDaysTool(ctx).execute!(
      { doctor_id: "احمد نبيل", duration_minutes: 30, search_days: 21 },
      opts,
    )) as Record<string, unknown>;

    expectRecoverable(result);
    expect(result.ok).toBe(true);
    expect(result.doctor_name).toBe("Ahmed Nabil");
    expect(result.availableDays).toEqual([
      { date: "2026-08-24", slotCount: 6 },
      { date: "2026-08-25", slotCount: 4 },
    ]);
    // The engine was called with the clinic's own id, never with the name.
    expect(mocks.availableDays).toHaveBeenCalledWith(
      expect.objectContaining({ doctorId: NABIL, serviceId: null }),
    );
    // And the doctor survives the turn, which is what stopped the conversation
    // re-deriving `selecting_department` forever.
    expect(mocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        collected: expect.objectContaining({
          doctor_id: NABIL,
          department_id: DERMATOLOGY,
        }),
      }),
    );
  });

  it('"بكره ايه متاح؟" resolves the day against the clinic timezone, not an error', async () => {
    mocks.authorize.mockResolvedValue(
      identity({ department_id: DERMATOLOGY, doctor_id: NABIL }),
    );

    const result = (await checkPatientAvailabilityTool(ctx).execute!(
      { date: "بكرا", doctor_id: "احمد نبيل", duration_minutes: 30 },
      opts,
    )) as Record<string, unknown>;

    expectRecoverable(result);
    expect(mocks.availableSlots).toHaveBeenCalledWith(
      expect.objectContaining({ doctorId: NABIL }),
    );
  });

  it('"طيب يوم 24؟" resolves to the 24th this conversation was offered', async () => {
    // The days `list_available_days` put in front of this patient one turn ago.
    // A bare "24" is them choosing one of those, and nothing else.
    const withOffer = identity({ department_id: DERMATOLOGY, doctor_id: NABIL });
    withOffer.bookingStage = {
      ...withOffer.bookingStage,
      offeredDays: ["2026-08-24", "2026-08-25"],
    };
    mocks.authorize.mockResolvedValue(withOffer);

    const result = (await checkPatientAvailabilityTool(ctx).execute!(
      { date: "24", doctor_id: NABIL, duration_minutes: 30 },
      opts,
    )) as Record<string, unknown>;

    expectRecoverable(result);
    expect(result.needs_clarification).toBeUndefined();
    expect(mocks.availableSlots).toHaveBeenCalledWith(
      expect.objectContaining({ date: "2026-08-24", doctorId: NABIL }),
    );
  });

  it('"طيب يوم 24؟" with Arabic-Indic digits resolves the same way', async () => {
    const withOffer = identity({ department_id: DERMATOLOGY, doctor_id: NABIL });
    withOffer.bookingStage = {
      ...withOffer.bookingStage,
      offeredDays: ["2026-08-24", "2026-08-25"],
    };
    mocks.authorize.mockResolvedValue(withOffer);

    await checkPatientAvailabilityTool(ctx).execute!(
      { date: "٢٤", doctor_id: NABIL, duration_minutes: 30 },
      opts,
    );

    expect(mocks.availableSlots).toHaveBeenCalledWith(
      expect.objectContaining({ date: "2026-08-24" }),
    );
  });

  it("a bare day nobody offered is still asked about, never invented", async () => {
    const withOffer = identity({ department_id: DERMATOLOGY, doctor_id: NABIL });
    withOffer.bookingStage = {
      ...withOffer.bookingStage,
      offeredDays: ["2026-08-24", "2026-08-25"],
    };
    mocks.authorize.mockResolvedValue(withOffer);

    const result = (await checkPatientAvailabilityTool(ctx).execute!(
      { date: "17", doctor_id: NABIL, duration_minutes: 30 },
      opts,
    )) as Record<string, unknown>;

    // Recoverable, and specifically *not* resolved: the offered-days shortcut
    // must never manufacture a day the patient was not shown.
    expectRecoverable(result);
    expect(result.needs_clarification).toBe(true);
    expect(mocks.availableSlots).not.toHaveBeenCalled();
  });

  it("an unknown service name is dropped, never turned into service_not_found", async () => {
    mocks.authorize.mockResolvedValue(
      identity({ department_id: DERMATOLOGY, doctor_id: NABIL }),
    );

    const result = (await listAvailableDaysTool(ctx).execute!(
      {
        doctor_id: "احمد نبيل",
        service_id: "كشف جلدية",
        duration_minutes: 30,
        search_days: 21,
      },
      opts,
    )) as Record<string, unknown>;

    expectRecoverable(result);
    expect(result.ok).toBe(true);
    expect(result.service_ignored).toBe(true);
    expect(mocks.availableDays).toHaveBeenCalledWith(
      expect.objectContaining({ serviceId: null }),
    );
  });

  it("a doctor this clinic does not have comes back as the roster", async () => {
    mocks.authorize.mockResolvedValue(identity({ department_id: DERMATOLOGY }));

    const result = (await listAvailableDaysTool(ctx).execute!(
      { doctor_id: "دكتور مينا سمير", duration_minutes: 30, search_days: 21 },
      opts,
    )) as Record<string, unknown>;

    expectRecoverable(result);
    expect(result.needs_selection).toBe(true);
    expect(result.field).toBe("doctor");
    expect(result.doctors).toHaveLength(2);
    expect(mocks.availableDays).not.toHaveBeenCalled();
  });
});

describe("P9C · no tool call reaches the model as a raw error", () => {
  const tools = {
    prepare_booking: {
      inputSchema: {
        safeParse: (value: unknown) => {
          const record = (value ?? {}) as Record<string, unknown>;
          return Object.keys(record).length === 0 ||
            typeof record.department === "string" ||
            typeof record.doctor === "string"
            ? { success: true }
            : {
                success: false,
                error: { issues: Object.keys(record).map((key) => ({ path: [key] })) },
              };
        },
      },
    },
    list_available_days: {
      inputSchema: {
        safeParse: (value: unknown) => {
          const record = (value ?? {}) as Record<string, unknown>;
          const bad = Object.keys(record).filter((key) => key !== "doctor_id");
          return bad.length === 0
            ? { success: true }
            : { success: false, error: { issues: bad.map((key) => ({ path: [key] })) } };
        },
      },
    },
  } as never;

  it("drops only the arguments that do not validate, and keeps the rest", async () => {
    const repair = createPatientToolCallRepair(CLINIC);
    const repaired = await repair({
      toolCall: {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "list_available_days",
        input: JSON.stringify({ doctor_id: "احمد نبيل", service_id: 12, nonsense: true }),
      },
      tools,
    });

    expect(repaired?.toolName).toBe("list_available_days");
    // The patient's own words survive; the invented arguments do not.
    expect(JSON.parse(repaired!.input)).toEqual({ doctor_id: "احمد نبيل" });
  });

  it("lands an unknown tool name on prepare_booking rather than on an error", async () => {
    const repair = createPatientToolCallRepair(CLINIC);
    const repaired = await repair({
      toolCall: {
        type: "tool-call",
        toolCallId: "call-2",
        toolName: "book_appointment",
        input: JSON.stringify({ doctor: "احمد نبيل" }),
      },
      tools,
    });

    // Always a real call on a real tool, so the model gets guidance and the
    // roster back instead of a validator message it can only apologise for.
    expect(repaired?.toolName).toBe("prepare_booking");
    expect(JSON.parse(repaired!.input)).toEqual({});
  });

  it("survives input that is not JSON at all", async () => {
    const repair = createPatientToolCallRepair(CLINIC);
    const repaired = await repair({
      toolCall: {
        type: "tool-call",
        toolCallId: "call-3",
        toolName: "list_available_days",
        input: "{doctor_id: احمد نبيل",
      },
      tools,
    });

    expect(repaired).not.toBeNull();
    expect(() => JSON.parse(repaired!.input)).not.toThrow();
  });

  it("records the repair in the audit trail, with labels and no patient words", async () => {
    const repair = createPatientToolCallRepair(CLINIC);
    await repair({
      toolCall: {
        type: "tool-call",
        toolCallId: "call-4",
        toolName: "list_available_days",
        input: JSON.stringify({ doctor_id: "احمد نبيل", service_id: 12 }),
      },
      tools,
    });

    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "patient_tool_call_repaired",
        params: expect.objectContaining({
          requested_tool: "list_available_days",
          repaired_tool: "list_available_days",
          dropped_arguments: ["service_id"],
        }),
      }),
    );
    const logged = JSON.stringify(mocks.audit.mock.calls);
    expect(logged).not.toContain("احمد نبيل");
  });
});

/**
 * The whole self-booking flow, as the patient actually walks it.
 *
 * The individual cases above each prove one boundary. This one proves they
 * compose: the doctor chosen by name on turn one is still the doctor the
 * appointment is created with three turns later, with nothing but the
 * conversation's own persisted state carrying them between calls. That is the
 * property production lost — `ai_collected_data` held nothing but a date for the
 * entire conversation.
 */
describe("P9C · doctor → days → the chosen day → times → a pending appointment", () => {
  it("keeps Dr Ahmed Nabil selected from the first turn to the booking", async () => {
    // The conversation's real state, mutated by the tools exactly as
    // `set_conversation_ai_state` would.
    const conversation = identity({});
    mocks.persist.mockImplementation(
      async (input: { collected?: Record<string, string | number> }) => {
        Object.assign(conversation.collectedData, input.collected ?? {});
        return { data: null, error: null };
      },
    );
    mocks.authorize.mockImplementation(async () => conversation);
    mocks.createBooking.mockResolvedValue({
      ok: true,
      appointmentId: "cccccccc-0000-4000-8000-000000000001",
      expiresAt: "2026-08-24T09:00:00.000Z",
      provisional: false,
    });

    // Turn 1 — "احمد نبيل". A name, which is all the model has.
    const days = (await listAvailableDaysTool(ctx).execute!(
      { doctor_id: "احمد نبيل", duration_minutes: 30, search_days: 21 },
      opts,
    )) as Record<string, unknown>;
    expectRecoverable(days);
    expect(days.ok).toBe(true);
    expect(conversation.collectedData.doctor_id).toBe(NABIL);
    conversation.bookingStage = recordOfferedDays(conversation.bookingStage, [
      "2026-08-24",
      "2026-08-25",
    ]);

    // Turn 2 — "طيب يوم 24؟"
    const slots = (await checkPatientAvailabilityTool(ctx).execute!(
      { date: "24", duration_minutes: 30 },
      opts,
    )) as Record<string, unknown>;
    expectRecoverable(slots);
    expect(mocks.availableSlots).toHaveBeenCalledWith(
      expect.objectContaining({ date: "2026-08-24", doctorId: NABIL }),
    );
    conversation.bookingStage = recordOfferedSlots(
      conversation.bookingStage,
      "2026-08-24",
      ["10:00", "10:30"],
    );
    conversation.collectedData.appointment_date = "2026-08-24";

    // Turn 3 — the patient picks a time that was actually offered. The doctor is
    // not named again, because by now nobody should have to name them.
    const booking = (await createPreliminaryBookingTool(ctx).execute!(
      { date: "2026-08-24", time: "10:00", duration_minutes: 30 },
      opts,
    )) as Record<string, unknown>;

    expectRecoverable(booking);
    expect(booking.created).toBe(true);
    expect(booking.status).toBe("pending");
    expect(booking.requires_staff_confirmation).toBe(true);
    expect(mocks.createBooking).toHaveBeenCalledWith(
      expect.objectContaining({ doctorId: NABIL }),
    );
  });
});

describe("manual QA · selected doctor and availability-window invariants", () => {
  it("keeps doctor A when a stale tool argument names doctor B", async () => {
    mocks.authorize.mockResolvedValue(identity({
      department_id: DERMATOLOGY,
      doctor_id: NABIL,
      doctor_name: "Ahmed Nabil",
    }));
    const genericCtx = {
      ...ctx,
      episodeUtterances: ["إيه المواعيد المتاحة الأسبوع الجاي؟"],
    };
    await listAvailableDaysTool(genericCtx).execute!(
      { doctor_id: SARA, duration_minutes: 30, search_days: 7 },
      opts,
    );
    expect(mocks.availableDays).toHaveBeenCalledWith(
      expect.objectContaining({ doctorId: NABIL }),
    );
  });

  it("changes to doctor B only when the patient explicitly chooses B", async () => {
    mocks.authorize.mockResolvedValue(identity({
      department_id: DERMATOLOGY,
      doctor_id: NABIL,
      doctor_name: "Ahmed Nabil",
    }));
    const explicitCtx = { ...ctx, episodeUtterances: ["عايز أحجز مع سارة علي"] };
    await listAvailableDaysTool(explicitCtx).execute!(
      { doctor_id: SARA, duration_minutes: 30, search_days: 7 },
      opts,
    );
    expect(mocks.availableDays).toHaveBeenCalledWith(
      expect.objectContaining({ doctorId: SARA }),
    );
  });

  it("reports selected doctor A as unavailable and never falls back to B", async () => {
    mocks.directory.mockResolvedValue({
      departments: [{ id: DERMATOLOGY, name: "Dermatology" }],
      doctors: [
        {
          id: NABIL,
          name: "Ahmed Nabil",
          departmentId: DERMATOLOGY,
          departmentName: "Dermatology",
          state: "on_leave",
          unavailableUntil: "2026-10-01",
        },
        {
          id: SARA,
          name: "Sara Ali",
          departmentId: DERMATOLOGY,
          departmentName: "Dermatology",
          state: "available",
          unavailableUntil: null,
        },
      ],
    });
    mocks.authorize.mockResolvedValue(identity({ department_id: DERMATOLOGY, doctor_id: NABIL }));
    const result = await listAvailableDaysTool({
      ...ctx,
      episodeUtterances: ["إيه المواعيد المتاحة؟"],
    }).execute!({ doctor_id: SARA, duration_minutes: 30, search_days: 7 }, opts) as Record<string, unknown>;
    expect(result.reason).toBe("doctor_on_leave");
    expect(mocks.availableDays).not.toHaveBeenCalled();
  });

  it("advances repeated navigation from the prior seven-day window", async () => {
    const current = identity({ department_id: DERMATOLOGY, doctor_id: NABIL });
    current.bookingStage = {
      ...current.bookingStage,
      availabilityWindowStart: "2026-09-03",
      availabilityWindowEnd: "2026-09-09",
    };
    mocks.authorize.mockResolvedValue(current);
    const result = await listAvailableDaysTool({
      ...ctx,
      episodeUtterances: ["الأسبوع اللي بعده"],
    }).execute!({ duration_minutes: 30, search_days: 21 }, opts) as Record<string, unknown>;
    expect(mocks.availableDays).toHaveBeenCalledWith(expect.objectContaining({
      doctorId: NABIL,
      searchDays: 7,
      startDate: "2026-09-10",
    }));
    expect(result).toMatchObject({
      window_kind: "next",
      window_start: "2026-09-10",
      window_end: "2026-09-16",
    });

    current.bookingStage = {
      ...current.bookingStage,
      availabilityWindowStart: "2026-09-10",
      availabilityWindowEnd: "2026-09-16",
    };
    mocks.availableDays.mockClear();
    const repeated = await listAvailableDaysTool({
      ...ctx,
      episodeUtterances: ["فيه مواعيد بعد كده؟"],
    }).execute!({ duration_minutes: 30, search_days: 60 }, opts) as Record<string, unknown>;
    expect(mocks.availableDays).toHaveBeenCalledWith(expect.objectContaining({
      searchDays: 7,
      startDate: "2026-09-17",
    }));
    expect(repeated).toMatchObject({
      window_start: "2026-09-17",
      window_end: "2026-09-23",
    });
  });
});
