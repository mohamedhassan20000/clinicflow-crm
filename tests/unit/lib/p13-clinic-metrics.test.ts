/**
 * P13 — clinic aggregate metrics, shared by the owner clinic page and the
 * clinic-admin dashboard.
 *
 * Two properties are asserted here and neither is cosmetic:
 *
 *  1. PRIVACY — every query is a `head: true` count. If a future edit turns one
 *     into a row read, patient/appointment/document/invoice content starts
 *     flowing to the platform owner. The recording client below fails the suite
 *     the moment that happens.
 *  2. DEFINITION — each count's filters are pinned, so "documents issued" and
 *     "appointments" cannot silently start meaning something else on one screen
 *     and not the other.
 */
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { getClinicMetrics, monthWindow, percentChange } from "@/lib/analytics/clinic-metrics";

const CLINIC = "22222222-2222-4222-8222-222222222222";
const OTHER_CLINIC = "33333333-3333-4333-8333-333333333333";

type RecordedQuery = {
  table: string;
  options: Record<string, unknown>;
  filters: Array<[string, string, unknown]>;
};

/**
 * A minimal PostgREST double that records what was asked for. Every builder
 * method returns the same thenable, so the chain shape does not matter — only
 * the table, the select options, and the filters, which is exactly what the
 * privacy and definition properties are about.
 */
