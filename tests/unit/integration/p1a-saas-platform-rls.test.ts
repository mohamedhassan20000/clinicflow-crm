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

const suffix = `p1a-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P1aTest12345";
const clinicA = "91000000-0000-4000-8000-000000000001";
const clinicB = "91000000-0000-4000-8000-000000000002";
const subscriptionA = "92000000-0000-4000-8000-000000000001";
const subscriptionB = "92000000-0000-4000-8000-000000000002";
const couponA = "93000000-0000-4000-8000-000000000001";
const couponB = "93000000-0000-4000-8000-000000000002";
const invitation = "94000000-0000-4000-8000-000000000001";
const patientA = "95000000-0000-4000-8000-000000000001";
const appointmentA = "96000000-0000-4000-8000-000000000001";
const noteA = "97000000-0000-4000-8000-000000000001";

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const userIds: string[] = [];
let adminA: Client;
let adminB: Client;
let operator: Client;
let planId: string;

function client() {
  return createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      storageKey: `p1a-${Math.random().toString(36).slice(2)}`,
    },
  });
}

async function createUser(label: string) {
  const email = `${suffix}-${label}@example.com`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(error?.message ?? `create ${label}`);
  userIds.push(data.user.id);
  const signedIn = client();
  const login = await signedIn.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  return { id: data.user.id, client: signedIn };
}

async function cleanup() {
  await service.from("platform_admins").delete().in("user_id", userIds);
  await service.from("coupon_redemptions").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("coupons").delete().in("id", [couponA, couponB]);
  await service.from("clinic_feature_overrides").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("usage_counters").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("subscriptions").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("clinic_invitations").delete().eq("id", invitation);
  await service.from("medical_notes").delete().eq("id", noteA);
  await service.from("appointments").delete().eq("id", appointmentA);
  await service.from("patients").delete().eq("id", patientA);
  await service.from("profiles").delete().in("id", userIds);
  await service.from("clinics").delete().in("id", [clinicA, clinicB]);
}

beforeAll(async () => {
  const [a, b, op, doctor] = await Promise.all([
    createUser("admin-a"),
    createUser("admin-b"),
    createUser("operator"),
    createUser("doctor-a"),
  ]);
  adminA = a.client;
  adminB = b.client;
  operator = op.client;

  await cleanup();
  const plans = await service.from("plans").select("id").eq("slug", "basic").single();
  if (plans.error) throw plans.error;
  planId = plans.data.id;

  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `P1A Clinic A ${suffix}` },
    { id: clinicB, name: `P1A Clinic B ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;
  const profiles = await service.from("profiles").insert([
    { id: a.id, clinic_id: clinicA, full_name: "Admin A", role: "admin" },
    { id: b.id, clinic_id: clinicB, full_name: "Admin B", role: "admin" },
    { id: doctor.id, clinic_id: clinicA, full_name: "Doctor A", role: "doctor" },
  ]);
  if (profiles.error) throw profiles.error;
  const platformAdmin = await service.from("platform_admins").insert({ user_id: op.id });
  if (platformAdmin.error) throw platformAdmin.error;
  const invitationResult = await service.from("clinic_invitations").insert({
    id: invitation,
    clinic_name: "Invited Clinic",
    owner_name: "Invited Owner",
    phone: "+96550000000",
    email: `${suffix}-invited@example.com`,
  });
  if (invitationResult.error) throw invitationResult.error;
  const subscriptions = await service.from("subscriptions").insert([
    { id: subscriptionA, clinic_id: clinicA, plan_id: planId },
    { id: subscriptionB, clinic_id: clinicB, plan_id: planId },
  ]);
  if (subscriptions.error) throw subscriptions.error;
  const coupons = await service.from("coupons").insert([
    { id: couponA, code: `A${Date.now()}`, kind: "lifetime_free", clinic_id: clinicA },
    { id: couponB, code: `B${Date.now()}`, kind: "lifetime_free", clinic_id: clinicB },
  ]);
  if (coupons.error) throw coupons.error;
  const overrides = await service.from("clinic_feature_overrides").insert([
    { clinic_id: clinicA, feature_key: "ai_assistant", enabled: true },
    { clinic_id: clinicB, feature_key: "ai_assistant", enabled: false },
  ]);
  if (overrides.error) throw overrides.error;
  const patient = await service.from("patients").insert({
    id: patientA,
    clinic_id: clinicA,
    full_name: "Private Patient",
    date_of_birth: "1990-01-01",
    phone: "+96551111111",
    email: `${suffix}-patient@example.com`,
    national_id: `${suffix}-national-id`,
    file_number: `${suffix}-file`,
    assigned_doctor_id: doctor.id,
    created_by: a.id,
  });
  if (patient.error) throw patient.error;
  const appointment = await service.from("appointments").insert({
    id: appointmentA,
    clinic_id: clinicA,
    patient_id: patientA,
    doctor_id: doctor.id,
    scheduled_at: "2099-08-01T09:00:00.000Z",
    duration_minutes: 30,
    created_by: a.id,
  });
  if (appointment.error) throw appointment.error;
  const note = await service.from("medical_notes").insert({
    id: noteA,
    patient_id: patientA,
    doctor_id: doctor.id,
    created_by: doctor.id,
    note: "Highly confidential medical note",
  });
  if (note.error) throw note.error;
}, 30_000);

