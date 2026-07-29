import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { CALENDAR_APPOINTMENT_SELECT } from "@/lib/appointments/calendar";

const LOCAL_SUPABASE_URL =
  process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function requireTestEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set in .env.local before running integration tests.`);
  return v;
}

const LOCAL_SUPABASE_PUBLISHABLE_KEY = requireTestEnv("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const LOCAL_SUPABASE_SECRET_KEY = requireTestEnv("LOCAL_SUPABASE_SECRET_KEY");

type DbClient = SupabaseClient<Database>;
type TestUserKey =
  | "admin"
  | "receptionist"
  | "manager"
  | "doctor"
  | "otherDoctor"
  | "otherClinicDoctor";

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
  otherClinicAppointment: "40000000-0000-4000-8000-000000000003",
  allowedNote: "50000000-0000-4000-8000-000000000001",
  deptNote: "50000000-0000-4000-8000-000000000002",
  unrelatedNote: "50000000-0000-4000-8000-000000000003",
  otherClinicNote: "50000000-0000-4000-8000-000000000004",
  authoredNote: "50000000-0000-4000-8000-000000000005",
  deposit: "60000000-0000-4000-8000-000000000001",
  settlement: "70000000-0000-4000-8000-000000000001",
  patientDocument: "80000000-0000-4000-8000-000000000001",
  softDeletedDocument: "80000000-0000-4000-8000-000000000002",
  otherClinicDocument: "80000000-0000-4000-8000-000000000003",
  receptionistDocument: "80000000-0000-4000-8000-000000000004",
  duplicateNationalDocument: "80000000-0000-4000-8000-000000000005",
} as const;

const suffix = `rls-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "RlsTest12345";
const emails: Record<TestUserKey, string> = {
  admin: `${suffix}-admin@example.com`,
  receptionist: `${suffix}-receptionist@example.com`,
  manager: `${suffix}-manager@example.com`,
  doctor: `${suffix}-doctor@example.com`,
  otherDoctor: `${suffix}-other-doctor@example.com`,
  otherClinicDoctor: `${suffix}-other-clinic-doctor@example.com`,
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

function assertNoError<T extends { error: { message: string } | null }>(
  result: T,
  context: string,
): T {
  if (result.error) {
    throw new Error(`${context}: ${result.error.message}`);
  }
  return result;
}

const storagePaths = {
  patientDocument: `documents/${ids.clinic}/${ids.allowedPatient}/national_id/${ids.patientDocument}.pdf`,
  softDeletedDocument: `documents/${ids.clinic}/${ids.allowedPatient}/other/${ids.softDeletedDocument}.pdf`,
  otherClinicDocument: `documents/${ids.otherClinic}/${ids.otherClinicPatient}/other/${ids.otherClinicDocument}.pdf`,
  malformedDocument: `documents/${ids.clinic}/${ids.allowedPatient}/other/not-a-uuid.pdf`,
  avatar: `avatars/${ids.clinic}/${ids.allowedPatient}/avatar.webp`,
};

function staffStoragePath() {
  return `staff/${ids.clinic}/${userIds.doctor}/photo.png`;
}

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
  await Promise.all([
    service.storage.from("patient-assets").remove([
      storagePaths.patientDocument,
      storagePaths.softDeletedDocument,
      storagePaths.otherClinicDocument,
      storagePaths.malformedDocument,
      storagePaths.avatar,
    ]),
    userIds.doctor
      ? service.storage.from("clinic-assets").remove([staffStoragePath()])
      : Promise.resolve({ data: null, error: null }),
  ]);
  assertNoError(
    await service.from("user_page_permissions").delete().eq("clinic_id", ids.clinic),
    "cleanup page permissions",
  );
  assertNoError(
    await service.from("patient_documents").delete().in("clinic_id", [
      ids.clinic,
      ids.otherClinic,
    ]),
    "cleanup patient documents",
  );
  assertNoError(
    await service.from("medical_notes").delete().in("id", [
      ids.allowedNote,
      ids.deptNote,
      ids.unrelatedNote,
      ids.otherClinicNote,
      ids.authoredNote,
    ]),
    "cleanup medical notes",
  );
  assertNoError(
    await service.from("patient_deposits").delete().eq("id", ids.deposit),
    "cleanup patient deposits",
  );
  assertNoError(
    await service.from("outstanding_settlements").delete().eq("id", ids.settlement),
    "cleanup outstanding settlements",
  );
  assertNoError(
    await service.from("appointments").delete().in("id", [
      ids.allowedAppointment,
      ids.unrelatedAppointment,
      ids.otherClinicAppointment,
    ]),
    "cleanup appointments",
  );
  assertNoError(
    await service.from("patients").delete().in("id", [
      ids.allowedPatient,
      ids.deptPatient,
      ids.unrelatedPatient,
      ids.otherClinicPatient,
    ]),
    "cleanup patients",
  );
  assertNoError(
    await service.from("profiles").delete().in("clinic_id", [
      ids.clinic,
      ids.otherClinic,
    ]),
    "cleanup profiles",
  );
  assertNoError(
    await service.from("departments").delete().in("id", [
      ids.dept,
      ids.otherDept,
      ids.otherClinicDept,
    ]),
    "cleanup departments",
  );
  assertNoError(
    await service.from("clinics").delete().in("id", [ids.clinic, ids.otherClinic]),
    "cleanup clinics",
  );
}

