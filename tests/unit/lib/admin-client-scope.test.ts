import { beforeEach, describe, expect, it, vi } from "vitest";

const queryLog: { table: string; method: string; args: unknown[] }[] = [];

class QueryBuilder {
  constructor(private readonly table: string) {}

  select(...args: unknown[]) {
    queryLog.push({ table: this.table, method: "select", args });
    return this;
  }

  update(...args: unknown[]) {
    queryLog.push({ table: this.table, method: "update", args });
    return this;
  }

  delete(...args: unknown[]) {
    queryLog.push({ table: this.table, method: "delete", args });
    return this;
  }

  insert(...args: unknown[]) {
    queryLog.push({ table: this.table, method: "insert", args });
    return this;
  }

  upsert(...args: unknown[]) {
    queryLog.push({ table: this.table, method: "upsert", args });
    return this;
  }

  eq(...args: unknown[]) {
    queryLog.push({ table: this.table, method: "eq", args });
    return this;
  }
}

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => new QueryBuilder(table),
    auth: { admin: { deleteUser: vi.fn() } },
  })),
}));

describe("createClinicScopedAdminClient", () => {
  beforeEach(() => {
    queryLog.length = 0;
  });

  it("automatically adds clinic_id filters to tenant table reads and updates", async () => {
    const { createClinicScopedAdminClient } = await import("@/lib/supabase/admin");
    const admin = createClinicScopedAdminClient("clinic-a");

    admin.from("patients").select("id").eq("is_deleted", false);
    admin.from("appointments").update({ status: "cancelled" }).eq("id", "appt-1");

    expect(queryLog).toContainEqual({
      table: "patients",
      method: "eq",
      args: ["clinic_id", "clinic-a"],
    });
    expect(queryLog).toContainEqual({
      table: "appointments",
      method: "eq",
      args: ["clinic_id", "clinic-a"],
    });
  });

  it("injects the scoped clinic_id into tenant table inserts", async () => {
    const { createClinicScopedAdminClient } = await import("@/lib/supabase/admin");
    const admin = createClinicScopedAdminClient("clinic-a");
    const looseAdmin = admin as unknown as {
      from: (table: string) => { insert: (payload: unknown) => unknown };
    };

    looseAdmin.from("patient_documents").insert({
      id: "doc-1",
      patient_id: "p-1",
      category: "other",
      file_name: "doc.pdf",
      mime_type: "application/pdf",
      size_bytes: 10,
      storage_path: "documents/clinic-a/p-1/other/doc.pdf",
    });

    expect(queryLog).toContainEqual({
      table: "patient_documents",
      method: "insert",
      args: [
        expect.objectContaining({
          id: "doc-1",
          clinic_id: "clinic-a",
        }),
      ],
    });
    expect(queryLog).not.toContainEqual({
      table: "patient_documents",
      method: "eq",
      args: ["clinic_id", "clinic-a"],
    });
  });

  it("rejects inserts that try to use a different clinic_id", async () => {
    const { createClinicScopedAdminClient } = await import("@/lib/supabase/admin");
    const admin = createClinicScopedAdminClient("clinic-a");
    const looseAdmin = admin as unknown as {
      from: (table: string) => { insert: (payload: unknown) => unknown };
    };

    expect(() =>
      looseAdmin.from("patients").insert({
        id: "patient-1",
        clinic_id: "clinic-b",
        created_by: "user-1",
        date_of_birth: "1990-01-01",
        email: null,
        file_number: "CF-0001",
        full_name: "Patient",
        national_id: "N1",
        phone: "123",
      }),
    ).toThrow(/different clinic_id/i);
  });

  it("rejects updates that try to move rows to a different clinic_id", async () => {
    const { createClinicScopedAdminClient } = await import("@/lib/supabase/admin");
    const admin = createClinicScopedAdminClient("clinic-a");
    const looseAdmin = admin as unknown as {
      from: (table: string) => { update: (payload: unknown) => unknown };
    };

    expect(() =>
      looseAdmin.from("patients").update({ clinic_id: "clinic-b" }),
    ).toThrow(/different clinic_id/i);
  });

  it("throws for unclassified tables instead of failing open", async () => {
    const { createClinicScopedAdminClient } = await import("@/lib/supabase/admin");
    const admin = createClinicScopedAdminClient("clinic-a");
    const looseAdmin = admin as unknown as { from: (table: string) => unknown };

    expect(() => looseAdmin.from("future_phi_table")).toThrow(
      /unclassified table/i,
    );
  });

  it("classifies every clinic-owned P1A table for fail-closed admin access", async () => {
    const { createClinicScopedAdminClient } = await import("@/lib/supabase/admin");
    const admin = createClinicScopedAdminClient("clinic-a") as unknown as {
      from: (table: string) => { select: (columns: string) => unknown };
    };

    for (const table of [
      "subscriptions",
      "usage_counters",
      "coupon_redemptions",
      "clinic_feature_overrides",
    ]) {
      expect(() => admin.from(table).select("id")).not.toThrow();
      expect(queryLog).toContainEqual({
        table,
        method: "eq",
        args: ["clinic_id", "clinic-a"],
      });
    }
  });

  it("keeps the AI provider permission read on the clinic-scoped path", async () => {
    const { createClinicScopedAdminClient } = await import("@/lib/supabase/admin");
    const admin = createClinicScopedAdminClient("clinic-a");

    expect(() =>
      admin
        .from("user_ai_permissions")
        .select("user_id, granted")
        .eq("permission_key", "ai.financial_insights"),
    ).not.toThrow();
    expect(queryLog).toContainEqual({
      table: "user_ai_permissions",
      method: "eq",
      args: ["clinic_id", "clinic-a"],
    });
  });

  it("keeps both Assistant placement tables on the clinic-scoped path", async () => {
    const { createClinicScopedAdminClient } = await import("@/lib/supabase/admin");
    const admin = createClinicScopedAdminClient("clinic-a") as unknown as {
      from: (table: string) => { select: (columns: string) => unknown };
    };

    for (const table of [
      "assistant_launcher_settings",
      "assistant_launcher_user_overrides",
    ]) {
      expect(() => admin.from(table).select("enabled")).not.toThrow();
      expect(queryLog).toContainEqual({
        table,
        method: "eq",
        args: ["clinic_id", "clinic-a"],
      });
    }
  });

  it("keeps scoped service-role access to Assistant placement read-only", async () => {
    const { createClinicScopedAdminClient } = await import("@/lib/supabase/admin");
    const admin = createClinicScopedAdminClient("clinic-a") as unknown as {
      from: (table: string) => {
        insert: (payload: unknown) => unknown;
        update: (payload: unknown) => unknown;
        delete: () => unknown;
      };
    };

    for (const table of [
      "assistant_launcher_settings",
      "assistant_launcher_user_overrides",
    ]) {
      expect(() => admin.from(table).insert({ enabled: true })).toThrow(
        /read-only access/i,
      );
      expect(() => admin.from(table).update({ enabled: false })).toThrow(
        /read-only access/i,
      );
      expect(() => admin.from(table).delete()).toThrow(/read-only access/i);
    }

    expect(queryLog).toEqual([]);
  });

  it("leaves global-or-assigned coupons for explicit caller scoping", async () => {
    const { createClinicScopedAdminClient } = await import("@/lib/supabase/admin");
    const admin = createClinicScopedAdminClient("clinic-a") as unknown as {
      from: (table: string) => {
        select: (columns: string) => unknown;
        insert: (payload: unknown) => unknown;
      };
    };

    expect(() => admin.from("coupons").select("id")).not.toThrow();
    admin.from("coupons").insert({
      code: "GLOBAL",
      kind: "lifetime_free",
      clinic_id: null,
      invitation_id: null,
    });

    expect(queryLog).not.toContainEqual({
      table: "coupons",
      method: "eq",
      args: ["clinic_id", "clinic-a"],
    });
    expect(queryLog).toContainEqual({
      table: "coupons",
      method: "insert",
      args: [expect.objectContaining({ clinic_id: null, invitation_id: null })],
    });
  });

  it("allows documented join-scoped tables without pretending to add clinic_id", async () => {
    const { createClinicScopedAdminClient } = await import("@/lib/supabase/admin");
    const admin = createClinicScopedAdminClient("clinic-a");

    admin.from("feedback").delete().eq("appointment_id", "appt-1");

    expect(queryLog).toContainEqual({
      table: "feedback",
      method: "delete",
      args: [],
    });
    expect(queryLog).not.toContainEqual({
      table: "feedback",
      method: "eq",
      args: ["clinic_id", "clinic-a"],
    });
  });

  it("blocks unscoped RPC and storage access through the scoped wrapper", async () => {
    const { createClinicScopedAdminClient } = await import("@/lib/supabase/admin");
    const admin = createClinicScopedAdminClient("clinic-a") as unknown as {
      rpc: unknown;
      storage: unknown;
    };

    expect(() => admin.rpc).toThrow(/not available/i);
    expect(() => admin.storage).toThrow(/not available/i);
  });
});
