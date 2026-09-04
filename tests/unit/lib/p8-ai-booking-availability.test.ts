import { EMPTY_BOOKING_STAGE_STATE } from "@/lib/ai/booking-stage";
import { DEFAULT_COMMUNICATION_STYLE } from "@/lib/ai/communication-style";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  computeAvailability: vi.fn(),
  createExistingBooking: vi.fn(),
  createProvisionalRequest: vi.fn(),
}));

vi.mock("@/lib/booking/availability", () => ({
  computeAvailability: mocks.computeAvailability,
}));

function resolvedQuery(data: unknown) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "order", "limit"]) {
    query[method] = vi.fn(() => query);
  }
  query.then = (
    resolve: (value: { data: unknown; error: null }) => unknown,
  ) => Promise.resolve({ data, error: null }).then(resolve);
  return query;
}

vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => ({
    from: vi.fn((table: string) => {
      if (table !== "profiles") throw new Error(`Unexpected table: ${table}`);
      return resolvedQuery([
        {
          id: "22222222-2222-4222-8222-222222222222",
          full_name: "Dr End Shift",
          department_id: "33333333-3333-4333-8333-333333333333",
        },
      ]);
    }),
  }),
  createPatientPreliminaryBooking: mocks.createExistingBooking,
  getPendingConversationIntake: vi
    .fn()
    .mockResolvedValue({ data: null, error: null }),
  createProvisionalAiAppointmentRequest: mocks.createProvisionalRequest,
}));

import { createPatientPendingBooking } from "@/lib/booking/patient";
import type { ResolvedPatientAiContext } from "@/lib/ai/patient-authorization";

const identity = {
  clinicId: "11111111-1111-4111-8111-111111111111",
  conversationId: "44444444-4444-4444-8444-444444444444",
  patientId: "55555555-5555-4555-8555-555555555555",
  linked: true,
  identityVerifiedAt: "2026-08-20T10:00:00.000Z",
  identityLockedUntil: null,
  clinicName: "Clinic",
  clinicLocale: "en",
  clinicTimezone: "UTC",
  clinicCountry: "US",
  participantAddress: "+10000000000",
  aiPaused: false,
  collectedData: {},
  pendingClarification: null,
  bookingStage: EMPTY_BOOKING_STAGE_STATE,
  communicationStyle: DEFAULT_COMMUNICATION_STYLE,
  bookingIdentityConfirmedAt: null,
  patientDisplayName: null,
  patientNationalIdSuffix: null,
} satisfies ResolvedPatientAiContext;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.computeAvailability.mockResolvedValue({
    slots: [{ time: "17:30", disabled: false }],
    reason: "available",
    dateIso: "2026-08-24",
    dayOfWeek: 1,
    doctorName: "Dr End Shift",
    workingHours: [{ start: "09:00", end: "18:00" }],
  });
  mocks.createExistingBooking.mockResolvedValue({
    data: [
      {
        appointment_id: "66666666-6666-4666-8666-666666666666",
        expires_at: "2026-08-24T18:00:00.000Z",
      },
    ],
    error: null,
  });
});

describe("AI patient booking availability contract", () => {
  it("accepts a valid duration-aware start at the end of a working window", async () => {
    const result = await createPatientPendingBooking({
      identity,
      doctorId: "22222222-2222-4222-8222-222222222222",
      scheduledAt: "2026-08-24T17:30:00.000Z",
      durationMinutes: 30,
      now: new Date("2026-08-22T10:00:00.000Z"),
    });

    expect(result).toMatchObject({ ok: true, provisional: false });
    expect(mocks.computeAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ durationMinutes: 30 }),
    );
    expect(mocks.createExistingBooking).toHaveBeenCalledOnce();
  });

  it("rejects a slot under 24 hours before any database write", async () => {
    const result = await createPatientPendingBooking({
      identity,
      doctorId: "22222222-2222-4222-8222-222222222222",
      scheduledAt: "2026-08-23T09:59:59.000Z",
      durationMinutes: 30,
      now: new Date("2026-08-22T10:00:00.000Z"),
    });

    expect(result).toEqual({ ok: false, reason: "minimum_notice" });
    expect(mocks.createExistingBooking).not.toHaveBeenCalled();
    expect(mocks.createProvisionalRequest).not.toHaveBeenCalled();
  });
});
