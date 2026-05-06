import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
type TestUserKey = "admin" | "manager" | "doctor" | "otherDoctor";

const ids = {
  clinic: "10000000-0000-4000-8000-000000000001",
  otherClinic: "10000000-0000-4000-8000-000000000002",
  dept: "20000000-0000-4000-8000-000000000001",
  otherDept: "20000000-0000-4000-8000-000000000002",
  otherClinicDept: "20000000-0000-4000-8000-000000000003",
  allowedPatient: "30000000-0000-4000-8000-000000000001",
  deptPatient: "30000000-0000-4000-8000-000000000002",
  unrelatedPatient: "30000000-0000-4000-8000-000000000003",
  otherClinicPatient: "30000000-0000-4000-8000-000000000004",
  allowedAppointment: "40000000-0000-4000-8000-000000000001",
  unrelatedAppointment: "40000000-0000-4000-8000-000000000002",
  allowedNote: "50000000-0000-4000-8000-000000000001",
  deptNote: "50000000-0000-4000-8000-000000000002",
  unrelatedNote: "50000000-0000-4000-8000-000000000003",
  otherClinicNote: "50000000-0000-4000-8000-000000000004",
  authoredNote: "50000000-0000-4000-8000-000000000005",
  deposit: "60000000-0000-4000-8000-000000000001",
  settlement: "70000000-0000-4000-8000-000000000001",
} as const;

