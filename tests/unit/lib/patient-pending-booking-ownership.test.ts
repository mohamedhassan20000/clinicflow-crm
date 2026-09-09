/**
 * Who a pending booking belongs to.
 *
 * `createPatientPendingBooking` chooses between two writes, and the choice is
 * the whole of patient ownership on the assistant's booking path:
 *
 *   * `create_patient_preliminary_booking` — a **real** `appointments` row on
 *     `conversations.patient_id`, taken when the sender is linked and the
 *     booking is their own;
 *   * `create_provisional_ai_appointment_request` — a pending request that
 *     carries no patient until staff approve the intake behind it.
 *
 * It shipped deciding that from one fact: a lookup for a *pending* third-party
 * intake row on the conversation. Manual QA found what "no row" actually means.
 * A linked father booked for his son; the staging silently wrote nothing (the
 * thread's one intake row had already been approved, and the RPC's
 * `already_reviewed` status was not being read); the lookup found nothing; and
 * "no pending third-party intake" was taken to mean "this booking is the
 * sender's own". The son's appointment was created on the father's file.
 *
 * So the caller's own knowledge is now the authority — the V2 flow passes
 * `frame.slots.beneficiary === "other"`, which is the answer the patient gave to
 * a question the assistant asked outright — and the lookup is kept as a second,
 * independent guard. This file holds that: **a booking is the sender's only
 * when neither fact says otherwise.**
 *
 * The module is deliberately *not* mocked here, unlike everywhere else that
 * touches it: the branch under test lives inside it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const CAIRO = "Africa/Cairo";
const NOW = new Date("2026-09-05T09:00:00.000Z");
const AT = NOW.toISOString();

/** The father: linked to the thread, and the record that must stay untouched. */
const REQUESTER_A = "patient-requester-a";

const admin = vi.hoisted(() => ({
  getPendingConversationIntake: vi.fn(),
  createPatientPreliminaryBooking: vi.fn(),
  createProvisionalAiAppointmentRequest: vi.fn(),
  createClinicScopedAdminClient: vi.fn(),
  getClinicCurrency: vi.fn(async () => null),
  getPatientClinicPublicInfo: vi.fn(async () => ({ data: null })),
}));
vi.mock("@/lib/supabase/admin", () => admin);

const availability = vi.hoisted(() => ({ computeAvailability: vi.fn() }));
vi.mock("@/lib/booking/availability", () => availability);

import { createPatientPendingBooking } from "@/lib/booking/patient";

const IDENTITY = {
  clinicId: "clinic-1",
  conversationId: "conv-1",
  clinicTimezone: CAIRO,
  linked: true,
  patientId: REQUESTER_A,
  // Read by the availability query for its department scope. Empty is the
  // ordinary case once a doctor has been named, which this booking has.
  collectedData: {},
} as const;

/**
 * The clinic-scoped query builder, reduced to the one shape this path uses:
 * `from("profiles").select(...).eq(...)….order(...).limit(...)`, resolving to
 * the single doctor the patient chose.
 */
function adminClientDouble() {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "order", "not", "in", "gte", "lte"]) {
    chain[method] = () => chain;
  }
  chain.limit = async () => ({
    data: [{ id: "doc-youssef", full_name: "Youssef Adel", department_id: "dept-pt" }],
    error: null,
  });
  chain.maybeSingle = async () => ({ data: null, error: null });
  return { from: () => chain };
}

/** The slot the patient chose, free and comfortably past the lead-time floor. */
const SCHEDULED_AT = "2026-09-09T06:00:00.000Z";

async function pendingBooking(input: Record<string, unknown> = {}) {
  return createPatientPendingBooking({
    identity: IDENTITY as never,
    doctorId: "doc-youssef",
    scheduledAt: SCHEDULED_AT,
    durationMinutes: 30,
    now: NOW,
    ...input,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  // The calendar is a collaborator, not the subject. Everything between it and
  // the ownership branch — the lead-time floor, the slot re-check, the doctor
  // lookup — runs for real.
  admin.createClinicScopedAdminClient.mockReturnValue(adminClientDouble() as never);
  availability.computeAvailability.mockResolvedValue({
    slots: [{ time: "09:00", disabled: false }],
    reason: "available",
    workingHours: [],
  });
  admin.getPendingConversationIntake.mockResolvedValue({ data: null });
  admin.createPatientPreliminaryBooking.mockResolvedValue({
    data: [{ appointment_id: "appt-on-requester-a", expires_at: AT }],
    error: null,
  });
  admin.createProvisionalAiAppointmentRequest.mockResolvedValue({
    data: [{ request_id: "request-for-beneficiary-b", expires_at: AT }],
    error: null,
  });
});

describe("a third-party booking never reaches the requester's record", () => {
  it("THE REGRESSION: linked requester, third party, and NO pending intake row", async () => {
    // Exactly the Production state at the moment of the defect: the staging had
    // silently done nothing, so there was no row for the lookup to find. Before
    // the fix this created a real appointment for the father.
    admin.getPendingConversationIntake.mockResolvedValue({ data: null });

    const result = await pendingBooking({ forThirdParty: true });

    expect(admin.createPatientPreliminaryBooking).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      provisional: true,
      appointmentId: "request-for-beneficiary-b",
    });
  });

  it("refuses the linked branch even when the lookup disagrees with the caller", async () => {
    // A stale row, a mis-typed row, a row from an earlier beneficiary. None of
    // them may overrule the beneficiary the patient actually stated.
    admin.getPendingConversationIntake.mockResolvedValue({ data: { is_third_party: false } });

    const result = await pendingBooking({ forThirdParty: true });

    expect(admin.createPatientPreliminaryBooking).not.toHaveBeenCalled();
    expect(result).toMatchObject({ provisional: true });
  });

  it("keeps the lookup as a guard for callers that assert nothing", async () => {
    // The legacy tools carry no beneficiary of their own. Their behaviour is
    // unchanged: the pending row still decides, exactly as before.
    admin.getPendingConversationIntake.mockResolvedValue({ data: { is_third_party: true } });

    const result = await pendingBooking();

    expect(admin.createPatientPreliminaryBooking).not.toHaveBeenCalled();
    expect(result).toMatchObject({ provisional: true });
  });
});

describe("the sender's own booking is unchanged", () => {
  it("takes the linked branch when neither fact says third party", async () => {
    admin.getPendingConversationIntake.mockResolvedValue({ data: null });

    const result = await pendingBooking({ forThirdParty: false });

    expect(admin.createPatientPreliminaryBooking).toHaveBeenCalledTimes(1);
    expect(admin.createProvisionalAiAppointmentRequest).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      provisional: false,
      appointmentId: "appt-on-requester-a",
    });
  });

  it("still writes a provisional request for an unlinked stranger", async () => {
    const result = await createPatientPendingBooking({
      identity: { ...IDENTITY, linked: false, patientId: null } as never,
      doctorId: "doc-youssef",
      scheduledAt: SCHEDULED_AT,
      durationMinutes: 30,
      now: NOW,
      forThirdParty: false,
    } as never);

    expect(admin.createPatientPreliminaryBooking).not.toHaveBeenCalled();
    expect(result).toMatchObject({ provisional: true });
  });
});
