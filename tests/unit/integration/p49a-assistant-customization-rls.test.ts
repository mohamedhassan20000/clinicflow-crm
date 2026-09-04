import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
type Client = SupabaseClient<Database>;

const suffix = `p49a-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P49aPlacementTest12345";
const clinicA = randomUUID();
const clinicB = randomUUID();
const clinics = [clinicA, clinicB];
const userIds: string[] = [];

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function sessionClient(): Client {
  return createClient<Database>(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createUser(label: string) {
  const email = `${suffix}-${label}@example.com`;
  const created = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) {
    throw created.error ?? new Error("No user returned");
  }
  userIds.push(created.data.user.id);
  const client = sessionClient();
  const login = await client.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  return { id: created.data.user.id, client };
}

let primaryA: Client;
let secondaryA: Client;
let doctorA: Client;
let primaryB: Client;
let primaryAId = "";
let secondaryAId = "";
let doctorAId = "";
let primaryBId = "";

async function cleanupClinicFixtures() {
  await service.from("audit_logs").delete().in("clinic_id", clinics);
  await service.from("profiles").delete().in("clinic_id", clinics);
  await service.from("clinics").delete().in("id", clinics);
}

async function cleanupPlacementAsPrimaryAdmins() {
  if (!primaryA || !primaryB) return;
  await Promise.all([
    primaryA.from("assistant_launcher_user_overrides").delete().eq("clinic_id", clinicA),
    primaryA.from("assistant_launcher_settings").delete().eq("clinic_id", clinicA),
    primaryB.from("assistant_launcher_user_overrides").delete().eq("clinic_id", clinicB),
    primaryB.from("assistant_launcher_settings").delete().eq("clinic_id", clinicB),
  ]);
}

beforeAll(async () => {
  const [pa, sa, da, pb] = await Promise.all([
    createUser("primary-a"),
    createUser("secondary-a"),
    createUser("doctor-a"),
    createUser("primary-b"),
  ]);
  primaryA = pa.client;
  secondaryA = sa.client;
  doctorA = da.client;
  primaryB = pb.client;
  primaryAId = pa.id;
  secondaryAId = sa.id;
  doctorAId = da.id;
  primaryBId = pb.id;

  await cleanupClinicFixtures();

  const clinicInsert = await service.from("clinics").insert([
    { id: clinicA, name: `P49A Clinic A ${suffix}` },
    { id: clinicB, name: `P49A Clinic B ${suffix}` },
  ]);
  if (clinicInsert.error) throw clinicInsert.error;

  const profileInsert = await service.from("profiles").insert([
    {
      id: primaryAId,
      clinic_id: clinicA,
      full_name: "P49A Primary A",
      role: "admin",
      created_at: "2020-01-01T00:00:00Z",
    },
    {
      id: secondaryAId,
      clinic_id: clinicA,
      full_name: "P49A Secondary A",
      role: "admin",
      created_at: "2024-01-01T00:00:00Z",
    },
    {
      id: doctorAId,
      clinic_id: clinicA,
      full_name: "P49A Doctor A",
      role: "doctor",
      created_at: "2024-06-01T00:00:00Z",
    },
    {
      id: primaryBId,
      clinic_id: clinicB,
      full_name: "P49A Primary B",
      role: "admin",
      created_at: "2020-01-01T00:00:00Z",
    },
  ]);
  if (profileInsert.error) throw profileInsert.error;
}, 60_000);

afterAll(async () => {
  await cleanupPlacementAsPrimaryAdmins();
  await cleanupClinicFixtures();
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id)));
});

describe("P4.9A launcher placement RLS and tenant isolation", () => {
  it("lets only the primary admin create the clinic role setting", async () => {
    const primary = await primaryA.from("assistant_launcher_settings").insert({
      clinic_id: clinicA,
      area: "dashboard",
      role: "doctor",
      enabled: false,
      updated_by: primaryAId,
    });
    expect(primary.error).toBeNull();

    const secondary = await secondaryA.from("assistant_launcher_settings").insert({
      clinic_id: clinicA,
      area: "appointments",
      role: "doctor",
      enabled: false,
      updated_by: secondaryAId,
    });
    expect(secondary.error).not.toBeNull();

    const doctor = await doctorA.from("assistant_launcher_settings").insert({
      clinic_id: clinicA,
      area: "patient",
      role: "doctor",
      enabled: false,
      updated_by: doctorAId,
    });
    expect(doctor.error).not.toBeNull();
  });

  it("prevents actor spoofing on a direct primary-admin role-setting write", async () => {
    const forged = await primaryA.from("assistant_launcher_settings").insert({
      clinic_id: clinicA,
      area: "reports",
      role: "admin",
      enabled: false,
      updated_by: secondaryAId,
    });
    expect(forged.error).not.toBeNull();
  });

  it("lets clinic users read their clinic placement rows but never another clinic", async () => {
    const other = await primaryB.from("assistant_launcher_settings").insert({
      clinic_id: clinicB,
      area: "dashboard",
      role: "admin",
      enabled: false,
      updated_by: primaryBId,
    });
    expect(other.error).toBeNull();

    const own = await doctorA
      .from("assistant_launcher_settings")
      .select("clinic_id, area, enabled")
      .order("area");
    expect(own.error).toBeNull();
    expect(own.data).toEqual([
      { clinic_id: clinicA, area: "dashboard", enabled: false },
    ]);

    const crossClinic = await doctorA
      .from("assistant_launcher_settings")
      .select("area")
      .eq("clinic_id", clinicB);
    expect(crossClinic.error).toBeNull();
    expect(crossClinic.data).toEqual([]);
  });

  it("lets only the primary admin create user overrides for same-clinic users", async () => {
    const primary = await primaryA
      .from("assistant_launcher_user_overrides")
      .insert({
        clinic_id: clinicA,
        user_id: doctorAId,
        area: "dashboard",
        enabled: true,
      });
    expect(primary.error).toBeNull();

    const secondary = await secondaryA
      .from("assistant_launcher_user_overrides")
      .insert({
        clinic_id: clinicA,
        user_id: secondaryAId,
        area: "dashboard",
        enabled: true,
      });
    expect(secondary.error).not.toBeNull();

    const crossTenantTarget = await primaryA
      .from("assistant_launcher_user_overrides")
      .insert({
        clinic_id: clinicA,
        user_id: primaryBId,
        area: "dashboard",
        enabled: true,
      });
    expect(crossTenantTarget.error).not.toBeNull();
  });

  it("keeps user overrides clinic-readable and cross-clinic invisible", async () => {
    const own = await doctorA
      .from("assistant_launcher_user_overrides")
      .select("clinic_id, user_id, area, enabled");
    expect(own.error).toBeNull();
    expect(own.data).toEqual([
      {
        clinic_id: clinicA,
        user_id: doctorAId,
        area: "dashboard",
        enabled: true,
      },
    ]);

    const other = await primaryB
      .from("assistant_launcher_user_overrides")
      .select("user_id")
      .eq("clinic_id", clinicA);
    expect(other.error).toBeNull();
    expect(other.data).toEqual([]);
  });

  it("records direct primary-admin placement changes in the existing clinic audit ledger", async () => {
    const result = await service
      .from("audit_logs")
      .select("actor_id, clinic_id, action, table_name, record_id, new_data")
      .eq("clinic_id", clinicA)
      .in("table_name", [
        "assistant_launcher_settings",
        "assistant_launcher_user_overrides",
      ])
      .order("created_at");
    expect(result.error).toBeNull();
    expect(result.data).toEqual([
      expect.objectContaining({
        actor_id: primaryAId,
        clinic_id: clinicA,
        action: "assistant_launcher_placement:insert",
        table_name: "assistant_launcher_settings",
        record_id: null,
        new_data: expect.objectContaining({ area: "dashboard", enabled: false }),
      }),
      expect.objectContaining({
        actor_id: primaryAId,
        clinic_id: clinicA,
        action: "assistant_launcher_placement:insert",
        table_name: "assistant_launcher_user_overrides",
        record_id: null,
        new_data: expect.objectContaining({ area: "dashboard", enabled: true }),
      }),
    ]);
  });

  it("attributes primary-admin role-setting insert, update, and delete audits with complete keys", async () => {
    const inserted = await primaryA.from("assistant_launcher_settings").insert({
      clinic_id: clinicA,
      area: "revenue",
      role: "admin",
      enabled: false,
      updated_by: primaryAId,
    });
    expect(inserted.error).toBeNull();

    const updated = await primaryA
      .from("assistant_launcher_settings")
      .update({ enabled: true, updated_by: primaryAId })
      .eq("clinic_id", clinicA)
      .eq("area", "revenue")
      .eq("role", "admin");
    expect(updated.error).toBeNull();

    const deleted = await primaryA
      .from("assistant_launcher_settings")
      .delete()
      .eq("clinic_id", clinicA)
      .eq("area", "revenue")
      .eq("role", "admin");
    expect(deleted.error).toBeNull();

    const audit = await service
      .from("audit_logs")
      .select("actor_id, action, old_data, new_data")
      .eq("clinic_id", clinicA)
      .eq("table_name", "assistant_launcher_settings")
      .order("created_at");
    expect(audit.error).toBeNull();
    const events = (audit.data ?? []).filter((event) =>
      (event.old_data as { area?: string } | null)?.area === "revenue"
      || (event.new_data as { area?: string } | null)?.area === "revenue",
    );
    expect(events).toEqual([
      {
        actor_id: primaryAId,
        action: "assistant_launcher_placement:insert",
        old_data: null,
        new_data: expect.objectContaining({
          clinic_id: clinicA,
          area: "revenue",
          role: "admin",
          enabled: false,
          updated_by: primaryAId,
        }),
      },
      {
        actor_id: primaryAId,
        action: "assistant_launcher_placement:update",
        old_data: expect.objectContaining({
          clinic_id: clinicA,
          area: "revenue",
          role: "admin",
          enabled: false,
        }),
        new_data: expect.objectContaining({
          clinic_id: clinicA,
          area: "revenue",
          role: "admin",
          enabled: true,
          updated_by: primaryAId,
        }),
      },
      {
        actor_id: primaryAId,
        action: "assistant_launcher_placement:delete",
        old_data: expect.objectContaining({
          clinic_id: clinicA,
          area: "revenue",
          role: "admin",
          enabled: true,
        }),
        new_data: null,
      },
    ]);
  });

  it("attributes primary-admin user-override insert, update, and delete audits with complete keys", async () => {
    const inserted = await primaryA.from("assistant_launcher_user_overrides").insert({
      clinic_id: clinicA,
      user_id: doctorAId,
      area: "reports",
      enabled: false,
    });
    expect(inserted.error).toBeNull();

    const updated = await primaryA
      .from("assistant_launcher_user_overrides")
      .update({ enabled: true })
      .eq("clinic_id", clinicA)
      .eq("user_id", doctorAId)
      .eq("area", "reports");
    expect(updated.error).toBeNull();

    const deleted = await primaryA
      .from("assistant_launcher_user_overrides")
      .delete()
      .eq("clinic_id", clinicA)
      .eq("user_id", doctorAId)
      .eq("area", "reports");
    expect(deleted.error).toBeNull();

    const audit = await service
      .from("audit_logs")
      .select("actor_id, action, old_data, new_data")
      .eq("clinic_id", clinicA)
      .eq("table_name", "assistant_launcher_user_overrides")
      .order("created_at");
    expect(audit.error).toBeNull();
    const events = (audit.data ?? []).filter((event) =>
      (event.old_data as { area?: string } | null)?.area === "reports"
      || (event.new_data as { area?: string } | null)?.area === "reports",
    );
    expect(events).toEqual([
      {
        actor_id: primaryAId,
        action: "assistant_launcher_placement:insert",
        old_data: null,
        new_data: expect.objectContaining({
          clinic_id: clinicA,
          user_id: doctorAId,
          area: "reports",
          enabled: false,
        }),
      },
      {
        actor_id: primaryAId,
        action: "assistant_launcher_placement:update",
        old_data: expect.objectContaining({
          clinic_id: clinicA,
          user_id: doctorAId,
          area: "reports",
          enabled: false,
        }),
        new_data: expect.objectContaining({
          clinic_id: clinicA,
          user_id: doctorAId,
          area: "reports",
          enabled: true,
        }),
      },
      {
        actor_id: primaryAId,
        action: "assistant_launcher_placement:delete",
        old_data: expect.objectContaining({
          clinic_id: clinicA,
          user_id: doctorAId,
          area: "reports",
          enabled: true,
        }),
        new_data: null,
      },
    ]);
  });

  it("rejects secondary-admin, cross-clinic, and raw service-role writes without audit rows", async () => {
    const before = await service
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicA)
      .in("table_name", [
        "assistant_launcher_settings",
        "assistant_launcher_user_overrides",
      ]);
    expect(before.error).toBeNull();

    const secondary = await secondaryA.from("assistant_launcher_settings").insert({
      clinic_id: clinicA,
      area: "staff",
      role: "admin",
      enabled: true,
      updated_by: secondaryAId,
    });
    expect(secondary.error).not.toBeNull();

    const crossClinic = await primaryB.from("assistant_launcher_user_overrides").insert({
      clinic_id: clinicA,
      user_id: doctorAId,
      area: "staff",
      enabled: true,
    });
    expect(crossClinic.error).not.toBeNull();

    const rawService = await service.from("assistant_launcher_settings").insert({
      clinic_id: clinicA,
      area: "staff",
      role: "doctor",
      enabled: true,
      updated_by: primaryAId,
    });
    expect(rawService.error).not.toBeNull();
    expect(rawService.error?.code).toBe("42501");

    const stored = await service
      .from("assistant_launcher_settings")
      .select("area")
      .eq("clinic_id", clinicA)
      .eq("area", "staff");
    expect(stored.data).toEqual([]);

    const after = await service
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicA)
      .in("table_name", [
        "assistant_launcher_settings",
        "assistant_launcher_user_overrides",
      ]);
    expect(after.error).toBeNull();
    expect(after.count).toBe(before.count);
  });

  it("prevents a secondary admin from updating or deleting persisted placement", async () => {
    const update = await secondaryA
      .from("assistant_launcher_settings")
      .update({ enabled: true, updated_by: secondaryAId })
      .eq("clinic_id", clinicA)
      .eq("area", "dashboard")
      .select();
    expect(update.data ?? []).toEqual([]);

    await secondaryA
      .from("assistant_launcher_user_overrides")
      .delete()
      .eq("clinic_id", clinicA)
      .eq("user_id", doctorAId);

    const stored = await service
      .from("assistant_launcher_user_overrides")
      .select("enabled")
      .eq("clinic_id", clinicA)
      .eq("user_id", doctorAId)
      .single();
    expect(stored.data?.enabled).toBe(true);
  });

  it("rejects unknown placement areas at the database boundary", async () => {
    const invalid = await primaryA.from("assistant_launcher_settings").insert({
      clinic_id: clinicA,
      area: "future-unregistered-area",
      role: "admin",
      enabled: true,
      updated_by: primaryAId,
    });
    expect(invalid.error).not.toBeNull();
    expect(invalid.error?.code).toBe("23514");
  });
});

describe("P4.9A plan entitlement seed", () => {
  it("keeps today's customization seed while allowing another plan row to carry it", async () => {
    const result = await service
      .from("plans")
      .select("id, slug, features")
      .in("slug", ["basic", "pro", "pro_ai"])
      .order("slug");
    expect(result.error).toBeNull();

    const featureByPlan = Object.fromEntries(
      (result.data ?? []).map((plan) => [
        plan.slug,
        (plan.features as Record<string, unknown>)["ai.assistant_customization"],
      ]),
    );
    expect(featureByPlan).toEqual({
      basic: false,
      pro: false,
      pro_ai: true,
    });

    const basic = (result.data ?? []).find((plan) => plan.slug === "basic");
    if (!basic) throw new Error("Basic plan fixture is missing");
    const originalFeatures = basic.features;
    const enabledFeatures = {
      ...(originalFeatures as Record<string, unknown>),
      ai_assistant: true,
      "ai.assistant_customization": true,
    };
    try {
      const enabled = await service
        .from("plans")
        .update({ features: enabledFeatures })
        .eq("slug", "basic")
        .select("features")
        .single();
      expect(enabled.error).toBeNull();
      expect(
        (enabled.data?.features as Record<string, unknown>)["ai.assistant_customization"],
      ).toBe(true);

      const subscription = await service.from("subscriptions").insert({
        clinic_id: clinicA,
        plan_id: basic.id,
        status: "active",
        current_period_end: null,
      });
      if (subscription.error) throw subscription.error;
      const terms = await service.from("ai_commercial_terms").insert({
        clinic_id: clinicA,
        change_reason: "pilot",
        updated_by: primaryAId,
        accepted_at: new Date().toISOString(),
      });
      if (terms.error) throw terms.error;

      const entitled = await service.rpc("effective_ai_feature", {
        p_clinic_id: clinicA,
        p_feature_key: "ai.assistant_customization",
      });
      expect(entitled.error).toBeNull();
      expect(entitled.data).toBe(true);

      const removedTerms = await service.from("ai_commercial_terms")
        .delete()
        .eq("clinic_id", clinicA);
      if (removedTerms.error) throw removedTerms.error;
      const unsigned = await service.rpc("effective_ai_feature", {
        p_clinic_id: clinicA,
        p_feature_key: "ai.assistant_customization",
      });
      expect(unsigned.error).toBeNull();
      expect(unsigned.data).toBe(false);
    } finally {
      await service.from("ai_commercial_terms").delete().eq("clinic_id", clinicA);
      await service.from("subscriptions").delete().eq("clinic_id", clinicA);
      const restored = await service
        .from("plans")
        .update({ features: originalFeatures })
        .eq("slug", "basic");
      if (restored.error) throw restored.error;
    }
  });
});