function recordingClient(counts: Record<string, number> = {}) {
  const queries: RecordedQuery[] = [];

  function builder(record: RecordedQuery) {
    const chain: Record<string, unknown> = {};
    for (const method of ["eq", "neq", "is", "gte", "lt", "in", "not"]) {
      chain[method] = (column: string, value: unknown) => {
        record.filters.push([method, column, value]);
        return chain;
      };
    }
    chain.then = (resolve: (value: { count: number; error: null }) => unknown) =>
      Promise.resolve(resolve({ count: counts[record.table] ?? 0, error: null }));
    return chain;
  }

  const client = {
    from(table: string) {
      return {
        select(_columns: string, options: Record<string, unknown>) {
          const record: RecordedQuery = { table, options, filters: [] };
          queries.push(record);
          return builder(record);
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient<Database>, queries };
}

function filtersFor(queries: RecordedQuery[], table: string) {
  return queries.filter((query) => query.table === table).map((query) => query.filters);
}

describe("month window", () => {
  it("returns UTC month boundaries, rolling across the year", () => {
    expect(monthWindow(new Date("2026-08-15T10:00:00.000Z"))).toEqual({
      previousStart: "2026-07-01T00:00:00.000Z",
      currentStart: "2026-08-01T00:00:00.000Z",
      nextStart: "2026-09-01T00:00:00.000Z",
    });
    expect(monthWindow(new Date("2026-01-02T00:00:00.000Z")).previousStart).toBe(
      "2025-12-01T00:00:00.000Z",
    );
  });
});

describe("percent change", () => {
  it("returns null rather than inventing a comparison against zero", () => {
    expect(percentChange(12, 0)).toBeNull();
    expect(percentChange(0, 0)).toBeNull();
  });

  it("rounds to whole percentage points and signs correctly", () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(50, 100)).toBe(-50);
    expect(percentChange(1, 3)).toBe(-67);
  });
});

describe("getClinicMetrics", () => {
  it("only ever issues head-count queries — never a row read", async () => {
    const { client, queries } = recordingClient();
    await getClinicMetrics(client, CLINIC);

    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) {
      expect(query.options).toMatchObject({ head: true, count: "exact" });
    }
  });

  it("scopes every single query to the requested clinic", async () => {
    const { client, queries } = recordingClient();
    await getClinicMetrics(client, CLINIC);

    for (const query of queries) {
      expect(query.filters).toContainEqual(["eq", "clinic_id", CLINIC]);
      expect(query.filters).not.toContainEqual(["eq", "clinic_id", OTHER_CLINIC]);
    }
  });

  it("reads only aggregate-safe tables", async () => {
    const { client, queries } = recordingClient();
    await getClinicMetrics(client, CLINIC);

    expect(new Set(queries.map((query) => query.table))).toEqual(
      new Set(["patients", "appointments", "documents", "profiles", "departments", "insurance_providers"]),
    );
  });

  it("excludes soft-deleted patients", async () => {
    const { client, queries } = recordingClient();
    await getClinicMetrics(client, CLINIC);
    for (const filters of filtersFor(queries, "patients")) {
      expect(filters).toContainEqual(["eq", "is_deleted", false]);
    }
  });

  it("excludes soft-deleted and superseded appointments so a reschedule counts once", async () => {
    const { client, queries } = recordingClient();
    await getClinicMetrics(client, CLINIC);
    for (const filters of filtersFor(queries, "appointments")) {
      expect(filters).toContainEqual(["is", "deleted_at", null]);
      expect(filters).toContainEqual(["neq", "status", "replaced"]);
    }
  });

  it("counts only issued documents, and invoices as the INVOICE subset of them", async () => {
    const { client, queries } = recordingClient();
    await getClinicMetrics(client, CLINIC);

    const documentQueries = filtersFor(queries, "documents");
    for (const filters of documentQueries) {
      expect(filters).toContainEqual(["eq", "status", "issued"]);
    }
    const invoiceQueries = documentQueries.filter((filters) =>
      filters.some(([method, column, value]) => method === "eq" && column === "doc_type" && value === "INVOICE"),
    );
    // One total plus one per period window.
    expect(invoiceQueries).toHaveLength(3);
  });

  it("counts staff as active, non-deleted profiles", async () => {
    const { client, queries } = recordingClient();
    await getClinicMetrics(client, CLINIC);
    const [filters] = filtersFor(queries, "profiles");
    expect(filters).toContainEqual(["eq", "is_active", true]);
    expect(filters).toContainEqual(["eq", "is_deleted", false]);
  });

  it("bounds period counts to the calendar month, half-open", async () => {
    const { client, queries } = recordingClient();
    await getClinicMetrics(client, CLINIC, new Date("2026-08-15T00:00:00.000Z"));

    const patientPeriods = filtersFor(queries, "patients").filter((filters) =>
      filters.some(([method]) => method === "gte"),
    );
    expect(patientPeriods).toContainEqual(
      expect.arrayContaining([
        ["gte", "created_at", "2026-08-01T00:00:00.000Z"],
        ["lt", "created_at", "2026-09-01T00:00:00.000Z"],
      ]),
    );
    expect(patientPeriods).toContainEqual(
      expect.arrayContaining([
        ["gte", "created_at", "2026-07-01T00:00:00.000Z"],
        ["lt", "created_at", "2026-08-01T00:00:00.000Z"],
      ]),
    );
  });

  it("projects the counts it was given onto the right metric names", async () => {
    const { client } = recordingClient({
      patients: 40,
      appointments: 120,
      documents: 15,
      profiles: 7,
      departments: 3,
      insurance_providers: 5,
    });

    const metrics = await getClinicMetrics(client, CLINIC);
    expect(metrics.totals).toEqual({
      patients: 40,
      appointments: 120,
      documentsIssued: 15,
      invoicesIssued: 15,
      activeStaff: 7,
      departments: 3,
      insuranceCompanies: 5,
    });
    // Same source count in both windows → no change, not a null.
    expect(metrics.trend.change.patients).toBe(0);
  });

  it("degrades a failing counter to zero instead of failing the whole page", async () => {
    const { client } = recordingClient({ patients: 9 });
    const failing = {
      from(table: string) {
        if (table === "departments") {
          return {
            select: () => ({
              eq: () => ({ is: () => Promise.reject(new Error("relation does not exist")) }),
            }),
          };
        }
        return (client as unknown as { from: (table: string) => unknown }).from(table);
      },
    } as unknown as SupabaseClient<Database>;

    const metrics = await getClinicMetrics(failing, CLINIC);
    expect(metrics.totals.departments).toBe(0);
    expect(metrics.totals.patients).toBe(9);
  });
});

describe("clinic-admin isolation", () => {
  it("cannot be pointed at another clinic by the caller's own data", async () => {
    const { client, queries } = recordingClient();
    // The clinic-admin caller passes its session clinic id; the module never
    // reads a clinic id from a row, a search param, or a request body.
    await getClinicMetrics(client, OTHER_CLINIC);
    expect(
      queries.every((query) =>
        query.filters.some(([, column, value]) => column === "clinic_id" && value === OTHER_CLINIC),
      ),
    ).toBe(true);
  });
});
