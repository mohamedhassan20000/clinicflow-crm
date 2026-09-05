import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

// P4A doctor-tool authorization + behavior suite (the most important suite,
// §10). The model is never exercised — we drive each tool's execute() directly
// with deterministic fixtures and assert on inputs, side effects, RLS scoping,
// redaction, and audit. Cross-boundary attempts (wrong role, out-of-scope
// patient) are asserted to leak nothing.
//
// Phase 7 scope change. `get_patient_summary`, `search_patient_visits` and
// `list_doctor_appointments` were unmounted and deleted once
// `tests/unit/ai/phase7-superset-coverage.test.ts` proved the resource layer
// covers them, so their behavior blocks are gone with their subjects. The
// properties they asserted did not go with them — they moved to the surface that
// now carries the capability:
//   • clinic tenant predicate on every read → phase1-resource-registry
//     ("always injects the caller-owned tenant predicate")
//   • out-of-scope reads leak no existence signal → phase1-resource-registry
//     ("uses the same unauthorized_scope denial for missing and inaccessible ids")
//   • ilike metacharacter escaping → phase1-resource-registry
//     ("keeps ilike wildcard shape server-owned")
//   • entitlement re-checked inside execute → phase1-resource-tools /
//     phase2-clinical-parity ("shows clinical resources only when
//     ai.read_clinical is entitled")
//   • doctor/assistant row scope → phase1/phase2 RLS integration suites
// What remains here is the mount matrix and the two tools Phase 7 deliberately
// retained.

type MockUser = {
  id: string;
  clinicId: string;
  role: "admin" | "receptionist" | "manager" | "doctor" | "assistant";
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
      features: {
        ai_assistant: entitlement.aiFeature ?? true,
        "ai.read_clinical": true,
      },
      limits: {},
      subscriptionAllowed: entitlement.subscriptionAllowed ?? true,
    })),
    hasFeature: (
      ents: { subscriptionAllowed: boolean; features: Record<string, boolean> },
      key: string,
    ) => ents.subscriptionAllowed && ents.features[key] === true,
  }));
  vi.doMock("@/lib/server-page-permissions", () => ({
    getPageVisibilityState: vi.fn(async () => "visible"),
  }));

  const { buildDoctorTools, buildStaffTools } = await import("@/lib/ai/tools");
  const context = {
    // AuthedUser shape; extra fields are harmless.
    user: user as never,
    locale: "en",
  } as const;
  const tools = await buildDoctorTools(context);
  const staffTools = await buildStaffTools(context);

  return { tools, staffTools, mocks, logAgentToolCall };
}

// The AI SDK tool.execute takes (input, options). Options are unused by our
// tools; a stub satisfies the signature.
const opts = {} as never;

describe("role-specific Assistant tool registration", () => {
  it("mounts clinical reads for every RLS-admitted staff role", async () => {
    const doctor = await loadTools(DOCTOR);
    expect(Object.keys(doctor.staffTools)).toEqual([
      "query_resource",
      "get_record",
      "aggregate_resource",
      "describe_capabilities",
      // Final review B-2: the action tools are infrastructure, mounted for
      // every role the action registry authorizes at least one action for. All
      // five staff roles now share one mount list.
      "execute_action",
      "describe_action",
      "search_authorized_patients",
      "check_availability",
      // P4.7A help/navigation mount for every staff role under ai_assistant;
      // P4.7B adds list_my_capabilities on the same footing.
      "search_help",
      "get_navigation_target",
      "list_my_capabilities",
    ]);
    const assistant = await loadTools({ ...DOCTOR, role: "assistant" });
    expect(Object.keys(assistant.staffTools)).toEqual(
      Object.keys(doctor.staffTools),
    );

    for (const role of ["admin", "manager", "receptionist"] as const) {
      const staff = await loadTools({ ...DOCTOR, role });
      expect(Object.keys(staff.staffTools)).toEqual([
        "query_resource",
        "get_record",
        "aggregate_resource",
        "describe_capabilities",
        "execute_action",
        "describe_action",
        "search_authorized_patients",
        "check_availability",
        "search_help",
        "get_navigation_target",
        "list_my_capabilities",
      ]);
    }
  });

  it("returns ranked non-clinical lookup fields to receptionist/manager/admin personas", async () => {
    for (const role of ["admin", "manager", "receptionist"] as const) {
      const { staffTools, mocks } = await loadTools({ ...DOCTOR, role });
      mocks.state.rpcResults.search_patients_ranked = {
        data: [{
          id: PATIENT_ID,
          full_name: "Jane Roe",
          file_number: "CF-100",
          phone: "+96550000001",
          email: "jane@example.com",
          score: 0.92,
          match_kind: "name_fuzzy",
        }],
        error: null,
      };

      const result = await staffTools.search_authorized_patients.execute!(
        { query: "Jane" },
        opts,
      );
      expect(result).toMatchObject({
        confidence: "high",
        patients: [{
          id: PATIENT_ID,
          full_name: "Jane Roe",
          file_number: "CF-100",
          phone: "+96550000001",
          email: "jane@example.com",
          score: 0.92,
          match_kind: "name_fuzzy",
        }],
      });
      expect(mocks.state.rpc).toHaveBeenCalledWith(
        "search_patients_ranked",
        expect.objectContaining({ p_query: "Jane", p_limit: 10 }),
      );
      expect(mocks.state.queryLog.some((entry) => entry.table === "medical_notes")).toBe(false);
    }
  });
});

