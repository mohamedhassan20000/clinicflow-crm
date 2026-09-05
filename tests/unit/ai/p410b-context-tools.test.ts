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
const INVOICE = "33333333-3333-4333-8333-333333333333";
const OTHER_INVOICE = "77777777-7777-4777-8777-777777777777";
const STAFF = "44444444-4444-4444-8444-444444444444";
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
  const [{ listOutstandingInvoicesTool }, { runClinicReportTool }] =
    await Promise.all([
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
    assertFinancialInsightsAccess,
    getNoShowReportData,
    getDoctorPerformanceData,
    listOutstandingInvoices: listOutstandingInvoicesTool(context),
    runClinicReport: runClinicReportTool(context),
  };
}

/**
 * Phase 7. The appointment-list cases that stood in these blocks went with
 * `list_appointments` / `list_doctor_appointments` when the resource layer
 * superseded them. Their `use_active_*` intent flags have no generic successor
 * *by construction*: `query_resource` never reads the active context at all, so
 * "a broad query is never silently narrowed by a stale slot" stopped being a
 * behaviour to test and became a structural property, asserted in
 * `tests/unit/ai/phase7-context-parity.test.ts` alongside the proposal cases
 * these blocks used to own. The report, invoice and staff cases below are
 * unchanged — those tools were retained.
 */
describe("P410-M1 advisory list context", () => {
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
