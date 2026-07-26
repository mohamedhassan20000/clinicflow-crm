import { describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  clinicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  role: "admin" as const,
  departmentId: null,
  email: "admin@clinic.test",
  fullName: "Admin",
  avatarUrl: null,
  mustChangePassword: false,
};
const APPOINTMENT = "22222222-2222-4222-8222-222222222222";
const INVOICE = "33333333-3333-4333-8333-333333333333";
const OTHER_INVOICE = "77777777-7777-4777-8777-777777777777";
const STAFF = "44444444-4444-4444-8444-444444444444";
const DEPARTMENT = "55555555-5555-4555-8555-555555555555";
const CONVERSATION = "66666666-6666-4666-8666-666666666666";
const opts = {} as never;

type EntityType =
  | "patient"
  | "appointment"
  | "invoice"
  | "staff"
  | "department"
  | "report";

function slot(entityType: EntityType, entityId: string, displayLabel: string) {
  return {
    entity_type: entityType,
    entity_id: entityId,
    display_label: displayLabel,
    set_at: "2026-07-26T10:00:00.000Z",
    set_by: "resolution" as const,
  };
}

async function loadTools(activeContext: Record<string, unknown> = {}) {
  vi.resetModules();
  const mocks = createServerActionMocks();
  const assertAnalyticsToolAccess = vi.fn(async () => undefined);
  const assertDoctorToolAccess = vi.fn(async () => undefined);
  const assertFinancialInsightsAccess = vi.fn(async () => undefined);
  const logAgentToolCall = vi.fn(async () => ({ data: "audit-1", error: null }));
  const getNoShowReportData = vi.fn(async () => ({ total: 2 }));
  const getDoctorPerformanceData = vi.fn(async () => ({ doctors: [] }));

  vi.doMock("server-only", () => ({}));
  vi.doMock("@sentry/nextjs", () => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));
  vi.doMock("@/lib/supabase/admin", () => ({ logAgentToolCall }));
  vi.doMock("@/lib/ai/authorization", () => ({
    assertAnalyticsToolAccess,
    assertDoctorToolAccess,
    assertFinancialInsightsAccess,
  }));
  vi.doMock("@/lib/reports/data", () => ({
    getCancellationReportData: vi.fn(),
    getDoctorPerformanceData,
    getFollowupsReportData: vi.fn(),
    getNoShowReportData,
    getReceptionistPerformanceData: vi.fn(),
    getRevenueSummaryData: vi.fn(),
  }));

  const { ConversationContextRecorder } = await import("@/lib/ai/conversation-context");
  const [
    { listAppointmentsTool },
    { listDoctorAppointmentsTool },
    { listOutstandingInvoicesTool },
    { runClinicReportTool },
  ] = await Promise.all([
    import("@/lib/ai/tools/list-appointments"),
    import("@/lib/ai/tools/list-doctor-appointments"),
    import("@/lib/ai/tools/list-outstanding-invoices"),
    import("@/lib/ai/tools/run-clinic-report"),
  ]);

  const recorder = new ConversationContextRecorder();
  const context = {
    user: USER as never,
    locale: "en" as const,
    conversationId: CONVERSATION,
    activeContext: activeContext as never,
    contextRecorder: recorder,
    grantedPermissions: new Set(["ai.financial_insights"] as const),
  };
  return {
    mocks,
    recorder,
    assertAnalyticsToolAccess,
    assertDoctorToolAccess,
    assertFinancialInsightsAccess,
    getNoShowReportData,
    getDoctorPerformanceData,
    listAppointments: listAppointmentsTool(context),
    listDoctorAppointments: listDoctorAppointmentsTool(context),
    listOutstandingInvoices: listOutstandingInvoicesTool(context),
    runClinicReport: runClinicReportTool(context),
  };
}

