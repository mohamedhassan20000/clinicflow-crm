import { describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

// P4A doctor-tool authorization + behavior suite (the most important suite,
// §10). The model is never exercised — we drive each tool's execute() directly
// with deterministic fixtures and assert on inputs, side effects, RLS scoping,
// redaction, and audit. Cross-boundary attempts (wrong role, out-of-scope
// patient) are asserted to leak nothing.

type MockUser = {
  id: string;
  clinicId: string;
  role: "admin" | "receptionist" | "manager" | "doctor";
  departmentId?: string | null;
  email?: string;
  fullName?: string;
  avatarUrl?: string | null;
  mustChangePassword?: boolean;
};

const DOCTOR: MockUser = {
  id: "11111111-1111-4111-8111-111111111111",
  clinicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  role: "doctor",
  departmentId: "dept-1",
  email: "doc@clinic.test",
  fullName: "Dr House",
  avatarUrl: null,
  mustChangePassword: false,
};

const PATIENT_ID = "22222222-2222-4222-8222-222222222222";

async function loadTools(
  user: MockUser = DOCTOR,
  entitlement: { subscriptionAllowed?: boolean; aiFeature?: boolean } = {},
) {
  vi.resetModules();
  const mocks = createServerActionMocks();
  const logAgentToolCall =
    vi.fn<(input: { clinicId: string; actorId: string | null; tool: string }) => Promise<{ data: string; error: null }>>(
      async () => ({ data: "audit-1", error: null }),
    );

  vi.doMock("server-only", () => ({}));
  vi.doMock("@sentry/nextjs", () => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));
  vi.doMock("@/lib/supabase/admin", () => ({ logAgentToolCall }));
  vi.doMock("@/lib/entitlements", () => ({
    getEntitlements: vi.fn(async () => ({
      clinicId: user.clinicId,
      planSlug: "pro_ai",
      features: { ai_assistant: entitlement.aiFeature ?? true },
      limits: {},
      subscriptionAllowed: entitlement.subscriptionAllowed ?? true,
    })),
    hasFeature: (
      ents: { subscriptionAllowed: boolean; features: Record<string, boolean> },
      key: string,
    ) => ents.subscriptionAllowed && ents.features[key] === true,
  }));

  const { buildDoctorTools } = await import("@/lib/ai/tools");
  const tools = buildDoctorTools({
    // AuthedUser shape; extra fields are harmless.
    user: user as never,
    locale: "en",
  });
  return { tools, mocks, logAgentToolCall };
}

// The AI SDK tool.execute takes (input, options). Options are unused by our
// tools; a stub satisfies the signature.
const opts = {} as never;

