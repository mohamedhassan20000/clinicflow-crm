import { EMPTY_BOOKING_STAGE_STATE } from "@/lib/ai/booking-stage";
import { DEFAULT_COMMUNICATION_STYLE } from "@/lib/ai/communication-style";
import { describe, expect, it, vi } from "vitest";

/**
 * The two data-access defects behind the WhatsApp booking failure, pinned at the
 * layer they actually live in.
 *
 * 1. `computeAvailability` is shared by the staff appointment form (an RLS
 *    client) and by patient booking (the clinic-scoped service client). It reads
 *    `doctor_unavailability`, which was never classified on the service client,
 *    so `assertKnownTable` threw on every patient availability call and the
 *    patient received a bare technical error.
 * 2. `getPatientAvailableSlots` filtered doctors by department only when a
 *    service was named, so a patient who had already chosen a department and not
 *    a doctor was matched against the whole clinic.
 */

vi.mock("server-only", () => ({}));
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "x".repeat(40);
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "y".repeat(40);

const CLINIC = "11111111-1111-4111-8111-111111111111";

describe("patient availability data access", () => {
  it("can read doctor leave through the clinic-scoped patient client", async () => {
    const { createClinicScopedAdminClient } = await import("@/lib/supabase/admin");
    const db = createClinicScopedAdminClient(CLINIC);
    expect(() => db.from("doctor_unavailability")).not.toThrow();
  });

  it("keeps doctor leave read-only on that client", async () => {
    const { createClinicScopedAdminClient } = await import("@/lib/supabase/admin");
    const db = createClinicScopedAdminClient(CLINIC);
    expect(() =>
      db.from("doctor_unavailability").insert({} as never),
    ).toThrowError(/read-only/i);
  });

  it("reads every table computeAvailability needs", async () => {
    const { createClinicScopedAdminClient } = await import("@/lib/supabase/admin");
    const db = createClinicScopedAdminClient(CLINIC);
    for (const table of [
      "appointments",
      "profiles",
      "doctor_schedules",
      "clinic_working_hours",
      "doctor_unavailability",
    ] as const) {
      expect(() => db.from(table), table).not.toThrow();
    }
  });
});

describe("department scoping of patient availability", () => {
  it("filters candidate doctors by the department the conversation chose", async () => {
    vi.resetModules();
    const columns: Array<[string, unknown]> = [];
    vi.doMock("@/lib/supabase/admin", () => ({
      createClinicScopedAdminClient: () => ({
        from: () => {
          const builder = {
            select: () => builder,
            eq: (column: string, value: unknown) => {
              columns.push([column, value]);
              return builder;
            },
            is: () => builder,
            order: () => builder,
            limit: async () => ({ data: [], error: null }),
            maybeSingle: async () => ({ data: null, error: null }),
          };
          return builder;
        },
      }),
      createPatientPreliminaryBooking: vi.fn(),
      createProvisionalAiAppointmentRequest: vi.fn(),
    }));
    const { getPatientAvailableSlots } = await import("@/lib/booking/patient");
    const result = await getPatientAvailableSlots({
      identity: {
        clinicId: CLINIC,
        conversationId: "22222222-2222-4222-8222-222222222222",
        patientId: null,
        linked: false,
        identityVerifiedAt: null,
        identityLockedUntil: null,
        clinicName: "Clinic",
        clinicLocale: "ar",
        clinicTimezone: "Africa/Cairo",
        clinicCountry: "EG",
        participantAddress: null,
        aiPaused: false,
        collectedData: { department_id: "33333333-3333-4333-8333-333333333333" },
        pendingClarification: null,
        bookingStage: EMPTY_BOOKING_STAGE_STATE,
        communicationStyle: DEFAULT_COMMUNICATION_STYLE,
        bookingIdentityConfirmedAt: null,
        patientDisplayName: null,
        patientNationalIdSuffix: null,
      },
      date: "2026-09-01",
    });
    expect(columns).toContainEqual([
      "department_id",
      "33333333-3333-4333-8333-333333333333",
    ]);
    expect(result).toMatchObject({ ok: false, reason: "doctor_not_found" });
    vi.doUnmock("@/lib/supabase/admin");
  });
});
