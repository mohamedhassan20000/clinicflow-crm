import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { readLocalPolicyQual } from "./helpers/local-policy";

/**
 * `user_ai_permissions` RLS, driven over the real PostgREST boundary with real
 * user tokens (P4.6 phase review #2, M1 and L3).
 *
 * This exists because review #2 reproduced a bypass in two HTTP calls: the
 * server actions required the *primary* clinic admin, RLS required only
 * `role = 'admin'`, and a non-primary admin using their own session token could
 * `POST /rest/v1/user_ai_permissions` directly and write a financial grant that
 * the `…150000` database guard then honored on every financial RPC.
 *
 * The application is deliberately absent from every test below. That is the
 * whole point — the previous cycle's tests covered the server action, which is
 * the layer that was already correct.
 */

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
type Client = SupabaseClient<Database>;

const suffix = `p46perm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P46PermTest12345";
const clinic = randomUUID();
const otherClinic = randomUUID();

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const userIds: string[] = [];

function anonClient(): Client {
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
  if (created.error || !created.data.user) throw created.error ?? new Error("no user");
  userIds.push(created.data.user.id);
  const signedIn = anonClient();
  const auth = await signedIn.auth.signInWithPassword({ email, password });
  if (auth.error) throw auth.error;
  return { id: created.data.user.id, client: signedIn };
}

let primaryAdmin: Client;
let secondAdmin: Client;
let manager: Client;
let doctor: Client;
let primaryAdminId = "";
let secondAdminId = "";
let managerId = "";
let doctorId = "";
let otherManagerId = "";

const CLINICS = [clinic, otherClinic];

async function cleanup() {
  await service.from("user_ai_permissions").delete().in("clinic_id", CLINICS);
  await service.from("ai_commercial_terms").delete().in("clinic_id", CLINICS);
  await service.from("subscriptions").delete().in("clinic_id", CLINICS);
  await service.from("profiles").delete().in("clinic_id", CLINICS);
  await service.from("clinics").delete().in("id", CLINICS);
}

beforeAll(async () => {
  const [pa, sa, m, d, om] = await Promise.all([
    createUser("primary-admin"),
    createUser("second-admin"),
    createUser("manager"),
    createUser("doctor"),
    createUser("other-manager"),
  ]);
  primaryAdmin = pa.client;
  secondAdmin = sa.client;
  manager = m.client;
  doctor = d.client;
  primaryAdminId = pa.id;
  secondAdminId = sa.id;
  managerId = m.id;
  doctorId = d.id;
  otherManagerId = om.id;

  await cleanup();

  const clinics = await service.from("clinics").insert([
    { id: clinic, name: `P46Perm Clinic ${suffix}` },
    { id: otherClinic, name: `P46Perm Other ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;

  const plans = await service.from("plans").select("id, slug").eq("slug", "pro_ai");
  if (plans.error) throw plans.error;
  const subscriptions = await service.from("subscriptions").insert([
    { clinic_id: clinic, plan_id: plans.data[0]!.id, status: "active" as const },
    { clinic_id: otherClinic, plan_id: plans.data[0]!.id, status: "active" as const },
  ]);
  if (subscriptions.error) throw subscriptions.error;

  // The primary admin is the *earliest created* active admin — the same
  // resolution assert_primary_ai_provider_admin and lib/primary-admin.ts use.
  // The explicit created_at values make which one that is unambiguous rather
  // than dependent on insert timing.
  const profiles = await service.from("profiles").insert([
    {
      id: pa.id,
      clinic_id: clinic,
      full_name: "P46Perm Primary Admin",
      role: "admin",
      created_at: "2020-01-01T00:00:00Z",
    },
    {
      id: sa.id,
      clinic_id: clinic,
      full_name: "P46Perm Second Admin",
      role: "admin",
      created_at: "2024-01-01T00:00:00Z",
    },
    // created_at is set on every row: PostgREST builds one INSERT from the
    // union of keys, so omitting it here would send an explicit NULL.
    {
      id: m.id,
      clinic_id: clinic,
      full_name: "P46Perm Manager",
      role: "manager",
      created_at: "2024-06-01T00:00:00Z",
    },
    {
      id: d.id,
      clinic_id: clinic,
      full_name: "P46Perm Doctor",
      role: "doctor",
      created_at: "2024-06-01T00:00:00Z",
    },
    {
      id: om.id,
      clinic_id: otherClinic,
      full_name: "P46Perm Other Manager",
      role: "manager",
      created_at: "2024-06-01T00:00:00Z",
    },
  ]);
  if (profiles.error) throw profiles.error;
  const terms = await service.from("ai_commercial_terms").insert([
    { clinic_id: clinic, change_reason: "pilot", updated_by: pa.id, accepted_at: new Date().toISOString() },
    { clinic_id: otherClinic, change_reason: "pilot", updated_by: om.id, accepted_at: new Date().toISOString() },
  ]);
  if (terms.error) throw terms.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id)));
});

const GRANT = { permission_key: "ai.financial_insights", granted: true };