describe("P4A get_patient_summary", () => {
  it("returns a redacted summary and scopes every read to the clinic", async () => {
    const { tools, mocks, logAgentToolCall } = await loadTools();
    mocks.state.tableResults["patients"] = {
      data: {
        id: PATIENT_ID,
        full_name: "Jane Roe",
        date_of_birth: "1990-06-15",
        blood_type: "O+",
        clinic_id: DOCTOR.clinicId,
      },
      error: null,
    };
    mocks.state.tableResults["appointments"] = {
      data: [{ id: "a1", scheduled_at: "2026-07-10T09:00:00Z", status: "completed", duration_minutes: 30 }],
      error: null,
    };
    mocks.state.tableResults["medical_notes"] = {
      data: [{ id: "n1", note: "BP 120/80. Contact 0501234567.", doctor_id: DOCTOR.id, created_at: "2026-07-10T09:30:00Z" }],
      error: null,
    };
    mocks.state.tableResults["follow_ups"] = { data: [], error: null };
    mocks.state.tableResults["patient_packages"] = { data: [], error: null };

    const result = (await tools.get_patient_summary.execute!({ patient_id: PATIENT_ID }, opts)) as {
      found: boolean;
      patient: { full_name: string; age: number | null; blood_type: string | null };
      notes: { excerpt: string }[];
    };

    expect(result.found).toBe(true);
    expect(result.patient.full_name).toBe("Jane Roe");
    expect(result.patient.age).toBeGreaterThan(30);
    expect(result.patient.blood_type).toBe("O+");
    // No raw DOB / identifiers cross the boundary.
    expect(result.patient).not.toHaveProperty("date_of_birth");
    expect(result.patient).not.toHaveProperty("national_id");
    // Contact number inside a note is redacted.
    expect(result.notes[0].excerpt).not.toContain("0501234567");
    expect(result.notes[0].excerpt).toContain("[redacted-number]");

    // Every read filtered by the session clinic id.
    const clinicFilters = mocks.state.queryLog.filter(
      (q) => q.args[0] === "eq" && q.args[1] === "clinic_id",
    );
    expect(clinicFilters.length).toBeGreaterThan(0);
    expect(clinicFilters.every((q) => q.args[2] === DOCTOR.clinicId)).toBe(true);

    // Tool call was audited.
    expect(logAgentToolCall).toHaveBeenCalledTimes(1);
    expect(logAgentToolCall.mock.calls[0][0]).toMatchObject({
      tool: "get_patient_summary",
      clinicId: DOCTOR.clinicId,
      actorId: DOCTOR.id,
    });
  });

  it("leaks nothing when the patient is out of the doctor's RLS scope", async () => {
    const { tools, mocks, logAgentToolCall } = await loadTools();
    // RLS returns no row for an out-of-scope patient.
    mocks.state.tableResults["patients"] = { data: null, error: null };

    const result = (await tools.get_patient_summary.execute!({ patient_id: PATIENT_ID }, opts)) as {
      found: boolean;
    };
    expect(result.found).toBe(false);
    expect(result).not.toHaveProperty("patient");
    // The denied attempt is still audited.
    expect(logAgentToolCall).toHaveBeenCalledTimes(1);
    expect(logAgentToolCall.mock.calls[0][0]).toMatchObject({ tool: "get_patient_summary" });
  });

  it("refuses a non-doctor role before any data access", async () => {
    const { tools, mocks, logAgentToolCall } = await loadTools({ ...DOCTOR, role: "receptionist" });
    await expect(
      tools.get_patient_summary.execute!({ patient_id: PATIENT_ID }, opts),
    ).rejects.toMatchObject({ code: "AI_TOOL_FORBIDDEN", reason: "role_forbidden" });
    expect(mocks.state.queryLog.length).toBe(0);
    expect(logAgentToolCall).not.toHaveBeenCalled();
  });

  it("refuses the manager role too", async () => {
    const { tools } = await loadTools({ ...DOCTOR, role: "manager" });
    await expect(
      tools.get_patient_summary.execute!({ patient_id: PATIENT_ID }, opts),
    ).rejects.toMatchObject({ reason: "role_forbidden" });
  });

  it("re-asserts the AI entitlement before creating an RLS data client", async () => {
    const { tools, mocks, logAgentToolCall } = await loadTools(DOCTOR, {
      aiFeature: false,
    });
    await expect(
      tools.get_patient_summary.execute!({ patient_id: PATIENT_ID }, opts),
    ).rejects.toMatchObject({ reason: "feature_not_entitled" });
    expect(mocks.state.queryLog).toEqual([]);
    expect(logAgentToolCall).not.toHaveBeenCalled();
  });
});

describe("P4A search_patient_visits", () => {
  it("returns empty results for an out-of-scope patient without an existence signal", async () => {
    const { tools, mocks } = await loadTools();
    mocks.state.tableResults["patients"] = { data: null, error: null };

    const result = (await tools.search_patient_visits.execute!(
      { patient_id: PATIENT_ID, query: "fever" },
      opts,
    )) as { found: boolean; notes: unknown[]; appointments: unknown[] };
    expect(result.found).toBe(false);
    expect(result.notes).toEqual([]);
    expect(result.appointments).toEqual([]);
  });

  it("redacts note excerpts and scopes by clinic", async () => {
    const { tools, mocks } = await loadTools();
    mocks.state.tableResults["patients"] = { data: { id: PATIENT_ID }, error: null };
    mocks.state.tableResults["medical_notes"] = {
      data: [{ id: "n1", note: "Follow-up, patient email jane@example.com", doctor_id: DOCTOR.id, created_at: "2026-07-10T09:30:00Z" }],
      error: null,
    };
    mocks.state.tableResults["appointments"] = { data: [], error: null };

    const result = (await tools.search_patient_visits.execute!(
      { patient_id: PATIENT_ID, query: "follow" },
      opts,
    )) as { notes: { excerpt: string }[] };
    expect(result.notes[0].excerpt).toContain("[redacted-email]");
    expect(result.notes[0].excerpt).not.toContain("jane@example.com");
  });

  it("escapes ilike wildcard characters and uses clinic-local date bounds", async () => {
    const { tools, mocks } = await loadTools();
    mocks.state.tableResults["patients"] = { data: { id: PATIENT_ID }, error: null };
    mocks.state.tableResults["clinics"] = { data: { timezone: "Asia/Kuwait" }, error: null };
    mocks.state.tableResults["medical_notes"] = { data: [], error: null };
    mocks.state.tableResults["appointments"] = { data: [], error: null };

    await tools.search_patient_visits.execute!(
      {
        patient_id: PATIENT_ID,
        query: "100%_match\\literal",
        from: "2026-07-18",
        to: "2026-07-18",
      },
      opts,
    );

    const ilike = mocks.state.queryLog.find((q) => q.args[0] === "ilike");
    expect(ilike?.args[2]).toBe("%100\\%\\_match\\\\literal%");
    const lowerBounds = mocks.state.queryLog.filter((q) => q.args[0] === "gte");
    const upperBounds = mocks.state.queryLog.filter((q) => q.args[0] === "lte");
    expect(lowerBounds.every((q) => q.args[2] === "2026-07-17T21:00:00.000Z")).toBe(true);
    expect(upperBounds.every((q) => q.args[2] === "2026-07-18T20:59:59.999Z")).toBe(true);
  });
});

