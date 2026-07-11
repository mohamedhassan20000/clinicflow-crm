import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
const service = createClient<Database>(url, secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P1dOperator123";

function sessionClient() {
  return createClient<Database>(url, publishableKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: `p1d-${crypto.randomUUID()}`,
    },
  });
}

let operatorId: string;
let clinicAdminId: string;
let clinicId: string;
let patientId: string;
let subscriptionId: string;
let basicPlanId: string;
const operator = sessionClient();
const clinicAdmin = sessionClient();

async function createUser(label: string) {
  const result = await service.auth.admin.createUser({
    email: `p1d-${suffix}-${label}@example.com`,
    password,
    email_confirm: true,
  });
  if (result.error || !result.data.user) throw result.error;
  return result.data.user;
}

beforeAll(async () => {
  const [operatorUser, adminUser] = await Promise.all([createUser("operator"), createUser("admin")]);
  operatorId = operatorUser.id;
  clinicAdminId = adminUser.id;

  const grant = await service.from("platform_admins").insert({ user_id: operatorId });
  if (grant.error) throw grant.error;

  const plan = await service.from("plans").select("id").eq("slug", "basic").single();
  if (plan.error) throw plan.error;
  basicPlanId = plan.data.id;

  const clinic = await service
    .from("clinics")
    .insert({ name: `P1D Clinic ${suffix}`, onboarding_completed_at: new Date().toISOString() })
    .select("id")
    .single();
  if (clinic.error) throw clinic.error;
  clinicId = clinic.data.id;

  const profile = await service.from("profiles").insert({
    id: clinicAdminId,
    clinic_id: clinicId,
    full_name: "P1D Clinic Admin",
    role: "admin",
    must_change_password: false,
  });
  if (profile.error) throw profile.error;

  const subscription = await service
    .from("subscriptions")
    .insert({
      clinic_id: clinicId,
      plan_id: basicPlanId,
      status: "trialing",
      trial_ends_at: new Date(Date.now() - 86_400_000).toISOString(), // expired trial
    })
    .select("id")
    .single();
  if (subscription.error) throw subscription.error;
  subscriptionId = subscription.data.id;

  const patient = await service
    .from("patients")
    .insert({
      clinic_id: clinicId,
      full_name: "P1D PHI Patient",
      phone: `5${suffix.slice(0, 7)}`,
      date_of_birth: "1990-01-01",
      email: `p1d-${suffix}-patient@example.com`,
      national_id: `${suffix}P`,
      file_number: `${suffix}-P`,
      created_by: clinicAdminId,
    })
    .select("id")
    .single();
  if (patient.error) throw patient.error;
  patientId = patient.data.id;

  await Promise.all([
    operator.auth.signInWithPassword({ email: operatorUser.email!, password }),
    clinicAdmin.auth.signInWithPassword({ email: adminUser.email!, password }),
  ]);
});

afterAll(async () => {
  await service.from("platform_settings").update({ registration_mode: "invite_only" }).eq("id", true);
  await service.from("coupons").delete().like("code", `P1D${suffix.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}%`);
  await service.from("clinic_feature_overrides").delete().eq("clinic_id", clinicId);
  await service.from("subscriptions").delete().eq("clinic_id", clinicId);
  await service.from("patients").delete().eq("id", patientId);
  await service.from("profiles").delete().eq("id", clinicAdminId);
  await service.from("clinics").delete().eq("id", clinicId);
  await service.from("platform_admins").delete().eq("user_id", operatorId);
  await Promise.all([operatorId, clinicAdminId].map((id) => service.auth.admin.deleteUser(id)));
});

describe("P1D operator trust boundary against Postgres", () => {
  it("denies the operator every PHI surface while the owning clinic admin reads it", async () => {
    const [patients, notes, clinics] = await Promise.all([
      operator.from("patients").select("id"),
      operator.from("medical_notes").select("id"),
      operator.from("clinics").select("id"),
    ]);
    expect(patients.data).toEqual([]);
    expect(notes.data).toEqual([]);
    expect(clinics.data).toEqual([]); // even tenant metadata needs the reviewed helper

    const positiveControl = await clinicAdmin.from("patients").select("full_name").eq("id", patientId);
    expect(positiveControl.data).toEqual([{ full_name: "P1D PHI Patient" }]);
  });

  it("lets the operator manage SaaS rows that clinic members cannot touch", async () => {
    const grant = await operator
      .from("subscriptions")
      .update({ status: "active", trial_ends_at: null, current_period_end: null })
      .eq("id", subscriptionId)
      .select("status")
      .single();
    expect(grant.error).toBeNull();
    expect(grant.data?.status).toBe("active");

    const override = await operator
      .from("clinic_feature_overrides")
      .upsert({ clinic_id: clinicId, feature_key: "ai_assistant", enabled: true }, { onConflict: "clinic_id,feature_key" })
      .select("enabled")
      .single();
    expect(override.error).toBeNull();

    const code = `P1D${suffix.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}OFF`;
    const coupon = await operator.from("coupons").insert({ code, kind: "percent_discount", percent: 20 });
    expect(coupon.error).toBeNull();

    // A clinic admin must not be able to self-serve any of these.
    const selfGrant = await clinicAdmin
      .from("subscriptions")
      .update({ current_period_end: null })
      .eq("id", subscriptionId)
      .select("id");
    expect(selfGrant.data).toEqual([]);
    const selfOverride = await clinicAdmin
      .from("clinic_feature_overrides")
      .upsert({ clinic_id: clinicId, feature_key: "sms", enabled: true });
    expect(selfOverride.error).not.toBeNull();
  });

  it("applies registration-mode changes to the public flow immediately", async () => {
    const flipped = await operator
      .from("platform_settings")
      .update({ registration_mode: "open", updated_at: new Date().toISOString() })
      .eq("id", true)
      .select("registration_mode")
      .single();
    expect(flipped.error).toBeNull();

    const anon = sessionClient();
    const status = await anon.rpc("get_public_registration_status");
    expect(status.data?.[0]?.registration_mode).toBe("open");

    // Non-operators cannot flip it back (silent zero-row RLS denial).
    const denied = await clinicAdmin
      .from("platform_settings")
      .update({ registration_mode: "invite_only" })
      .eq("id", true)
      .select("registration_mode");
    expect(denied.data).toEqual([]);
  });
});