describe("P410-M1 advisory list context", () => {
  it("keeps a clinic-wide appointment query broad while active slots remain set", async () => {
    const tools = await loadTools({
      appointment: slot("appointment", APPOINTMENT, "Appointment"),
      staff: slot("staff", STAFF, "Dr Ahmed"),
      department: slot("department", DEPARTMENT, "Cardiology"),
    });
    tools.mocks.state.tableResults.appointments = { data: [], error: null };

    await tools.listAppointments.execute!({ preset: "today" }, opts);

    expect(tools.assertAnalyticsToolAccess).toHaveBeenCalledWith(USER);
    expect(
      tools.mocks.state.queryLog.some(
        (entry) =>
          entry.table === "appointments" &&
          entry.args[0] === "eq" &&
          [APPOINTMENT, STAFF, DEPARTMENT].includes(String(entry.args[2])),
      ),
    ).toBe(false);
    expect(
      tools.mocks.state.queryLog.some(
        (entry) =>
          entry.table === "profiles" || entry.table === "departments",
      ),
    ).toBe(false);
    expect(tools.recorder.takeAll()).toEqual([]);
  });

  it("revalidates and applies only the active entities explicitly selected by intent flags", async () => {
    const tools = await loadTools({
      appointment: slot("appointment", APPOINTMENT, "Appointment"),
      staff: slot("staff", STAFF, "Dr Ahmed"),
      department: slot("department", DEPARTMENT, "Cardiology"),
    });
    tools.mocks.state.tableResults.profiles = {
      data: { full_name: "Dr Ahmed" },
      error: null,
    };
    tools.mocks.state.tableResults.departments = {
      data: { name: "Cardiology" },
      error: null,
    };
    tools.mocks.state.tableResults.appointments = { data: [], error: null };

    await tools.listAppointments.execute!(
      {
        preset: "today",
        use_active_appointment: true,
        use_active_staff: true,
        use_active_department: true,
      },
      opts,
    );

    for (const [column, id] of [
      ["id", APPOINTMENT],
      ["doctor_id", STAFF],
      ["department_id", DEPARTMENT],
    ]) {
      expect(tools.mocks.state.queryLog).toContainEqual(
        expect.objectContaining({ args: ["eq", column, id] }),
      );
    }
    expect(tools.recorder.takeAll()).toEqual([]);
  });

  it("runs the same broad appointment query with no active slots", async () => {
    const tools = await loadTools();
    tools.mocks.state.tableResults.appointments = { data: [], error: null };

    await expect(
      tools.listAppointments.execute!({ preset: "today" }, opts),
    ).resolves.toMatchObject({ appointments: [] });
    expect(
      tools.mocks.state.queryLog.some(
        (entry) =>
          entry.table === "profiles" || entry.table === "departments",
      ),
    ).toBe(false);
  });

  it("ignores a stale or unauthorized active staff slot for broad intent and fails closed when explicitly scoped", async () => {
    const broad = await loadTools({
      staff: slot("staff", STAFF, "Former Doctor"),
    });
    broad.mocks.state.tableResults.appointments = { data: [], error: null };

    await expect(
      broad.listAppointments.execute!({ preset: "today" }, opts),
    ).resolves.toMatchObject({ appointments: [] });
    expect(
      broad.mocks.state.queryLog.some((entry) => entry.table === "profiles"),
    ).toBe(false);

    const scoped = await loadTools({
      staff: slot("staff", STAFF, "Former Doctor"),
    });
    scoped.mocks.state.tableResults.profiles = { data: null, error: null };
    await expect(
      scoped.listAppointments.execute!(
        { preset: "today", use_active_staff: true },
        opts,
      ),
    ).resolves.toMatchObject({
      needs_clarification: true,
      field: "doctor",
      candidates: [],
    });
    expect(
      scoped.mocks.state.queryLog.some(
        (entry) => entry.table === "appointments",
      ),
    ).toBe(false);
  });

  it("keeps the doctor's schedule broad unless the active appointment is explicitly selected", async () => {
    const broad = await loadTools({
      appointment: slot("appointment", APPOINTMENT, "Appointment"),
    });
    broad.mocks.state.tableResults.clinics = {
      data: { timezone: "Europe/Istanbul" },
      error: null,
    };
    broad.mocks.state.tableResults.appointments = { data: [], error: null };
    await broad.listDoctorAppointments.execute!(
      { from: "2026-07-26", to: "2026-07-26" },
      opts,
    );
    expect(
      broad.mocks.state.queryLog.some(
        (entry) =>
          entry.table === "appointments" &&
          entry.args[0] === "eq" &&
          entry.args[1] === "id",
      ),
    ).toBe(false);

    const scoped = await loadTools({
      appointment: slot("appointment", APPOINTMENT, "Appointment"),
    });
    scoped.mocks.state.tableResults.clinics = {
      data: { timezone: "Europe/Istanbul" },
      error: null,
    };
    scoped.mocks.state.tableResults.appointments = { data: [], error: null };
    await scoped.listDoctorAppointments.execute!(
      {
        from: "2026-07-26",
        to: "2026-07-26",
        use_active_appointment: true,
      },
      opts,
    );
    expect(scoped.mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "appointments",
        args: ["eq", "id", APPOINTMENT],
      }),
    );
  });

  it("keeps an aggregate doctor-performance report clinic-wide unless active staff intent is explicit", async () => {
    const broad = await loadTools({
      staff: slot("staff", STAFF, "Dr Ahmed"),
    });
    await broad.runClinicReport.execute!(
      { report: "doctor_performance", preset: "today" },
      opts,
    );

    expect(broad.getDoctorPerformanceData).toHaveBeenCalledWith(
      expect.anything(),
      null,
    );
    expect(
      broad.mocks.state.queryLog.some((entry) => entry.table === "profiles"),
    ).toBe(false);

    const scoped = await loadTools({
      staff: slot("staff", STAFF, "Dr Ahmed"),
    });
    scoped.mocks.state.tableResults.profiles = {
      data: { full_name: "Dr Ahmed" },
      error: null,
    };
    await scoped.runClinicReport.execute!(
      {
        report: "doctor_performance",
        preset: "today",
        use_active_staff: true,
      },
      opts,
    );

    expect(scoped.getDoctorPerformanceData).toHaveBeenCalledWith(
      expect.anything(),
      STAFF,
    );
    expect(scoped.mocks.state.queryLog).toContainEqual(
      expect.objectContaining({ args: ["eq", "id", STAFF] }),
    );
  });

  it("records deterministic name resolutions and a unique authorized appointment", async () => {
    const tools = await loadTools();
    tools.mocks.state.rpcResults.search_staff_ranked = {
      data: [
        {
          id: STAFF,
          full_name: "Dr Ahmed",
          score: 0.99,
          match_kind: "exact_name",
        },
      ],
      error: null,
    };
    tools.mocks.state.rpcResults.search_departments_ranked = {
      data: [
        {
          id: DEPARTMENT,
          name: "Cardiology",
          score: 0.99,
          match_kind: "exact_name",
        },
      ],
      error: null,
    };
    tools.mocks.state.tableResults.appointments = {
      data: [
        {
          id: APPOINTMENT,
          scheduled_at: "2026-07-26T10:00:00.000Z",
          status: "confirmed",
          duration_minutes: 30,
          patients: { full_name: "Mona Ali", file_number: "CF-1" },
          profiles: { full_name: "Dr Ahmed" },
          departments: { name: "Cardiology" },
        },
      ],
      error: null,
    };

    await tools.listAppointments.execute!(
      { preset: "today", doctor: "Dr Ahmed", department: "Cardiology" },
      opts,
    );

    expect(tools.recorder.takeAll()).toEqual([
      {
        entityType: "staff",
        entityId: STAFF,
        displayLabel: "Dr Ahmed",
        setBy: "resolution",
      },
      {
        entityType: "department",
        entityId: DEPARTMENT,
        displayLabel: "Cardiology",
        setBy: "resolution",
      },
      {
        entityType: "appointment",
        entityId: APPOINTMENT,
        displayLabel: "Mona Ali · 2026-07-26T10:00:00.000Z",
        setBy: "resolution",
      },
    ]);
  });

  it("never promotes a model-supplied staff UUID into stored context", async () => {
    const tools = await loadTools();
    tools.mocks.state.tableResults.profiles = {
      data: { full_name: "Dr Ahmed" },
      error: null,
    };
    tools.mocks.state.tableResults.appointments = { data: [], error: null };

    await tools.listAppointments.execute!(
      { preset: "today", doctor: STAFF },
      opts,
    );

    expect(tools.mocks.state.queryLog).toContainEqual(
      expect.objectContaining({ args: ["eq", "doctor_id", STAFF] }),
    );
    expect(tools.recorder.takeAll()).toEqual([]);
  });

});

