import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Post-plan product completion — change 3: seeding a contextual launcher's new
 * conversation with server-derived page context.
 *
 * The launcher used to resume the caller's latest conversation, which meant the
 * record on screen never had to be carried anywhere. Now it does, and the whole
 * risk of that change lives in this module: the browser submits a bounded
 * descriptor, and this is what turns it into stored context. So every test here
 * is about provenance — the label is re-read through the caller's own RLS
 * client, the same tool gate as the equivalent user-choice runs, and a record
 * the caller cannot read produces no slot at all rather than a slot with an
 * id and a guessed label.
 */

const CLINIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PATIENT = "33333333-3333-4333-8333-333333333333";
const DOCTOR = "44444444-4444-4444-8444-444444444444";

function user(role: "admin" | "doctor" | "receptionist" = "admin") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    email: "staff@example.test",
    role,
    fullName: "Staff",
    avatarUrl: null,
    clinicId: CLINIC,
    departmentId: null,
    mustChangePassword: false,
  };
}

type Filters = Record<string, unknown>;

function client(rows: Record<string, unknown>) {
  const calls: { table: string; filters: Filters }[] = [];
  return {
    calls,
    supabase: {
      from(table: string) {
        const filters: Filters = {};
        calls.push({ table, filters });
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (column: string, value: unknown) => {
            filters[`eq:${column}`] = value;
            return chain;
          },
          is: (column: string, value: unknown) => {
            filters[`is:${column}`] = value;
            return chain;
          },
          maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
        };
        return chain;
      },
    },
  };
}

const gates = vi.hoisted(() => ({
  analytics: vi.fn(),
  financial: vi.fn(),
}));

let seed: typeof import("@/lib/ai/page-context-seed");

beforeEach(async () => {
  vi.resetModules();
  gates.analytics.mockReset().mockResolvedValue(undefined);
  gates.financial.mockReset().mockResolvedValue(undefined);
  vi.doMock("server-only", () => ({}));
  vi.doMock("@/lib/ai/authorization", () => ({
    assertAnalyticsToolAccess: gates.analytics,
    assertFinancialInsightsAccess: gates.financial,
  }));
  seed = await import("@/lib/ai/page-context-seed");
});

