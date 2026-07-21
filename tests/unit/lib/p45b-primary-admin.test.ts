import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { method: string; args: unknown[] }[] = [];
const mocks = vi.hoisted(() => ({
  result: { data: [{ id: "admin-1" }], error: null as unknown },
}));

class ProfilesQuery {
  select(...args: unknown[]) {
    calls.push({ method: "select", args });
    return this;
  }
  eq(...args: unknown[]) {
    calls.push({ method: "eq", args });
    return this;
  }
  is(...args: unknown[]) {
    calls.push({ method: "is", args });
    return this;
  }
  order(...args: unknown[]) {
    calls.push({ method: "order", args });
    return this;
  }
  limit(...args: unknown[]) {
    calls.push({ method: "limit", args });
    return Promise.resolve(mocks.result);
  }
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: vi.fn(() => ({
    from: (table: string) => {
      calls.push({ method: "from", args: [table] });
      return new ProfilesQuery();
    },
  })),
}));

describe("P4.5B getPrimaryClinicAdminId app/DB parity (L1)", () => {
  beforeEach(() => {
    calls.length = 0;
    mocks.result = { data: [{ id: "admin-1" }], error: null };
  });

  it("mirrors assert_primary_ai_provider_admin's predicate and deterministic tiebreak", async () => {
    const { getPrimaryClinicAdminId } = await import("@/lib/primary-admin");
    const result = await getPrimaryClinicAdminId("clinic-a");

    expect(result).toBe("admin-1");
    // Full predicate parity with the database authority: role, is_active,
    // is_deleted, and the deleted_at null check.
    expect(calls).toContainEqual({ method: "eq", args: ["role", "admin"] });
    expect(calls).toContainEqual({ method: "eq", args: ["is_active", true] });
    expect(calls).toContainEqual({ method: "eq", args: ["is_deleted", false] });
    expect(calls).toContainEqual({ method: "is", args: ["deleted_at", null] });

    // Deterministic tiebreak parity: created_at asc, id asc.
    const orderCalls = calls.filter((call) => call.method === "order");
    expect(orderCalls).toEqual([
      { method: "order", args: ["created_at", { ascending: true }] },
      { method: "order", args: ["id", { ascending: true }] },
    ]);
  });

  it("returns null when no eligible admin is found", async () => {
    mocks.result = { data: [], error: null };
    const { getPrimaryClinicAdminId } = await import("@/lib/primary-admin");
    expect(await getPrimaryClinicAdminId("clinic-a")).toBeNull();
  });

  it("preserves a query failure instead of treating it as no eligible admin", async () => {
    mocks.result = { data: null as unknown as { id: string }[], error: { message: "boom" } };
    const { getPrimaryClinicAdminId, isPrimaryClinicAdmin } = await import(
      "@/lib/primary-admin"
    );
    await expect(getPrimaryClinicAdminId("clinic-a")).rejects.toThrow(
      "Failed to determine the primary clinic administrator",
    );
    await expect(
      isPrimaryClinicAdmin("admin-1", "clinic-a"),
    ).rejects.toThrow("Failed to determine the primary clinic administrator");
  });
});