afterAll(async () => {
  await cleanup();
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id)));
});

describe("P1A SaaS platform RLS", () => {
  it("lets each clinic read only its own SaaS rows", async () => {
    const [subscriptions, coupons, overrides] = await Promise.all([
      adminA.from("subscriptions").select("clinic_id").in("clinic_id", [clinicA, clinicB]),
      adminA.from("coupons").select("clinic_id").in("id", [couponA, couponB]),
      adminA.from("clinic_feature_overrides").select("clinic_id").in("clinic_id", [clinicA, clinicB]),
    ]);

    expect(subscriptions.error).toBeNull();
    expect(subscriptions.data).toEqual([{ clinic_id: clinicA }]);
    expect(coupons.data).toEqual([{ clinic_id: clinicA }]);
    expect(overrides.data).toEqual([{ clinic_id: clinicA }]);
  });

  it("denies clinic users platform settings, invitations, and all direct writes", async () => {
    const [settings, invitations, couponWrite, subscriptionWrite] = await Promise.all([
      adminA.from("platform_settings").select("id"),
      adminA.from("clinic_invitations").select("id"),
      adminA.from("coupons").update({ is_active: false }).eq("id", couponA),
      adminA.from("subscriptions").update({ status: "active" }).eq("id", subscriptionA),
    ]);

    expect(settings.data).toEqual([]);
    expect(invitations.data).toEqual([]);
    expect(couponWrite.error).toBeNull();
    expect(subscriptionWrite.error).toBeNull();
    const persisted = await service.from("coupons").select("is_active").eq("id", couponA).single();
    expect(persisted.data?.is_active).toBe(true);
  });

  it("prevents clinic users from granting themselves platform-admin access", async () => {
    const { data: authData } = await adminA.auth.getUser();
    const attemptedGrant = await adminA.from("platform_admins").insert({
      user_id: authData.user!.id,
    });
    const persisted = await service
      .from("platform_admins")
      .select("user_id")
      .eq("user_id", authData.user!.id);

    expect(attemptedGrant.error).not.toBeNull();
    expect(persisted.data).toEqual([]);
  });

  it("allows platform admins to manage SaaS tables without exposing clinical rows", async () => {
    const settings = await operator.from("platform_settings").select("registration_mode").single();
    const invitations = await operator.from("clinic_invitations").select("id").eq("id", invitation);
    const update = await operator.from("platform_settings").update({ weekly_invite_limit: 21 }).eq("id", true);
    const [patients, appointments, notes, ownerPatients, ownerAppointments, ownerNotes] =
      await Promise.all([
        operator.from("patients").select("id").eq("id", patientA),
        operator.from("appointments").select("id").eq("id", appointmentA),
        operator.from("medical_notes").select("id").eq("id", noteA),
        adminA.from("patients").select("id").eq("id", patientA),
        adminA.from("appointments").select("id").eq("id", appointmentA),
        adminA.from("medical_notes").select("id").eq("id", noteA),
      ]);

    expect(settings.data?.registration_mode).toBe("invite_only");
    expect(invitations.data).toEqual([{ id: invitation }]);
    expect(update.error).toBeNull();
    expect(patients.data).toEqual([]);
    expect(appointments.data).toEqual([]);
    expect(notes.data).toEqual([]);
    expect(ownerPatients.data).toEqual([{ id: patientA }]);
    expect(ownerAppointments.data).toEqual([{ id: appointmentA }]);
    expect(ownerNotes.data).toEqual([{ id: noteA }]);
  });

  it("increments usage atomically with a server-resolved snapshot", async () => {
    const increments = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.rpc("increment_usage", {
          p_clinic_id: clinicA,
          p_metric: "ai_messages",
          p_amount: 1,
        }),
      ),
    );
    expect(increments.every(({ error }) => error === null)).toBe(true);

    const counter = await adminA
      .from("usage_counters")
      .select("used, limit_snapshot")
      .eq("clinic_id", clinicA)
      .eq("metric", "ai_messages")
      .single();
    const deniedOwn = await adminA.rpc("increment_usage", {
      p_clinic_id: clinicA,
      p_metric: "ai_messages",
      p_amount: 1,
    });
    const deniedCrossClinic = await adminA.rpc("increment_usage", {
      p_clinic_id: clinicB,
      p_metric: "ai_messages",
      p_amount: 1,
    });

    expect(counter.data).toEqual({ used: 20, limit_snapshot: 0 });
    expect(deniedOwn.error).not.toBeNull();
    expect(deniedCrossClinic.error).not.toBeNull();
  });

  it("rejects tenant attempts to supply or poison a usage snapshot", async () => {
    const looseAdmin = adminA as unknown as {
      rpc: (name: string, args: Record<string, unknown>) => Promise<{ error: unknown }>;
    };
    const poisoned = await looseAdmin.rpc("increment_usage", {
      p_clinic_id: clinicA,
      p_metric: "sms_messages",
      p_amount: 1,
      p_limit_snapshot: 2_147_483_647,
    });
    const stored = await service
      .from("usage_counters")
      .select("id")
      .eq("clinic_id", clinicA)
      .eq("metric", "sms_messages");

    expect(poisoned.error).not.toBeNull();
    expect(stored.data).toEqual([]);
  });

  it("enforces coupon value constraints in the live database", async () => {
    const invalid = await service.from("coupons").insert({
      code: `NULLPCT${Date.now()}`,
      kind: "percent_discount",
      percent: null,
    });

    expect(invalid.error).not.toBeNull();
  });

  it("enforces the platform settings singleton through RLS and constraints", async () => {
    const duplicate = await operator.from("platform_settings").insert({ id: true });
    const falseRow = await operator.from("platform_settings").insert({ id: false });
    const rows = await service.from("platform_settings").select("id");

    expect(duplicate.error).not.toBeNull();
    expect(falseRow.error).not.toBeNull();
    expect(rows.data).toEqual([{ id: true }]);
  });

  it("does not expose parameterized platform-admin membership lookup", async () => {
    const ownStatus = await adminA.rpc("is_platform_admin");
    const operatorStatus = await operator.rpc("is_platform_admin");
    const looseAdmin = adminA as unknown as {
      rpc: (name: string, args: Record<string, unknown>) => Promise<{ error: unknown }>;
    };
    const arbitraryLookup = await looseAdmin.rpc("is_platform_admin", {
      p_user_id: userIds[2],
    });

    expect(ownStatus.data).toBe(false);
    expect(operatorStatus.data).toBe(true);
    expect(arbitraryLookup.error).not.toBeNull();
  });

  it("keeps clinic B isolated from clinic A usage", async () => {
    const result = await adminB.from("usage_counters").select("clinic_id, used");
    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
  });
});