describe("P410-M1 financial list context", () => {
  it("does not narrow a broad outstanding-balance query to the active invoice", async () => {
    const tools = await loadTools({
      invoice: slot("invoice", INVOICE, "Mona · 250"),
    });
    tools.mocks.state.tableResults.appointments = { data: [], error: null };

    await tools.listOutstandingInvoices.execute!({ limit: 10 }, opts);

    expect(tools.assertFinancialInsightsAccess).toHaveBeenCalledWith(USER);
    expect(
      tools.mocks.state.queryLog.some(
        (entry) =>
          entry.table === "appointments" &&
          entry.args[0] === "eq" &&
          entry.args[1] === "id",
      ),
    ).toBe(false);
  });

  it("re-authorizes and filters by the active invoice for explicitly scoped intent", async () => {
    const tools = await loadTools({
      invoice: slot("invoice", INVOICE, "Mona · 250"),
    });
    tools.mocks.state.tableResults.appointments = { data: [], error: null };

    await tools.listOutstandingInvoices.execute!(
      { limit: 10, use_active_invoice: true },
      opts,
    );

    expect(tools.mocks.state.queryLog).toContainEqual(
      expect.objectContaining({ args: ["eq", "id", INVOICE] }),
    );
    expect(tools.recorder.takeAll()).toEqual([]);
  });

  it("ignores a stale or unauthorized invoice slot for broad intent and yields no data when explicitly scoped", async () => {
    const broad = await loadTools({
      invoice: slot("invoice", INVOICE, "Stale balance"),
    });
    broad.mocks.state.tableResults.appointments = {
      data: [
        {
          id: OTHER_INVOICE,
          scheduled_at: "2026-07-20T10:00:00.000Z",
          outstanding_amount: 100,
          patients: { full_name: "Visible Patient" },
        },
      ],
      error: null,
    };
    const broadResult = (await broad.listOutstandingInvoices.execute!(
      { limit: 10 },
      opts,
    )) as { outstanding: { appointment_id: string }[] };
    expect(broadResult.outstanding[0]?.appointment_id).toBe(OTHER_INVOICE);

    const scoped = await loadTools({
      invoice: slot("invoice", INVOICE, "Stale balance"),
    });
    scoped.mocks.state.tableResults.appointments = { data: [], error: null };
    await expect(
      scoped.listOutstandingInvoices.execute!(
        { limit: 10, use_active_invoice: true },
        opts,
      ),
    ).resolves.toMatchObject({ outstanding: [] });
    expect(scoped.mocks.state.queryLog).toContainEqual(
      expect.objectContaining({ args: ["eq", "id", INVOICE] }),
    );
  });
});