async function seedRlsData() {
  assertNoError(
    await service.from("clinics").insert([
      { id: ids.clinic, name: `RLS Clinic ${suffix}` },
      { id: ids.otherClinic, name: `RLS Other Clinic ${suffix}` },
    ]),
    "seed clinics",
  );
  assertNoError(
    await service.from("departments").insert([
      { id: ids.dept, clinic_id: ids.clinic, name: `RLS Dept ${suffix}` },
      { id: ids.otherDept, clinic_id: ids.clinic, name: `RLS Other Dept ${suffix}` },
      {
        id: ids.otherClinicDept,
        clinic_id: ids.otherClinic,
        name: `RLS Other Clinic Dept ${suffix}`,
      },
    ]),
    "seed departments",
  );
  assertNoError(
    await service.from("profiles").insert([
      {
        id: userIds.admin,
        clinic_id: ids.clinic,
        full_name: "RLS Admin",
        role: "admin",
      },
      {
        id: userIds.receptionist,
        clinic_id: ids.clinic,
        full_name: "RLS Receptionist",
        role: "receptionist",
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
      {
        id: userIds.otherClinicDoctor,
        clinic_id: ids.otherClinic,
        department_id: ids.otherClinicDept,
        full_name: "RLS Other Clinic Doctor",
        role: "doctor",
      },
    ]),
    "seed profiles",
  );
  assertNoError(
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
      created_by: userIds.otherClinicDoctor,
      department_id: ids.otherClinicDept,
      national_id: `${suffix}O`,
      file_number: `${suffix}-O`,
      assigned_doctor_id: userIds.otherClinicDoctor,
    },
    ]),
    "seed patients",
  );
  assertNoError(
    await service.from("patient_documents").insert([
    {
      id: ids.patientDocument,
      clinic_id: ids.clinic,
      patient_id: ids.allowedPatient,
      category: "national_id",
      file_name: "patient-document.pdf",
      mime_type: "application/pdf",
      size_bytes: 3,
      storage_path: storagePaths.patientDocument,
      uploaded_by: userIds.admin,
    },
    {
      id: ids.softDeletedDocument,
      clinic_id: ids.clinic,
      patient_id: ids.allowedPatient,
      category: "other",
      file_name: "soft-deleted.pdf",
      mime_type: "application/pdf",
      size_bytes: 3,
      storage_path: storagePaths.softDeletedDocument,
      uploaded_by: userIds.admin,
      deleted_at: "2026-05-10T00:00:00.000Z",
    },
    {
      id: ids.otherClinicDocument,
      clinic_id: ids.otherClinic,
      patient_id: ids.otherClinicPatient,
      category: "other",
      file_name: "other-clinic.pdf",
      mime_type: "application/pdf",
      size_bytes: 3,
      storage_path: storagePaths.otherClinicDocument,
      uploaded_by: userIds.otherClinicDoctor,
    },
    ]),
    "seed patient documents",
  );
  await Promise.all([
    service.storage
      .from("patient-assets")
      .upload(storagePaths.patientDocument, new Uint8Array([1, 2, 3]), {
        contentType: "application/pdf",
        upsert: true,
      }),
    service.storage
      .from("patient-assets")
      .upload(storagePaths.softDeletedDocument, new Uint8Array([1, 2, 3]), {
        contentType: "application/pdf",
        upsert: true,
      }),
    service.storage
      .from("patient-assets")
      .upload(storagePaths.otherClinicDocument, new Uint8Array([1, 2, 3]), {
        contentType: "application/pdf",
        upsert: true,
      }),
    service.storage
      .from("patient-assets")
      .upload(storagePaths.malformedDocument, new Uint8Array([1, 2, 3]), {
        contentType: "application/pdf",
        upsert: true,
      }),
    service.storage
      .from("patient-assets")
      .upload(storagePaths.avatar, new Uint8Array([1, 2, 3]), {
        contentType: "image/webp",
        upsert: true,
      }),
    service.storage
      .from("clinic-assets")
      .upload(staffStoragePath(), new Uint8Array([1, 2, 3]), {
        contentType: "image/png",
        upsert: true,
      }),
  ]);
  assertNoError(
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
    {
      id: ids.otherClinicAppointment,
      clinic_id: ids.otherClinic,
      patient_id: ids.otherClinicPatient,
      doctor_id: userIds.otherClinicDoctor,
      department_id: ids.otherClinicDept,
      scheduled_at: "2099-05-01T11:00:00.000Z",
      duration_minutes: 30,
      created_by: userIds.otherClinicDoctor,
    },
    ]),
    "seed appointments",
  );
  assertNoError(
    await service.from("patient_deposits").insert({
      id: ids.deposit,
      clinic_id: ids.clinic,
      patient_id: ids.allowedPatient,
      amount: 25,
      payment_method: "cash",
      created_by: userIds.admin,
    }),
    "seed patient deposit",
  );
  assertNoError(
    await service.from("outstanding_settlements").insert({
      id: ids.settlement,
      clinic_id: ids.clinic,
      patient_id: ids.allowedPatient,
      appointment_id: ids.allowedAppointment,
      amount: 10,
      payment_method: "cash",
      created_by: userIds.admin,
    }),
    "seed outstanding settlement",
  );
  assertNoError(
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
      doctor_id: userIds.otherClinicDoctor,
      created_by: userIds.otherClinicDoctor,
      note: "Other clinic note",
    },
    ]),
    "seed medical notes",
  );
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
  it("scopes clinic root rows and blocks authenticated clinic inserts", async () => {
    const select = await clients.admin
      .from("clinics")
      .select("id")
      .in("id", [ids.clinic, ids.otherClinic]);
    const insert = await clients.admin.from("clinics").insert({
      name: `Illicit Clinic ${suffix}`,
    });

    expect(select.error).toBeNull();
    expect(select.data).toEqual([{ id: ids.clinic }]);
    expect(insert.error).not.toBeNull();
  });

  it("denies clinic admins reads across patient, appointment, note, and storage boundaries", async () => {
    const [patients, appointments, notes, documentDownload] = await Promise.all([
      clients.admin
        .from("patients")
        .select("id")
        .eq("id", ids.otherClinicPatient),
      clients.admin
        .from("appointments")
        .select("id")
        .eq("id", ids.otherClinicAppointment),
      clients.admin
        .from("medical_notes")
        .select("id")
        .eq("id", ids.otherClinicNote),
      clients.admin
        .storage
        .from("patient-assets")
        .download(storagePaths.otherClinicDocument),
    ]);

    expect(patients.error).toBeNull();
    expect(patients.data).toEqual([]);
    expect(appointments.error).toBeNull();
    expect(appointments.data).toEqual([]);
    expect(notes.error).toBeNull();
    expect(notes.data).toEqual([]);
    expect(documentDownload.error).not.toBeNull();
  });

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

  it("returns the exact calendar rows for admin, manager, receptionist, and doctor scopes", async () => {
    const queryCalendar = (db: DbClient, doctorId?: string) => {
      let query = db
        .from("appointments")
        .select(CALENDAR_APPOINTMENT_SELECT)
        .eq("clinic_id", ids.clinic)
        .is("deleted_at", null)
        .gte("scheduled_at", "2099-05-01T00:00:00.000Z")
        .lt("scheduled_at", "2099-05-02T00:00:00.000Z")
        .order("scheduled_at");
      if (doctorId) query = query.eq("doctor_id", doctorId);
      return query;
    };

    const [admin, manager, receptionist, doctor] = await Promise.all([
      queryCalendar(clients.admin),
      queryCalendar(clients.manager),
      queryCalendar(clients.receptionist),
      queryCalendar(clients.doctor, userIds.doctor),
    ]);

    for (const result of [admin, manager, receptionist, doctor]) {
      expect(result.error).toBeNull();
    }
    expect(admin.data?.map((row) => row.id)).toEqual([
      ids.allowedAppointment,
      ids.unrelatedAppointment,
    ]);
    expect(manager.data?.map((row) => row.id)).toEqual([
      ids.allowedAppointment,
      ids.unrelatedAppointment,
    ]);
    expect(receptionist.data?.map((row) => row.id)).toEqual([
      ids.allowedAppointment,
      ids.unrelatedAppointment,
    ]);
    expect(doctor.data?.map((row) => row.id)).toEqual([
      ids.allowedAppointment,
    ]);
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

  it("reserves all page-visibility customization writes for admins", async () => {
    const managerAttempt = await clients.manager.from("user_page_permissions").upsert({
      user_id: userIds.doctor,
      clinic_id: ids.clinic,
      page_slug: "patients",
      is_visible: true,
    });
    const adminAttempt = await clients.admin.from("user_page_permissions").upsert({
      user_id: userIds.doctor,
      clinic_id: ids.clinic,
      page_slug: "assistant",
      is_visible: true,
    });

    expect(managerAttempt.error).not.toBeNull();
    expect(adminAttempt.error).toBeNull();
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

  it("records last login through the RPC while direct protected-field writes remain blocked", async () => {
    for (const key of ["admin", "manager"] as const) {
      const direct = await clients[key]
        .from("profiles")
        .update({ last_login_at: new Date(0).toISOString() })
        .eq("id", userIds[key]);
      expect(direct.error).not.toBeNull();

      const rpc = await clients[key].rpc("record_own_last_login");
      expect(rpc.error).toBeNull();
      expect(rpc.data).toBe(true);

      const { data } = await service
        .from("profiles")
        .select("last_login_at")
        .eq("id", userIds[key])
        .single();
      expect(data?.last_login_at).not.toBeNull();
      expect(new Date(data!.last_login_at!).getTime()).toBeGreaterThan(
        Date.now() - 30_000,
      );
    }
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

  it("scopes patient document table reads to admin and receptionist only", async () => {
    const idsToRead = [
      ids.patientDocument,
      ids.softDeletedDocument,
      ids.otherClinicDocument,
    ];
    const [adminDocs, receptionistDocs, managerDocs, doctorDocs] =
      await Promise.all([
        clients.admin.from("patient_documents").select("id").in("id", idsToRead),
        clients.receptionist
          .from("patient_documents")
          .select("id")
          .in("id", idsToRead),
        clients.manager.from("patient_documents").select("id").in("id", idsToRead),
        clients.doctor.from("patient_documents").select("id").in("id", idsToRead),
      ]);

    expect(adminDocs.error).toBeNull();
    expect(adminDocs.data).toEqual([{ id: ids.patientDocument }]);
    expect(receptionistDocs.error).toBeNull();
    expect(receptionistDocs.data).toEqual([{ id: ids.patientDocument }]);
    expect(managerDocs.error).toBeNull();
    expect(managerDocs.data).toEqual([]);
    expect(doctorDocs.error).toBeNull();
    expect(doctorDocs.data).toEqual([]);
  });

  it("allows receptionist inserts and denies patient document writes for manager and doctor", async () => {
    const receptionistInsert = await clients.receptionist
      .from("patient_documents")
      .insert({
        id: ids.receptionistDocument,
        clinic_id: ids.clinic,
        patient_id: ids.allowedPatient,
        category: "other",
        file_name: "receptionist.pdf",
        mime_type: "application/pdf",
        size_bytes: 3,
        storage_path: `documents/${ids.clinic}/${ids.allowedPatient}/other/${ids.receptionistDocument}.pdf`,
        uploaded_by: userIds.receptionist,
      });
    const managerInsert = await clients.manager.from("patient_documents").insert({
      id: "80000000-0000-4000-8000-000000000101",
      clinic_id: ids.clinic,
      patient_id: ids.allowedPatient,
      category: "other",
      file_name: "manager.pdf",
      mime_type: "application/pdf",
      size_bytes: 3,
      storage_path: `documents/${ids.clinic}/${ids.allowedPatient}/other/80000000-0000-4000-8000-000000000101.pdf`,
      uploaded_by: userIds.manager,
    });
    const doctorUpdate = await clients.doctor
      .from("patient_documents")
      .update({ deleted_at: "2026-05-10T00:00:00.000Z" }, { count: "exact" })
      .eq("id", ids.patientDocument);

    expect(receptionistInsert.error).toBeNull();
    expect(managerInsert.error).not.toBeNull();
    expect(doctorUpdate.error).toBeNull();
    expect(doctorUpdate.count).toBe(0);
  });

  it("enforces patient document immutability and single-slot uniqueness", async () => {
    const immutableUpdate = await clients.admin
      .from("patient_documents")
      .update({ storage_path: storagePaths.softDeletedDocument })
      .eq("id", ids.patientDocument);
    const duplicateNationalId = await clients.admin
      .from("patient_documents")
      .insert({
        id: ids.duplicateNationalDocument,
        clinic_id: ids.clinic,
        patient_id: ids.allowedPatient,
        category: "national_id",
        file_name: "duplicate.pdf",
        mime_type: "application/pdf",
        size_bytes: 3,
        storage_path: `documents/${ids.clinic}/${ids.allowedPatient}/national_id/${ids.duplicateNationalDocument}.pdf`,
        uploaded_by: userIds.admin,
      });

    expect(immutableUpdate.error).not.toBeNull();
    expect(duplicateNationalId.error).not.toBeNull();
  });

  it("scopes patient document storage to allowed roles, clinic, active rows, and valid paths", async () => {
    const [
      adminSigned,
      receptionistSigned,
      managerSigned,
      doctorSigned,
      crossClinicSigned,
      softDeletedSigned,
      malformedSigned,
    ] = await Promise.all([
      clients.admin.storage
        .from("patient-assets")
        .createSignedUrl(storagePaths.patientDocument, 60),
      clients.receptionist.storage
        .from("patient-assets")
        .createSignedUrl(storagePaths.patientDocument, 60),
      clients.manager.storage
        .from("patient-assets")
        .createSignedUrl(storagePaths.patientDocument, 60),
      clients.doctor.storage
        .from("patient-assets")
        .createSignedUrl(storagePaths.patientDocument, 60),
      clients.admin.storage
        .from("patient-assets")
        .createSignedUrl(storagePaths.otherClinicDocument, 60),
      clients.admin.storage
        .from("patient-assets")
        .createSignedUrl(storagePaths.softDeletedDocument, 60),
      clients.admin.storage
        .from("patient-assets")
        .createSignedUrl(storagePaths.malformedDocument, 60),
    ]);

    expect(adminSigned.error).toBeNull();
    expect(adminSigned.data?.signedUrl).toBeTruthy();
    expect(receptionistSigned.error).toBeNull();
    expect(receptionistSigned.data?.signedUrl).toBeTruthy();
    expect(managerSigned.error).not.toBeNull();
    expect(doctorSigned.error).not.toBeNull();
    expect(crossClinicSigned.error).not.toBeNull();
    expect(softDeletedSigned.error).not.toBeNull();
    expect(malformedSigned.error).not.toBeNull();
  });

  it("keeps patient avatar and staff storage policies working separately", async () => {
    const [doctorAvatar, managerStaffFile, doctorStaffFile] = await Promise.all([
      clients.doctor.storage
        .from("patient-assets")
        .createSignedUrl(storagePaths.avatar, 60),
      clients.manager.storage
        .from("clinic-assets")
        .createSignedUrl(staffStoragePath(), 60),
      clients.doctor.storage
        .from("clinic-assets")
        .createSignedUrl(staffStoragePath(), 60),
    ]);

    expect(doctorAvatar.error).toBeNull();
    expect(doctorAvatar.data?.signedUrl).toBeTruthy();
    expect(managerStaffFile.error).toBeNull();
    expect(managerStaffFile.data?.signedUrl).toBeTruthy();
    expect(doctorStaffFile.error).not.toBeNull();
  });
});