describe("resolvePageContextSeed", () => {
  it("seeds a patient slot from a name re-read through the caller's RLS client", async () => {
    const { supabase, calls } = client({
      patients: { id: PATIENT, full_name: "Ahmed Hassan" },
    });
    await expect(
      seed.resolvePageContextSeed({
        supabase: supabase as never,
        user: user("doctor"),
        context: { type: "patient", patientId: PATIENT },
        locale: "en",
      }),
    ).resolves.toEqual([{
      entityType: "patient",
      entityId: PATIENT,
      displayLabel: "Ahmed Hassan",
      setBy: "page_context",
    }]);
    // Tenant predicate and soft-delete filter present; the browser supplied only
    // the id, and the label came from the row the RLS client returned.
    expect(calls[0]!.filters).toMatchObject({
      "eq:id": PATIENT,
      "eq:clinic_id": CLINIC,
      "is:deleted_at": null,
    });
  });

  it("seeds nothing when the record is outside the caller's scope", async () => {
    const { supabase } = client({});
    await expect(
      seed.resolvePageContextSeed({
        supabase: supabase as never,
        user: user("doctor"),
        context: { type: "patient", patientId: PATIENT },
        locale: "en",
      }),
    ).resolves.toEqual([]);
  });

  it("runs the analytics gate before seeding a doctor slot from appointments context", async () => {
    const { supabase } = client({ profiles: { id: DOCTOR, full_name: "Dr Salma" } });
    await expect(
      seed.resolvePageContextSeed({
        supabase: supabase as never,
        user: user(),
        context: {
          type: "appointments",
          dateRange: { from: "2026-08-01", to: "2026-08-07" },
          doctorId: DOCTOR,
        },
        locale: "en",
      }),
    ).resolves.toEqual([{
      entityType: "staff",
      entityId: DOCTOR,
      displayLabel: "Dr Salma",
      setBy: "page_context",
    }]);
    expect(gates.analytics).toHaveBeenCalledWith(user());
  });

  it("seeds no doctor slot when the analytics gate denies", async () => {
    gates.analytics.mockRejectedValue(new Error("feature_not_entitled"));
    const { supabase, calls } = client({ profiles: { id: DOCTOR, full_name: "Dr Salma" } });
    await expect(
      seed.resolvePageContextSeed({
        supabase: supabase as never,
        user: user("receptionist"),
        context: {
          type: "appointments",
          dateRange: { from: "2026-08-01", to: "2026-08-07" },
          doctorId: DOCTOR,
        },
        locale: "en",
      }),
    ).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("seeds a localized report slot only for a role the report admits", async () => {
    const { supabase } = client({});
    await expect(
      seed.resolvePageContextSeed({
        supabase: supabase as never,
        user: user(),
        context: {
          type: "reports",
          report: "no_shows",
          range: { from: "2026-08-01", to: "2026-08-07" },
        },
        locale: "ar",
      }),
    ).resolves.toEqual([{
      entityType: "report",
      entityId: "no_shows",
      displayLabel: "تقرير عدم الحضور",
      setBy: "page_context",
    }]);

    await expect(
      seed.resolvePageContextSeed({
        supabase: supabase as never,
        user: user("receptionist"),
        context: {
          type: "reports",
          report: "doctor_performance",
          range: { from: "2026-08-01", to: "2026-08-07" },
        },
        locale: "en",
      }),
    ).resolves.toEqual([]);
  });

  it("routes a financial report through the financial gate", async () => {
    gates.financial.mockRejectedValue(new Error("permission_not_granted"));
    const { supabase } = client({});
    await expect(
      seed.resolvePageContextSeed({
        supabase: supabase as never,
        user: user(),
        context: {
          type: "reports",
          report: "revenue",
          range: { from: "2026-08-01", to: "2026-08-07" },
        },
        locale: "en",
      }),
    ).resolves.toEqual([]);
    expect(gates.financial).toHaveBeenCalled();
  });

  it.each([
    ["dashboard", { type: "dashboard" }],
    ["revenue", { type: "revenue", dateRange: { from: "2026-08-01", to: "2026-08-07" } }],
    ["invoices", { type: "invoices", filter: "outstanding" }],
    ["staff", { type: "staff" }],
    ["departments", { type: "departments" }],
    ["doctor-schedule", { type: "doctor-schedule" }],
  ] as const)("seeds no slot for the %s view context and reads nothing", async (_name, context) => {
    const { supabase, calls } = client({});
    await expect(
      seed.resolvePageContextSeed({
        supabase: supabase as never,
        user: user(),
        context: context as never,
        locale: "en",
      }),
    ).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("seeds nothing without a page context", async () => {
    const { supabase } = client({});
    await expect(
      seed.resolvePageContextSeed({
        supabase: supabase as never,
        user: user(),
        context: null,
        locale: "en",
      }),
    ).resolves.toEqual([]);
  });

  it("produces only slots the conversation-context schema accepts", async () => {
    const { applyProposals, parseActiveContext } = await import(
      "@/lib/ai/conversation-context"
    );
    const { supabase } = client({ patients: { id: PATIENT, full_name: "Ahmed Hassan" } });
    const proposals = await seed.resolvePageContextSeed({
      supabase: supabase as never,
      user: user("doctor"),
      context: { type: "patient", patientId: PATIENT },
      locale: "en",
    });
    // A proposal that fails validation is silently dropped by `applyProposal`,
    // so round-tripping through the real parser is what proves it survives.
    const context = applyProposals({}, proposals);
    expect(parseActiveContext(context).patient).toMatchObject({
      entity_type: "patient",
      entity_id: PATIENT,
      set_by: "page_context",
    });
  });
});