describe("P410-M2 complete-result uniqueness", () => {
  it("records a unique RLS-authorized outstanding invoice resolution", async () => {
    const tools = await loadTools();
    tools.mocks.state.tableResults.appointments = {
      data: [
        {
          id: INVOICE,
          scheduled_at: "2026-07-20T10:00:00.000Z",
          outstanding_amount: 250,
          patients: { full_name: "Mona Ali" },
        },
      ],
      error: null,
    };

    await tools.listOutstandingInvoices.execute!({ limit: 10 }, opts);
    expect(tools.recorder.takeAll()).toEqual([
      {
        entityType: "invoice",
        entityId: INVOICE,
        displayLabel: "Mona Ali · 250",
        setBy: "resolution",
      },
    ]);
  });

  it("does not record the first row when limit=1 truncates multiple matches", async () => {
    const tools = await loadTools();
    tools.mocks.state.tableResults.appointments = {
      data: [
        {
          id: INVOICE,
          scheduled_at: "2026-07-20T10:00:00.000Z",
          outstanding_amount: 250,
          patients: { full_name: "Mona Ali" },
        },
        {
          id: OTHER_INVOICE,
          scheduled_at: "2026-07-19T10:00:00.000Z",
          outstanding_amount: 200,
          patients: { full_name: "Sara Ali" },
        },
      ],
      error: null,
    };

    await expect(
      tools.listOutstandingInvoices.execute!({ limit: 1 }, opts),
    ).resolves.toMatchObject({ truncated: true, outstanding: [{ appointment_id: INVOICE }] });
    expect(tools.recorder.takeAll()).toEqual([]);
  });

  it("does not record any invoice when the complete result is ambiguous", async () => {
    const tools = await loadTools();
    tools.mocks.state.tableResults.appointments = {
      data: [
        {
          id: INVOICE,
          scheduled_at: "2026-07-20T10:00:00.000Z",
          outstanding_amount: 250,
          patients: { full_name: "Mona Ali" },
        },
        {
          id: OTHER_INVOICE,
          scheduled_at: "2026-07-19T10:00:00.000Z",
          outstanding_amount: 200,
          patients: { full_name: "Sara Ali" },
        },
      ],
      error: null,
    };

    await tools.listOutstandingInvoices.execute!({ limit: 10 }, opts);
    expect(tools.recorder.takeAll()).toEqual([]);
  });

  it("does not infer a unique appointment from a truncated appointment page", async () => {
    const tools = await loadTools();
    tools.mocks.state.tableResults.appointments = {
      data: Array.from({ length: 51 }, (_, index) => ({
        id:
          index === 0
            ? APPOINTMENT
            : `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
        scheduled_at: `2026-07-26T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
        status: "confirmed",
        duration_minutes: 30,
        patients: { full_name: `Patient ${index}`, file_number: `CF-${index}` },
        profiles: { full_name: "Dr Ahmed" },
        departments: { name: "Cardiology" },
      })),
      error: null,
    };

    await expect(
      tools.listAppointments.execute!({ preset: "today" }, opts),
    ).resolves.toMatchObject({ truncated: true });
    expect(tools.recorder.takeAll()).toEqual([]);
  });
});