const suffix = `rls-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "RlsTest12345";
const emails: Record<TestUserKey, string> = {
  admin: `${suffix}-admin@example.com`,
  manager: `${suffix}-manager@example.com`,
  doctor: `${suffix}-doctor@example.com`,
  otherDoctor: `${suffix}-other-doctor@example.com`,
};

const userIds = {} as Record<TestUserKey, string>;
const clients = {} as Record<TestUserKey, DbClient>;

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

function client() {
  return createClient<Database>(
    LOCAL_SUPABASE_URL,
    LOCAL_SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        storageKey: `clinic-crm-rls-${Math.random().toString(36).slice(2)}`,
      },
    },
  );
}

async function createAuthUser(key: TestUserKey) {
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

async function signInUser(key: TestUserKey) {
  const signedIn = client();
  const { error } = await signedIn.auth.signInWithPassword({
    email: emails[key],
    password,
  });
  if (error) throw new Error(error.message);
  clients[key] = signedIn;
}

async function cleanupSeedData() {
  await service.from("user_page_permissions").delete().eq("clinic_id", ids.clinic);
  await service.from("medical_notes").delete().in("id", [
    ids.allowedNote,
    ids.deptNote,
    ids.unrelatedNote,
    ids.otherClinicNote,
    ids.authoredNote,
  ]);
  await service.from("patient_deposits").delete().eq("id", ids.deposit);
  await service.from("outstanding_settlements").delete().eq("id", ids.settlement);
  await service.from("appointments").delete().in("id", [
    ids.allowedAppointment,
    ids.unrelatedAppointment,
  ]);
  await service.from("patients").delete().in("id", [
    ids.allowedPatient,
    ids.deptPatient,
    ids.unrelatedPatient,
    ids.otherClinicPatient,
  ]);
  await service.from("profiles").delete().in("clinic_id", [
    ids.clinic,
    ids.otherClinic,
  ]);
  await service.from("departments").delete().in("id", [
    ids.dept,
    ids.otherDept,
    ids.otherClinicDept,
  ]);
  await service.from("clinics").delete().in("id", [ids.clinic, ids.otherClinic]);
}

async function seedRlsData() {
  await service.from("clinics").insert([
    { id: ids.clinic, name: `RLS Clinic ${suffix}` },
    { id: ids.otherClinic, name: `RLS Other Clinic ${suffix}` },
  ]);
  await service.from("departments").insert([
    { id: ids.dept, clinic_id: ids.clinic, name: `RLS Dept ${suffix}` },
    { id: ids.otherDept, clinic_id: ids.clinic, name: `RLS Other Dept ${suffix}` },
    {
      id: ids.otherClinicDept,
      clinic_id: ids.otherClinic,
      name: `RLS Other Clinic Dept ${suffix}`,
    },
  ]);
  await service.from("profiles").insert([
    {
      id: userIds.admin,
      clinic_id: ids.clinic,
      full_name: "RLS Admin",
      role: "admin",
    },
    {
      id: userIds.manager,
      clinic_id: ids.clinic,
      full_name: "RLS Manager",
      role: "manager",
    },
    {
      id: userIds.doctor,
      clinic_id: ids.clinic,
      department_id: ids.dept,
      full_name: "RLS Doctor",
      role: "doctor",
    },
    {
      id: userIds.otherDoctor,
      clinic_id: ids.clinic,
      department_id: ids.otherDept,
      full_name: "RLS Other Doctor",
      role: "doctor",
    },
  ]);
  await service.from("patients").insert([
    {
      id: ids.allowedPatient,
      clinic_id: ids.clinic,
      full_name: "Allowed Patient",
      date_of_birth: "1990-01-01",
      phone: "05551234567",
      email: `${suffix}-allowed@example.com`,
      created_by: userIds.admin,
      department_id: ids.otherDept,
      national_id: `${suffix}A`,
      file_number: `${suffix}-A`,
      assigned_doctor_id: userIds.doctor,
    },
    {
      id: ids.deptPatient,
      clinic_id: ids.clinic,
      full_name: "Department Patient",
      date_of_birth: "1991-01-01",
      phone: "05551234568",
      email: `${suffix}-dept@example.com`,
      created_by: userIds.admin,
      department_id: ids.dept,
      national_id: `${suffix}D`,
      file_number: `${suffix}-D`,
      assigned_doctor_id: userIds.otherDoctor,
    },
    {
      id: ids.unrelatedPatient,
      clinic_id: ids.clinic,
      full_name: "Unrelated Patient",
      date_of_birth: "1992-01-01",
      phone: "05551234569",
      email: `${suffix}-unrelated@example.com`,
      created_by: userIds.admin,
      department_id: ids.otherDept,
      national_id: `${suffix}U`,
      file_number: `${suffix}-U`,
      assigned_doctor_id: userIds.otherDoctor,
    },
    {
      id: ids.otherClinicPatient,
      clinic_id: ids.otherClinic,
      full_name: "Other Clinic Patient",
      date_of_birth: "1993-01-01",
      phone: "05551234570",
      email: `${suffix}-other-clinic@example.com`,
      created_by: userIds.admin,
      department_id: ids.otherClinicDept,
      national_id: `${suffix}O`,
      file_number: `${suffix}-O`,
      assigned_doctor_id: userIds.otherDoctor,
    },
  ]);
  await service.from("appointments").insert([
    {
      id: ids.allowedAppointment,
      clinic_id: ids.clinic,
      patient_id: ids.allowedPatient,
      doctor_id: userIds.doctor,
      department_id: ids.dept,
      scheduled_at: "2099-05-01T09:00:00.000Z",
      duration_minutes: 30,
      created_by: userIds.admin,
    },
    {
      id: ids.unrelatedAppointment,
      clinic_id: ids.clinic,
      patient_id: ids.unrelatedPatient,
      doctor_id: userIds.otherDoctor,
      department_id: ids.otherDept,
      scheduled_at: "2099-05-01T10:00:00.000Z",
      duration_minutes: 30,
      created_by: userIds.admin,
    },
  ]);
  await service.from("patient_deposits").insert({
    id: ids.deposit,
    clinic_id: ids.clinic,
    patient_id: ids.allowedPatient,
    amount: 25,
    payment_method: "cash",
    created_by: userIds.admin,
  });
  await service.from("outstanding_settlements").insert({
    id: ids.settlement,
    clinic_id: ids.clinic,
    patient_id: ids.allowedPatient,
    appointment_id: ids.allowedAppointment,
    amount: 10,
    payment_method: "cash",
    created_by: userIds.admin,
  });
  await service.from("medical_notes").insert([
    {
      id: ids.allowedNote,
      patient_id: ids.allowedPatient,
      doctor_id: userIds.otherDoctor,
      created_by: userIds.otherDoctor,
      note: "Allowed patient note",
    },
    {
      id: ids.deptNote,
      patient_id: ids.deptPatient,
      doctor_id: userIds.otherDoctor,
      created_by: userIds.otherDoctor,
      note: "Department patient note",
    },
    {
      id: ids.unrelatedNote,
      patient_id: ids.unrelatedPatient,
      doctor_id: userIds.otherDoctor,
      created_by: userIds.otherDoctor,
      note: "Unrelated note",
    },
    {
      id: ids.otherClinicNote,
      patient_id: ids.otherClinicPatient,
      doctor_id: userIds.otherDoctor,
      created_by: userIds.otherDoctor,
      note: "Other clinic note",
    },
  ]);
}

beforeAll(async () => {
  const { error } = await service.from("clinics").select("id").limit(1);
  if (error) {
    throw new Error(
      `Local Supabase is unavailable or not migrated: ${error.message}`,
    );
  }
  await Promise.all(
    (Object.keys(emails) as TestUserKey[]).map((key) => createAuthUser(key)),
  );
  try {
    await cleanupSeedData();
    await seedRlsData();
    await Promise.all(
      (Object.keys(emails) as TestUserKey[]).map((key) => signInUser(key)),
    );
  } catch (error) {
    await cleanupSeedData();
    throw error;
  }
}, 30_000);

afterAll(async () => {
  await cleanupSeedData();
  await Promise.all(
    Object.values(userIds).map((id) => service.auth.admin.deleteUser(id)),
  );
});

describe("RLS security integration", () => {
  it("prevents anon clients from reading app table rows", async () => {
    const anon = client();

    const [
      { data: patients, error: patientsError },
      { data: appointments, error: appointmentsError },
      { data: profiles, error: profilesError },
    ] =
      await Promise.all([
        anon.from("patients").select("id").eq("id", ids.allowedPatient),
        anon.from("appointments").select("id").eq("id", ids.allowedAppointment),
        anon.from("profiles").select("id").eq("id", userIds.doctor),
      ]);

    expect(patients ?? []).toEqual([]);
    expect(appointments ?? []).toEqual([]);
    expect(profiles ?? []).toEqual([]);
    expect(patientsError ?? appointmentsError ?? profilesError).toBeTruthy();
  });

  it("scopes doctor patient reads to assigned or department patients", async () => {
    const { data, error } = await clients.doctor
      .from("patients")
      .select("id")
      .in("id", [
        ids.allowedPatient,
        ids.deptPatient,
        ids.unrelatedPatient,
      ]);

    expect(error).toBeNull();
    expect(data?.map((row) => row.id).sort()).toEqual([
      ids.allowedPatient,
      ids.deptPatient,
    ]);
  });

  it("blocks doctor reads of unrelated appointments", async () => {
    const { data, error } = await clients.doctor
      .from("appointments")
      .select("id")
      .in("id", [ids.allowedAppointment, ids.unrelatedAppointment]);

    expect(error).toBeNull();
    expect(data).toEqual([{ id: ids.allowedAppointment }]);
  });

  it("blocks direct doctor reads of finance rows", async () => {
    const [{ data: deposits }, { data: settlements }] = await Promise.all([
      clients.doctor.from("patient_deposits").select("id").eq("id", ids.deposit),
      clients.doctor
        .from("outstanding_settlements")
        .select("id")
        .eq("id", ids.settlement),
    ]);

    expect(deposits).toEqual([]);
    expect(settlements).toEqual([]);
  });

  it("allows managers to manage non-admin page permissions only", async () => {
    const allowed = await clients.manager.from("user_page_permissions").upsert({
      user_id: userIds.doctor,
      clinic_id: ids.clinic,
      page_slug: "patients",
      is_visible: true,
    });
    const denied = await clients.manager.from("user_page_permissions").upsert({
      user_id: userIds.admin,
      clinic_id: ids.clinic,
      page_slug: "settings",
      is_visible: true,
    });

    expect(allowed.error).toBeNull();
    expect(denied.error).not.toBeNull();
  });

  it("prevents managers from role escalation and admin user management", async () => {
    const escalation = await clients.manager
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", userIds.doctor);
    const adminManagement = await clients.manager
      .from("profiles")
      .update({ full_name: "Manager Edited Admin" }, { count: "exact" })
      .eq("id", userIds.admin);
    const { data: adminProfile } = await service
      .from("profiles")
      .select("full_name")
      .eq("id", userIds.admin)
      .single();

    expect(escalation.error).not.toBeNull();
    expect(adminManagement.error).toBeNull();
    expect(adminManagement.count).toBe(0);
    expect(adminProfile?.full_name).toBe("RLS Admin");
  });

  it("scopes medical note reads to admin clinic-wide and doctor allowed patient scope", async () => {
    const adminNotes = await clients.admin
      .from("medical_notes")
      .select("id")
      .in("id", [
        ids.allowedNote,
        ids.deptNote,
        ids.unrelatedNote,
        ids.otherClinicNote,
      ]);
    const doctorNotes = await clients.doctor
      .from("medical_notes")
      .select("id")
      .in("id", [ids.allowedNote, ids.deptNote, ids.unrelatedNote]);

    expect(adminNotes.error).toBeNull();
    expect(adminNotes.data?.map((row) => row.id).sort()).toEqual([
      ids.allowedNote,
      ids.deptNote,
      ids.unrelatedNote,
    ]);
    expect(doctorNotes.error).toBeNull();
    expect(doctorNotes.data?.map((row) => row.id).sort()).toEqual([
      ids.allowedNote,
      ids.deptNote,
    ]);
  });

  it("allows doctors to mutate only their authored medical notes", async () => {
    await service.from("medical_notes").insert({
      id: ids.authoredNote,
      patient_id: ids.allowedPatient,
      doctor_id: userIds.doctor,
      created_by: userIds.doctor,
      note: "Authored note",
    });

    const ownUpdate = await clients.doctor
      .from("medical_notes")
      .update({ note: "Updated authored note" })
      .eq("id", ids.authoredNote);
    const otherUpdate = await clients.doctor
      .from("medical_notes")
      .update({ note: "Illicit edit" }, { count: "exact" })
      .eq("id", ids.allowedNote);
    const { data: otherNote } = await service
      .from("medical_notes")
      .select("note")
      .eq("id", ids.allowedNote)
      .single();

    expect(ownUpdate.error).toBeNull();
    expect(otherUpdate.error).toBeNull();
    expect(otherUpdate.count).toBe(0);
    expect(otherNote?.note).toBe("Allowed patient note");
  });
});
