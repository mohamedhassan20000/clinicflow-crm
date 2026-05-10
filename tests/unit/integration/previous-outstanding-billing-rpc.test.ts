import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

const LOCAL_SUPABASE_URL =
  process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
const LOCAL_SUPABASE_PUBLISHABLE_KEY =
  process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY ??
  "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
const LOCAL_SUPABASE_SECRET_KEY =
  process.env.LOCAL_SUPABASE_SECRET_KEY ??
  "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";

type DbClient = SupabaseClient<Database>;

const ids = {
  clinic: "91000000-0000-4000-8000-000000000001",
  dept: "91000000-0000-4000-8000-000000000002",
  patient: "91000000-0000-4000-8000-000000000003",
  oldAppointment1: "91000000-0000-4000-8000-000000000004",
  oldAppointment2: "91000000-0000-4000-8000-000000000005",
  currentAppointment: "91000000-0000-4000-8000-000000000006",
} as const;

const suffix = `phase11-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "Phase11Test12345";
const emails = {
  admin: `${suffix}-admin@example.com`,
  doctor: `${suffix}-doctor@example.com`,
};
const userIds = {
  admin: "",
  doctor: "",
};

const service = createClient<Database>(
  LOCAL_SUPABASE_URL,
  LOCAL_SUPABASE_SECRET_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);

let adminClient: DbClient;

function client() {
  return createClient<Database>(
    LOCAL_SUPABASE_URL,
    LOCAL_SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        storageKey: `clinic-crm-phase11-${Math.random().toString(36).slice(2)}`,
      },
    },
  );
}

async function createAuthUsers() {
  for (const key of Object.keys(emails) as (keyof typeof emails)[]) {
    const { data, error } = await service.auth.admin.createUser({
      email: emails[key],
      password,
      email_confirm: true,
    });
    if (error || !data.user) {
      throw new Error(error?.message ?? `Failed to create ${key}`);
    }
    userIds[key] = data.user.id;
  }
}

async function signInAdmin() {
  adminClient = client();
  const { error } = await adminClient.auth.signInWithPassword({
    email: emails.admin,
    password,
  });
  if (error) throw new Error(error.message);
}

async function cleanupData() {
  await service.from("outstanding_settlements").delete().eq("clinic_id", ids.clinic);
  await service.from("appointment_services").delete().eq("clinic_id", ids.clinic);
  await service
    .from("appointments")
    .delete()
    .in("id", [
      ids.oldAppointment1,
      ids.oldAppointment2,
      ids.currentAppointment,
    ]);
  await service.from("patients").delete().eq("id", ids.patient);
  await service.from("profiles").delete().in("id", [
    userIds.admin,
    userIds.doctor,
  ]);
  await service.from("departments").delete().eq("id", ids.dept);
  await service.from("clinics").delete().eq("id", ids.clinic);
}

async function seedBaseData({
  firstOutstanding = 30,
  secondOutstanding = 50,
  currentOutstanding = null,
}: {
  firstOutstanding?: number;
  secondOutstanding?: number;
  currentOutstanding?: number | null;
} = {}) {
  await service.from("clinics").insert({
    id: ids.clinic,
    name: `Phase 11 Clinic ${suffix}`,
  });
  await service.from("departments").insert({
    id: ids.dept,
    clinic_id: ids.clinic,
    name: `Phase 11 Dept ${suffix}`,
  });
  await service.from("profiles").insert([
    {
      id: userIds.admin,
      clinic_id: ids.clinic,
      full_name: "Phase 11 Admin",
      role: "admin",
    },
    {
      id: userIds.doctor,
      clinic_id: ids.clinic,
      department_id: ids.dept,
      full_name: "Phase 11 Doctor",
      role: "doctor",
    },
  ]);
  await service.from("patients").insert({
    id: ids.patient,
    clinic_id: ids.clinic,
    full_name: "Phase 11 Patient",
    date_of_birth: "1990-01-01",
    phone: "05551231234",
    email: `${suffix}-patient@example.com`,
    national_id: `${suffix}P`,
    file_number: `${suffix}-P`,
    department_id: ids.dept,
    assigned_doctor_id: userIds.doctor,
    created_by: userIds.admin,
  });
  await service.from("appointments").insert([
    {
      id: ids.oldAppointment1,
      clinic_id: ids.clinic,
      patient_id: ids.patient,
      doctor_id: userIds.doctor,
      department_id: ids.dept,
      scheduled_at: "2099-01-01T09:00:00.000Z",
      duration_minutes: 30,
      status: "completed",
      total_amount: 100,
      paid_amount: 70,
      outstanding_amount: firstOutstanding,
      payment_method: "cash",
      paid_at: "2099-01-01T10:00:00.000Z",
      created_by: userIds.admin,
    },
    {
      id: ids.oldAppointment2,
      clinic_id: ids.clinic,
      patient_id: ids.patient,
      doctor_id: userIds.doctor,
      department_id: ids.dept,
      scheduled_at: "2099-01-02T09:00:00.000Z",
      duration_minutes: 30,
      status: "completed",
      total_amount: 100,
      paid_amount: 50,
      outstanding_amount: secondOutstanding,
      payment_method: "cash",
      paid_at: "2099-01-02T10:00:00.000Z",
      created_by: userIds.admin,
    },
    {
      id: ids.currentAppointment,
      clinic_id: ids.clinic,
      patient_id: ids.patient,
      doctor_id: userIds.doctor,
      department_id: ids.dept,
      scheduled_at: "2099-01-03T09:00:00.000Z",
      duration_minutes: 30,
      status: "confirmed",
      outstanding_amount: currentOutstanding,
      created_by: userIds.admin,
    },
  ]);
}

async function completeWithPrevious(previousAmount: number) {
  return adminClient.rpc("complete_appointment_billing_with_previous_settlement", {
    p_appointment_id: ids.currentAppointment,
    p_line_items: [{ name: "Consultation", price: 100, quantity: 1 }],
    p_paid_amount: 100,
    p_payment_method: "cash",
    p_previous_settlement_amount: previousAmount,
    p_previous_payment_method: previousAmount > 0 ? "cash" : undefined,
    p_previous_note: previousAmount > 0 ? "Paid with current invoice" : undefined,
  });
}

beforeAll(async () => {
  const { error } = await service.from("clinics").select("id").limit(1);
  if (error) {
    throw new Error(
      `Local Supabase is unavailable or not migrated: ${error.message}`,
    );
  }
  await createAuthUsers();
  await signInAdmin();
}, 30_000);

beforeEach(async () => {
  await cleanupData();
  await seedBaseData();
});

afterAll(async () => {
  await cleanupData();
  await Promise.all(
    Object.values(userIds)
      .filter(Boolean)
      .map((id) => service.auth.admin.deleteUser(id)),
  );
});

describe("complete_appointment_billing_with_previous_settlement", () => {
  it("preserves normal completion behavior when previous settlement is zero", async () => {
    const { data, error } = await completeWithPrevious(0);

    expect(error).toBeNull();
    expect(data?.[0]).toMatchObject({
      current_total: 100,
      current_collected: 100,
      current_outstanding: 0,
      previous_outstanding_before: 80,
      previous_settled_now: 0,
      previous_outstanding_after: 80,
      affected_prior_appointment_ids: [],
    });

    const [{ data: current }, { data: settlements }] = await Promise.all([
      service
        .from("appointments")
        .select("status, total_amount, paid_amount, outstanding_amount")
        .eq("id", ids.currentAppointment)
        .single(),
      service
        .from("outstanding_settlements")
        .select("id")
        .eq("source_appointment_id", ids.currentAppointment),
    ]);

    expect(current).toMatchObject({
      status: "completed",
      total_amount: 100,
      paid_amount: 100,
      outstanding_amount: 0,
    });
    expect(settlements).toEqual([]);
  });

  it("rejects negative previous settlement without partial changes", async () => {
    const { error } = await completeWithPrevious(-1);

    expect(error?.message).toContain(
      "Previous settlement amount cannot be negative",
    );

    const [{ data: current }, { data: settlements }] = await Promise.all([
      service
        .from("appointments")
        .select("status")
        .eq("id", ids.currentAppointment)
        .single(),
      service
        .from("outstanding_settlements")
        .select("id")
        .eq("source_appointment_id", ids.currentAppointment),
    ]);
    expect(current?.status).toBe("confirmed");
    expect(settlements).toEqual([]);
  });

  it("rejects settlement above prior outstanding and excludes current appointment debt", async () => {
    await cleanupData();
    await seedBaseData({
      firstOutstanding: 30,
      secondOutstanding: 20,
      currentOutstanding: 100,
    });

    const { error } = await completeWithPrevious(75);

    expect(error?.message).toContain(
      "Previous settlement exceeds previous outstanding balance",
    );

    const { data: current } = await service
      .from("appointments")
      .select("status, outstanding_amount")
      .eq("id", ids.currentAppointment)
      .single();
    expect(current).toMatchObject({
      status: "confirmed",
      outstanding_amount: 100,
    });
  });

  it("allocates previous settlement oldest-first and records provenance", async () => {
    const { data, error } = await completeWithPrevious(60);

    expect(error).toBeNull();
    expect(data?.[0]).toMatchObject({
      previous_outstanding_before: 80,
      previous_settled_now: 60,
      previous_outstanding_after: 20,
      affected_prior_appointment_ids: [
        ids.oldAppointment1,
        ids.oldAppointment2,
      ],
    });

    const [{ data: prior }, { data: settlements }] = await Promise.all([
      service
        .from("appointments")
        .select("id, outstanding_amount")
        .in("id", [ids.oldAppointment1, ids.oldAppointment2])
        .order("scheduled_at", { ascending: true }),
      service
        .from("outstanding_settlements")
        .select("appointment_id, source_appointment_id, amount, payment_method, note")
        .eq("source_appointment_id", ids.currentAppointment)
        .order("amount", { ascending: false }),
    ]);

    expect(prior).toEqual([
      { id: ids.oldAppointment1, outstanding_amount: 0 },
      { id: ids.oldAppointment2, outstanding_amount: 20 },
    ]);
    expect(settlements).toEqual([
      {
        appointment_id: ids.oldAppointment1,
        source_appointment_id: ids.currentAppointment,
        amount: 30,
        payment_method: "cash",
        note: "Paid with current invoice",
      },
      {
        appointment_id: ids.oldAppointment2,
        source_appointment_id: ids.currentAppointment,
        amount: 30,
        payment_method: "cash",
        note: "Paid with current invoice",
      },
    ]);
  });
});