describe("M1 — only the primary admin may write a grant, enforced in RLS", () => {
  it("refuses a non-primary admin inserting a grant over PostgREST", async () => {
    // The exact two-call reproduction from review #2, now expected to fail at
    // call one.
    const result = await secondAdmin
      .from("user_ai_permissions")
      .insert({ user_id: managerId, clinic_id: clinic, ...GRANT });

    expect(result.error).not.toBeNull();
    expect(result.error?.code).toBe("42501");

    const stored = await service
      .from("user_ai_permissions")
      .select("user_id")
      .eq("clinic_id", clinic);
    expect(stored.data ?? []).toEqual([]);
  });

  it("lets the primary admin insert a grant", async () => {
    const result = await primaryAdmin
      .from("user_ai_permissions")
      .insert({ user_id: managerId, clinic_id: clinic, ...GRANT });
    expect(result.error).toBeNull();
  });

  it("refuses a non-primary admin updating an existing grant", async () => {
    const result = await secondAdmin
      .from("user_ai_permissions")
      .update({ granted: false })
      .eq("clinic_id", clinic)
      .eq("user_id", managerId)
      .select();

    // RLS `using` filters the row out entirely, so the update matches nothing
    // rather than erroring — the row must be unchanged either way.
    expect(result.data ?? []).toEqual([]);
    const stored = await service
      .from("user_ai_permissions")
      .select("granted")
      .eq("clinic_id", clinic)
      .eq("user_id", managerId)
      .single();
    expect(stored.data?.granted).toBe(true);
  });

  it("refuses a non-primary admin deleting a grant", async () => {
    await secondAdmin
      .from("user_ai_permissions")
      .delete()
      .eq("clinic_id", clinic)
      .eq("user_id", managerId);

    const stored = await service
      .from("user_ai_permissions")
      .select("user_id")
      .eq("clinic_id", clinic)
      .eq("user_id", managerId);
    expect(stored.data?.length).toBe(1);
  });

  it("still refuses a manager self-granting", async () => {
    const result = await manager
      .from("user_ai_permissions")
      .insert({ user_id: managerId, clinic_id: clinic, ...GRANT });
    expect(result.error).not.toBeNull();
  });

  it("keeps the self-read policy working for the granted user", async () => {
    const result = await manager
      .from("user_ai_permissions")
      .select("granted")
      .eq("user_id", managerId);
    expect(result.error).toBeNull();
    expect(result.data?.[0]?.granted).toBe(true);
  });

  it("M1 — keeps self-read scoped to the authenticated clinic in the policy itself", () => {
    const policy = readLocalPolicyQual(
      "user_ai_permissions",
      "Users can read own ai permissions",
    ).replace(/\s+/g, " ").toLowerCase();

    expect(policy, "M1 self-read policy must identify the authenticated user")
      .toContain("user_id = auth.uid()");
    expect(policy, "M1 self-read policy must independently enforce tenant scope")
      .toContain("clinic_id = auth_clinic_id()");
  });

  it("does not let a primary admin reach into another clinic", async () => {
    const result = await primaryAdmin
      .from("user_ai_permissions")
      .insert({ user_id: otherManagerId, clinic_id: otherClinic, ...GRANT });
    expect(result.error).not.toBeNull();
  });

  it("preserves the service-role workflow the server action depends on", async () => {
    // `setStaffAiPermission` writes through createClinicScopedAdminClient after
    // checking isPrimaryClinicAdmin itself. Service role bypasses RLS, so the
    // tightened policy must not have broken the legitimate path.
    const result = await service.from("user_ai_permissions").upsert(
      {
        user_id: managerId,
        clinic_id: clinic,
        permission_key: "ai.financial_insights",
        granted: false,
        updated_by: primaryAdminId,
      },
      { onConflict: "clinic_id,user_id,permission_key" },
    );
    expect(result.error).toBeNull();

    // Put it back for the L3 tests below.
    await service
      .from("user_ai_permissions")
      .update({ granted: true })
      .eq("clinic_id", clinic)
      .eq("user_id", managerId);
  });
});

describe("L3 — a grant row cannot be written for a role that can never use it", () => {
  it("refuses a grant for a doctor even from the primary admin", async () => {
    const result = await primaryAdmin
      .from("user_ai_permissions")
      .insert({ user_id: doctorId, clinic_id: clinic, ...GRANT });

    expect(result.error).not.toBeNull();
    expect(result.error?.code).toBe("42501");
  });

  it("refuses a grant for another admin, who holds the permission implicitly", async () => {
    // An admin row would be meaningless rather than merely redundant:
    // hasAiUserPermission short-circuits on the role, so the row could never be
    // the thing granting or revoking anything.
    const result = await primaryAdmin
      .from("user_ai_permissions")
      .insert({ user_id: secondAdminId, clinic_id: clinic, ...GRANT });
    expect(result.error).not.toBeNull();
  });

  it("refuses a doctor writing a grant for themselves", async () => {
    const result = await doctor
      .from("user_ai_permissions")
      .insert({ user_id: doctorId, clinic_id: clinic, ...GRANT });
    expect(result.error).not.toBeNull();
  });

  it("still allows the one grantable role", async () => {
    const stored = await service
      .from("user_ai_permissions")
      .select("user_id, granted")
      .eq("clinic_id", clinic);
    expect(stored.data).toEqual([{ user_id: managerId, granted: true }]);
  });
});

describe("M1 — the write bypass no longer reaches the analytics guard", () => {
  it("does not let a non-primary admin's attempted grant unlock a revenue read", async () => {
    // Second half of review #2's reproduction: the manager's RPC succeeded
    // *because* the unauthorized row had been written. Revoke, confirm denial,
    // then confirm the non-primary admin cannot re-enable it.
    await service
      .from("user_ai_permissions")
      .update({ granted: false })
      .eq("clinic_id", clinic)
      .eq("user_id", managerId);

    const range = {
      p_start: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      p_end: new Date().toISOString(),
    };
    const denied = await manager.rpc("ai_get_revenue_summary", range);
    expect(denied.error).not.toBeNull();

    const bypass = await secondAdmin
      .from("user_ai_permissions")
      .update({ granted: true })
      .eq("clinic_id", clinic)
      .eq("user_id", managerId)
      .select();
    expect(bypass.data ?? []).toEqual([]);

    const stillDenied = await manager.rpc("ai_get_revenue_summary", range);
    expect(stillDenied.error).not.toBeNull();
    expect(stillDenied.error?.message).toContain("Financial AI permission not granted");
  });
});