describe("P4.10B report defaults", () => {
  it("uses an active report and re-runs its gate without rewriting the slot", async () => {
    const tools = await loadTools({
      report: slot("report", "no_shows", "No-shows"),
    });

    const result = (await tools.runClinicReport.execute!(
      { preset: "today" },
      opts,
    )) as { report: string; result: unknown };

    expect(tools.assertAnalyticsToolAccess).toHaveBeenCalledWith(USER);
    expect(tools.getNoShowReportData).toHaveBeenCalled();
    expect(result).toMatchObject({ report: "no_shows", result: { total: 2 } });
    expect(tools.recorder.takeAll()).toEqual([]);
  });

  it("records a successful allow-listed report as a deterministic resolution", async () => {
    const tools = await loadTools();

    await tools.runClinicReport.execute!(
      { preset: "today", report: "no_shows" },
      opts,
    );

    expect(tools.recorder.takeAll()).toEqual([
      {
        entityType: "report",
        entityId: "no_shows",
        displayLabel: "No-show report",
        setBy: "resolution",
      },
    ]);
  });

  it("returns only role-allowed report choices when no report is active", async () => {
    const tools = await loadTools();
    const result = (await tools.runClinicReport.execute!(
      { preset: "today" },
      opts,
    )) as { needs_clarification: boolean; field: string; candidates: unknown[] };

    expect(result).toMatchObject({
      needs_clarification: true,
      field: "report",
    });
    expect(result.candidates).toHaveLength(6);
    expect(tools.assertAnalyticsToolAccess).not.toHaveBeenCalled();
    expect(tools.getNoShowReportData).not.toHaveBeenCalled();
  });
});