describe("P4A check_availability", () => {
  // The clock is frozen because check_availability drops slots that have
  // already elapsed *today*. With a real clock this test asked for 09:00–09:45
  // on the current date and passed only when the suite happened to run before
  // 09:00 local — it began failing every morning thereafter, for a reason that
  // has nothing to do with the behavior under test.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T03:00:00.000Z")); // 06:00 Asia/Kuwait
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns only free slots from the shared booking core", async () => {
    const { tools, mocks } = await loadTools();
    mocks.state.tableResults["clinics"] = { data: { timezone: "Asia/Kuwait" }, error: null };
    mocks.state.tableResults["profiles"] = {
      data: {
        id: DOCTOR.id,
        full_name: "Dr Test",
        is_active: true,
        is_deleted: false,
        deleted_at: null,
      },
      error: null,
    };
    mocks.state.tableResults["doctor_schedules"] = {
      data: [{
        day_of_week: 1,
        start_time: "09:00",
        end_time: "10:00",
        is_enabled: true,
        valid_from: null,
        valid_until: null,
      }],
      error: null,
    };
    mocks.state.tableResults["clinic_working_hours"] = {
      data: [{ day_of_week: 1, shift_start: "09:00", shift_end: "10:00" }],
      error: null,
    };
    mocks.state.tableResults["appointments"] = { data: [], error: null };
    mocks.state.tableResults["doctor_unavailability"] = { data: [], error: null };

    const result = (await tools.check_availability.execute!(
      { date: "2026-07-20" },
      opts,
    )) as { available_slots: string[]; doctor_id: string | null };

    expect(result.doctor_id).toBe(DOCTOR.id); // defaulted to the doctor
    expect(result.available_slots).toEqual(["09:00", "09:15", "09:30"]);
  });

  it("omits already-elapsed clinic-local slots when checking today", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T06:22:00.000Z")); // 09:22 Asia/Kuwait
    try {
      const { tools, mocks } = await loadTools();
      mocks.state.tableResults["clinics"] = { data: { timezone: "Asia/Kuwait" }, error: null };
      mocks.state.tableResults["profiles"] = {
        data: {
          id: DOCTOR.id,
          full_name: "Dr Test",
          is_active: true,
          is_deleted: false,
          deleted_at: null,
        },
        error: null,
      };
      mocks.state.tableResults["doctor_schedules"] = {
        data: [{
          day_of_week: 6,
          start_time: "09:00",
          end_time: "10:00",
          is_enabled: true,
          valid_from: null,
          valid_until: null,
        }],
        error: null,
      };
      mocks.state.tableResults["clinic_working_hours"] = {
        data: [{ day_of_week: 6, shift_start: "09:00", shift_end: "10:00" }],
        error: null,
      };
      mocks.state.tableResults["appointments"] = { data: [], error: null };
      mocks.state.tableResults["doctor_unavailability"] = { data: [], error: null };

      const result = (await tools.check_availability.execute!(
        { date: "2026-07-18" },
        opts,
      )) as { available_slots: string[] };

      expect(result.available_slots).toEqual(["09:30"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