describe("P4A list_doctor_appointments", () => {
  it("filters by the session doctor id, never a parameter", async () => {
    const { tools, mocks } = await loadTools();
    mocks.state.tableResults["clinics"] = { data: { timezone: "Asia/Kuwait" }, error: null };
    mocks.state.tableResults["appointments"] = {
      data: [{ id: "a1", scheduled_at: "2026-07-18T09:00:00Z", status: "confirmed", duration_minutes: 30, patients: { full_name: "Jane Roe" } }],
      error: null,
    };

    const result = (await tools.list_doctor_appointments.execute!(
      { from: "2026-07-18", to: "2026-07-19" },
      opts,
    )) as { appointments: { patient_name: string | null }[] };

    expect(result.appointments[0].patient_name).toBe("Jane Roe");
    const doctorFilter = mocks.state.queryLog.find(
      (q) => q.args[0] === "eq" && q.args[1] === "doctor_id",
    );
    expect(doctorFilter?.args[2]).toBe(DOCTOR.id);
    const lowerBound = mocks.state.queryLog.find((q) => q.args[0] === "gte");
    const upperBound = mocks.state.queryLog.find((q) => q.args[0] === "lte");
    expect(lowerBound?.args[2]).toBe("2026-07-17T21:00:00.000Z");
    expect(upperBound?.args[2]).toBe("2026-07-19T20:59:59.999Z");
  });
});

describe("P4A check_availability", () => {
  it("returns only free slots from the shared booking core", async () => {
    const { tools, mocks } = await loadTools();
    mocks.state.tableResults["clinics"] = { data: { timezone: "Asia/Kuwait" }, error: null };
    mocks.state.tableResults["doctor_schedules"] = { data: null, error: null };
    mocks.state.tableResults["clinic_working_hours"] = {
      data: [{ shift_start: "09:00", shift_end: "10:00" }],
      error: null,
    };
    mocks.state.tableResults["appointments"] = { data: [], error: null };

    const result = (await tools.check_availability.execute!(
      { date: "2026-07-20" },
      opts,
    )) as { available_slots: string[]; doctor_id: string | null };

    expect(result.doctor_id).toBe(DOCTOR.id); // defaulted to the doctor
    expect(result.available_slots).toEqual(["09:00", "09:15", "09:30", "09:45"]);
  });

  it("omits already-elapsed clinic-local slots when checking today", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T06:22:00.000Z")); // 09:22 Asia/Kuwait
    try {
      const { tools, mocks } = await loadTools();
      mocks.state.tableResults["clinics"] = { data: { timezone: "Asia/Kuwait" }, error: null };
      mocks.state.tableResults["doctor_schedules"] = { data: null, error: null };
      mocks.state.tableResults["clinic_working_hours"] = {
        data: [{ shift_start: "09:00", shift_end: "10:00" }],
        error: null,
      };
      mocks.state.tableResults["appointments"] = { data: [], error: null };

      const result = (await tools.check_availability.execute!(
        { date: "2026-07-18" },
        opts,
      )) as { available_slots: string[] };

      expect(result.available_slots).toEqual(["09:30", "09:45"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
