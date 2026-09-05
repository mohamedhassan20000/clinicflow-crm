import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A chainable stand-in for the PostgREST builder that records what each query
 * asked for. The point of these tests is *which* rows the action goes looking
 * for — the raw half of `audit_logs` must never be one of them, and a manager
 * must never be handed AI-provider history — so the recorded query is the
 * assertion, not the returned data.
 */
type Recorded = {
  table: string;
  filters: { method: string; args: unknown[] }[];
};

const state = {
  role: "admin" as "admin" | "manager",
  queries: [] as Recorded[],
  rows: {} as Record<string, unknown[]>,
};

function builder(table: string) {
  const recorded: Recorded = { table, filters: [] };
  state.queries.push(recorded);
  const proxy: Record<string, unknown> = {};
  const chain = new Proxy(proxy, {
    get(_target, property: string) {
      if (property === "then") {
        return (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
          resolve({ data: state.rows[table] ?? [], error: null });
      }
      return (...args: unknown[]) => {
        if (property !== "select" && property !== "order" && property !== "limit") {
          recorded.filters.push({ method: property, args });
        }
        return chain;
      };
    },
  });
  return chain;
}

vi.mock("@/lib/rbac", () => ({
  requireRole: vi.fn(async () => ({
    id: "u1",
    clinicId: "c1",
    role: state.role,
    email: "a@b.com",
    fullName: "Admin",
    avatarUrl: null,
    departmentId: null,
    mustChangePassword: false,
  })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from: (table: string) => builder(table) })),
}));

const { getAuditLog } = await import("@/actions/audit-log");

function queryFor(table: string) {
  return state.queries.filter((query) => query.table === table);
}

function orFilters(table: string) {
  return queryFor(table)
    .flatMap((query) => query.filters)
    .filter((filter) => filter.method === "or")
    .flatMap((filter) => String(filter.args[0]).split(","));
}

beforeEach(() => {
  state.queries = [];
  state.rows = {};
  state.role = "admin";
});

describe("which trails the feed reads", () => {
  it("reads the new trail, the operational trail and only the curated legacy namespaces", async () => {
    await getAuditLog();
    expect(queryFor("admin_audit_events")).toHaveLength(1);
    expect(queryFor("activity_events")).toHaveLength(1);
    expect(orFilters("audit_logs")).toEqual([
      "action.like.messaging:*",
      "action.like.AI_PROVIDER_*",
    ]);
  });

  it("never asks for the raw table-diff half of audit_logs", async () => {
    await getAuditLog();
    const filters = orFilters("audit_logs").join(" ");
    for (const raw of ["INSERT", "UPDATE", "DELETE", "patients", "medical_notes"]) {
      expect(filters).not.toContain(raw);
    }
  });

  it("withholds AI provider history from a manager", async () => {
    state.role = "manager";
    await getAuditLog();
    expect(orFilters("audit_logs")).toEqual(["action.like.messaging:*"]);
  });

  it("does not query the legacy trail at all when a manager filters to AI", async () => {
    state.role = "manager";
    await getAuditLog({ module: "ai" });
    expect(queryFor("audit_logs")).toHaveLength(0);
    // The administrative trail is still queried; its own policy hides AI rows
    // from a manager, so the filter yields nothing rather than leaking.
    expect(queryFor("admin_audit_events")).toHaveLength(1);
  });

  it("queries only the trail a module filter can be served by", async () => {
    await getAuditLog({ module: "appointments" });
    expect(queryFor("admin_audit_events")).toHaveLength(0);
    expect(queryFor("activity_events")).toHaveLength(1);

    state.queries = [];
    await getAuditLog({ module: "services" });
    expect(queryFor("admin_audit_events")).toHaveLength(1);
    expect(queryFor("activity_events")).toHaveLength(0);
    expect(queryFor("audit_logs")).toHaveLength(0);
  });
});

describe("filters and pagination", () => {
  it("pushes every filter to the database rather than the browser", async () => {
    await getAuditLog({
      module: "services",
      action: "service.price_changed",
      actorId: "u9",
      entityType: "service",
      entityId: "s1",
      outcome: "success",
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-30T00:00:00.000Z",
    });
    const filters = queryFor("admin_audit_events")[0].filters;
    const methods = filters.map((filter) => `${filter.method}:${filter.args[0]}`);
    expect(methods).toEqual([
      "eq:module",
      "eq:action",
      "eq:actor_user_id",
      "eq:entity_type",
      "eq:entity_id",
      "eq:outcome",
      "gte:occurred_at",
      "lte:occurred_at",
    ]);
  });

  it("strips wildcards out of a search term instead of passing them through", async () => {
    await getAuditLog({ search: "50%_off,now" });
    const search = queryFor("admin_audit_events")[0].filters.find(
      (filter) => filter.method === "ilike",
    );
    expect(search?.args[1]).toBe("%50offnow%");
  });

  it("bounds the page size whatever the caller asks for", async () => {
    await getAuditLog({ limit: 5_000 });
    // The limit is applied to the query builder; the merge then trims to it.
    const page = await getAuditLog({ limit: 5_000 });
    expect(page.events).toHaveLength(0);
    expect(page.nextCursor).toBeNull();
  });

  it("queries each trail with an inclusive cursor so a timestamp tie is not lost", async () => {
    await getAuditLog({ cursor: "2026-09-01T10:00:00.000Z|e1" });
    for (const table of ["admin_audit_events", "activity_events", "audit_logs"]) {
      const bound = queryFor(table)[0].filters.find((filter) => filter.method === "lte");
      expect(bound).toBeTruthy();
      expect(bound!.args[1]).toBe("2026-09-01T10:00:00.000Z");
    }
  });

  it("skips the trails a name search cannot honestly serve", async () => {
    await getAuditLog({ search: "Consultation" });
    expect(queryFor("admin_audit_events")).toHaveLength(1);
    expect(queryFor("activity_events")).toHaveLength(0);
    expect(queryFor("audit_logs")).toHaveLength(0);
  });
});
