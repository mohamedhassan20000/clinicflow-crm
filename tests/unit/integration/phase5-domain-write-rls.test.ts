import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";

const domainClients = vi.hoisted(() => ({
  session: null as SupabaseClient<Database> | null,
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!domainClients.session) throw new Error("No integration session client");
    return domainClients.session;
  },
}));
import {
  permanentDeleteAppointmentMutation,
  softDeleteAppointmentMutation,
} from "@/lib/appointments/mutations";
import {
  restoreMedicalNoteMutation,
  updatePatientMutation,
} from "@/lib/patients/mutations";
import { updateFollowupMutation } from "@/lib/followups/mutations";
import { transitionClinicalRecordMutation } from "@/lib/clinical/mutations";
import { updatePatientPackageMutation } from "@/lib/billing/mutations";
import {
  changeStaffRoleMutation,
  setStaffActiveMutation,
  updateDirectoryMutation,
} from "@/lib/settings/mutations";
import { registeredAction } from "@/lib/ai/actions/registry";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import type { AuthedUser } from "@/lib/rbac";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
const previousSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const previousServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.SUPABASE_SERVICE_ROLE_KEY = secretKey;
type Client = SupabaseClient<Database>;

const suffix = `phase5-writes-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "Phase5DomainWrites12345";
const ids = {
  clinicA: randomUUID(), clinicB: randomUUID(), department: randomUUID(),
  service: randomUUID(), insurance: randomUUID(), patient: randomUUID(),
  appointment: randomUUID(), followup: randomUUID(), note: randomUUID(),
  prescription: randomUUID(), lab: randomUUID(), sickLeave: randomUUID(),
  packageTemplate: randomUUID(), patientPackage: randomUUID(),
  deposit: randomUUID(), settlement: randomUUID(),
};
const userIds: string[] = [];
const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function sessionClient(): Client {
  return createClient<Database>(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      storageKey: `${suffix}-${Math.random().toString(36).slice(2)}`,
    },
  });
}

async function createUser(label: string) {
  const email = `${suffix}-${label}@example.com`;
  const created = await service.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (created.error || !created.data.user) throw created.error ?? new Error("No user");
  userIds.push(created.data.user.id);
  const client = sessionClient();
  const login = await client.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  return { id: created.data.user.id, client };
}

let adminA: Awaited<ReturnType<typeof createUser>>;
let adminB: Awaited<ReturnType<typeof createUser>>;
let doctorB: Awaited<ReturnType<typeof createUser>>;
let managerB: Awaited<ReturnType<typeof createUser>>;
let otherDoctorB: Awaited<ReturnType<typeof createUser>>;

function domainUser(
  account: Awaited<ReturnType<typeof createUser>>,
  role: AuthedUser["role"],
): AuthedUser {
  return {
    id: account.id,
    clinicId: ids.clinicB,
    email: `${role}@example.com`,
    fullName: role,
    role,
    avatarUrl: null,
    departmentId: role === "doctor" ? ids.department : null,
    mustChangePassword: false,
  };
}

async function mustSucceed(
  result: { error: { message: string } | null },
  label: string,
) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
}

beforeAll(async () => {
  [adminA, adminB, doctorB, managerB, otherDoctorB] = await Promise.all([
    createUser("admin-a"), createUser("admin-b"), createUser("doctor-b"),
    createUser("manager-b"), createUser("other-doctor-b"),
  ]);
  await mustSucceed(await service.from("clinics").insert([
    { id: ids.clinicA, name: `Phase 5 A ${suffix}` },
    { id: ids.clinicB, name: `Phase 5 B ${suffix}` },
  ]), "clinics");
  await mustSucceed(await service.from("profiles").insert([
    { id: adminA.id, clinic_id: ids.clinicA, full_name: "Admin A", role: "admin" },
    { id: adminB.id, clinic_id: ids.clinicB, full_name: "Admin B", role: "admin" },
    { id: doctorB.id, clinic_id: ids.clinicB, full_name: "Doctor B", role: "doctor" },
    { id: managerB.id, clinic_id: ids.clinicB, full_name: "Manager B", role: "manager" },
    { id: otherDoctorB.id, clinic_id: ids.clinicB, full_name: "Other Doctor B", role: "doctor" },
  ]), "profiles");
  await mustSucceed(await service.from("departments").insert({
    id: ids.department, clinic_id: ids.clinicB, name: `Dept ${suffix}`, color: "#123456",
  }), "department");
  await mustSucceed(await service.from("services").insert({
    id: ids.service, clinic_id: ids.clinicB, department_id: ids.department,
    name: `Service ${suffix}`, price: 100,
  }), "service");
  await mustSucceed(await service.from("insurance_providers").insert({
    id: ids.insurance, clinic_id: ids.clinicB, name: `Insurance ${suffix}`,
  }), "insurance");
  await mustSucceed(await service.from("patients").insert({
    id: ids.patient, clinic_id: ids.clinicB, full_name: "Tenant B Patient",
    phone: `90${Date.now().toString().slice(-8)}`, date_of_birth: "1990-01-01",
    email: `${suffix}-patient@example.com`, national_id: suffix.replace(/[^A-Za-z0-9]/g, ""),
    file_number: `${suffix}-P`, department_id: ids.department,
    assigned_doctor_id: doctorB.id, insurance_provider_id: ids.insurance,
    created_by: adminB.id,
  }), "patient");
  await mustSucceed(await service.from("appointments").insert({
    id: ids.appointment, clinic_id: ids.clinicB, patient_id: ids.patient,
    doctor_id: doctorB.id, department_id: ids.department,
    scheduled_at: "2026-08-13T10:00:00.000Z", duration_minutes: 30,
    status: "completed", created_by: adminB.id,
  }), "appointment");
  await mustSucceed(await service.from("follow_ups").insert({
    id: ids.followup, clinic_id: ids.clinicB, patient_id: ids.patient,
    appointment_id: ids.appointment, outcome: "all_fine", recorded_by: adminB.id,
  }), "follow-up");
  await mustSucceed(await service.from("medical_notes").insert({
    id: ids.note, patient_id: ids.patient, appointment_id: ids.appointment,
    doctor_id: doctorB.id, created_by: doctorB.id, note: "Tenant B note",
  }), "medical note");
  await mustSucceed(await service.from("prescriptions").insert({
    id: ids.prescription, clinic_id: ids.clinicB, patient_id: ids.patient,
    appointment_id: ids.appointment, responsible_doctor_id: doctorB.id,
    created_by: adminB.id, status: "draft",
  }), "prescription");
  await mustSucceed(await service.from("lab_requests").insert({
    id: ids.lab, clinic_id: ids.clinicB, patient_id: ids.patient,
    appointment_id: ids.appointment, responsible_doctor_id: doctorB.id,
    created_by: adminB.id, status: "draft",
  }), "lab request");
  await mustSucceed(await service.from("sick_leaves").insert({
    id: ids.sickLeave, clinic_id: ids.clinicB, patient_id: ids.patient,
    appointment_id: ids.appointment, responsible_doctor_id: doctorB.id,
    created_by: adminB.id, status: "draft", leave_start_date: "2026-08-14",
    leave_end_date: "2026-08-15",
  }), "sick leave");
  await mustSucceed(await service.from("package_templates").insert({
    id: ids.packageTemplate, clinic_id: ids.clinicB, name: `Template ${suffix}`,
    department_id: ids.department, total_sessions: 5, price_per_session: 100,
    total_price: 500, created_by: adminB.id,
  }), "package template");
  await mustSucceed(await service.from("patient_packages").insert({
    id: ids.patientPackage, clinic_id: ids.clinicB, patient_id: ids.patient,
    department_id: ids.department, service_id: ids.service, name: `Package ${suffix}`,
    total_sessions: 5, used_sessions: 1, price_per_session: 100, created_by: adminB.id,
  }), "patient package");
  await mustSucceed(await service.from("patient_deposits").insert({
    id: ids.deposit, clinic_id: ids.clinicB, patient_id: ids.patient,
    amount: 25, payment_method: "cash", created_by: adminB.id,
  }), "deposit");
  await mustSucceed(await service.from("outstanding_settlements").insert({
    id: ids.settlement, clinic_id: ids.clinicB, patient_id: ids.patient,
    appointment_id: ids.appointment, amount: 10, payment_method: "cash",
    created_by: adminB.id,
  }), "settlement");
  await mustSucceed(await service.from("clinic_working_hours").insert({
    clinic_id: ids.clinicB, day_of_week: 1, shift_start: "09:00", shift_end: "17:00",
  }), "clinic hours");
  await mustSucceed(await service.from("doctor_schedules").insert({
    clinic_id: ids.clinicB, doctor_id: doctorB.id, day_of_week: 1,
    start_time: "09:00", end_time: "17:00",
  }), "staff schedule");
}, 60_000);

afterAll(async () => {
  await service.from("clinics").delete().in("id", [ids.clinicA, ids.clinicB]);
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id)));
  if (previousSupabaseUrl === undefined) {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  } else {
    process.env.NEXT_PUBLIC_SUPABASE_URL = previousSupabaseUrl;
  }
  if (previousServiceRoleKey === undefined) {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  } else {
    process.env.SUPABASE_SERVICE_ROLE_KEY = previousServiceRoleKey;
  }
});

describe("Phase 5 authenticated write RLS", () => {
  it("returns no cross-tenant rows for updates across every 5a-5e domain", async () => {
    const attempts = await Promise.all([
      adminA.client.from("appointments").update({ notes: "forged" }).eq("id", ids.appointment).select("id"),
      adminA.client.from("follow_ups").update({ notes: "forged" }).eq("id", ids.followup).select("id"),
      adminA.client.from("patients").update({ full_name: "forged" }).eq("id", ids.patient).select("id"),
      adminA.client.from("medical_notes").update({ note: "forged" }).eq("id", ids.note).select("id"),
      adminA.client.from("prescriptions").update({ notes: "forged" }).eq("id", ids.prescription).select("id"),
      adminA.client.from("lab_requests").update({ clinical_context: "forged" }).eq("id", ids.lab).select("id"),
      adminA.client.from("sick_leaves").update({ restrictions: "forged" }).eq("id", ids.sickLeave).select("id"),
      adminA.client.from("patient_deposits").update({ note: "forged" }).eq("id", ids.deposit).select("id"),
      adminA.client.from("outstanding_settlements").update({ note: "forged" }).eq("id", ids.settlement).select("id"),
      adminA.client.from("patient_packages").update({ name: "forged" }).eq("id", ids.patientPackage).select("id"),
      adminA.client.from("package_templates").update({ name: "forged" }).eq("id", ids.packageTemplate).select("id"),
      adminA.client.from("profiles").update({ phone: "+900000000000" }).eq("id", doctorB.id).select("id"),
      adminA.client.from("departments").update({ name: "forged" }).eq("id", ids.department).select("id"),
      adminA.client.from("services").update({ name: "forged" }).eq("id", ids.service).select("id"),
      adminA.client.from("insurance_providers").update({ name: "forged" }).eq("id", ids.insurance).select("id"),
      adminA.client.from("clinic_working_hours").update({ shift_end: "18:00" }).eq("clinic_id", ids.clinicB).select("clinic_id"),
      adminA.client.from("doctor_schedules").update({ end_time: "18:00" }).eq("doctor_id", doctorB.id).select("doctor_id"),
      adminA.client.from("clinics").update({ name: "forged" }).eq("id", ids.clinicB).select("id"),
    ]);
    for (const result of attempts) {
      expect(result.error === null ? result.data : []).toEqual([]);
    }

    const unchanged = await service.from("clinics").select("name").eq("id", ids.clinicB).single();
    expect(unchanged.data?.name).toBe(`Phase 5 B ${suffix}`);
  });

  it("executes a same-tenant authenticated write in every Phase 5 domain", async () => {
    domainClients.session = adminB.client;
    const user = domainUser(adminB, "admin");

    const patient = await updatePatientMutation(user, {
      patient_id: ids.patient,
      full_name: "Tenant B Patient Updated",
      national_id: suffix.replace(/[^A-Za-z0-9]/g, "").slice(0, 32),
      date_of_birth: "1990-01-01",
      phone: "+905551234567",
      email: `${suffix}-patient-updated@example.com`,
      blood_type: "O+",
      department_id: ids.department,
      assigned_doctor_id: doctorB.id,
      insurance_provider_id: ids.insurance,
    });
    expect(patient.ok, JSON.stringify(patient)).toBe(true);

    const followup = await updateFollowupMutation(user, {
      followup_id: ids.followup,
      patient_id: ids.patient,
      outcome: "has_problem",
      notes: "Same-tenant follow-up verified",
    });
    expect(followup.ok, JSON.stringify(followup)).toBe(true);

    const clinical = await transitionClinicalRecordMutation(
      user,
      "sick_leaves",
      { id: ids.sickLeave },
      "finalize",
    );
    expect(clinical.ok, JSON.stringify(clinical)).toBe(true);

    const billing = await updatePatientPackageMutation(user, {
      package_id: ids.patientPackage,
      name: `Package updated ${suffix}`,
      total_sessions: 6,
      price_per_session: 110,
      notes: "Same-tenant billing write verified",
      department_id: ids.department,
      service_id: ids.service,
      is_active: true,
    });
    expect(billing.ok, JSON.stringify(billing)).toBe(true);

    const settings = await updateDirectoryMutation(user, "department", {
      department_id: ids.department,
      name: `Department updated ${suffix}`,
      color: "#654321",
      description: "Same-tenant settings write verified",
    });
    expect(settings.ok, JSON.stringify(settings)).toBe(true);

    const appointmentId = randomUUID();
    await mustSucceed(await service.from("appointments").insert({
      id: appointmentId,
      clinic_id: ids.clinicB,
      patient_id: ids.patient,
      doctor_id: doctorB.id,
      department_id: ids.department,
      scheduled_at: "2026-08-21T10:00:00.000Z",
      duration_minutes: 30,
      status: "pending",
      created_by: adminB.id,
    }), "same-tenant appointment write fixture");
    const appointments = await softDeleteAppointmentMutation(user, {
      appointment_id: appointmentId,
    });
    expect(appointments.ok, JSON.stringify(appointments)).toBe(true);

    expect(
      (await service.from("patients").select("full_name").eq("id", ids.patient).single())
        .data?.full_name,
    ).toBe("Tenant B Patient Updated");
    expect(
      (await service.from("sick_leaves").select("status").eq("id", ids.sickLeave).single())
        .data?.status,
    ).toBe("finalized");
  });

  it("uses the real clinic-scoped admin wrapper and cannot escape its clinic binding", async () => {
    const scopedAdmin = createClinicScopedAdminClient(ids.clinicB);
    const result = await scopedAdmin
      .from("patients")
      .select("id, clinic_id")
      .in("clinic_id", [ids.clinicA, ids.clinicB]);
    expect(result.error).toBeNull();
    expect(result.data?.map((row) => row.clinic_id)).toEqual([ids.clinicB]);
    expect(result.data?.map((row) => row.id)).toContain(ids.patient);

    expect(() =>
      scopedAdmin.from("patients").update({ clinic_id: ids.clinicA }),
    ).toThrow(/different clinic_id/i);
  });

  it("runs the Phase 5f role cascade and preserves primary-admin and manager boundaries", async () => {
    domainClients.session = adminB.client;
    const admin = domainUser(adminB, "admin");

    // F3: the shared core is the Settings UI's only implementation, and
    // Settings → Staff never refused a primary-admin demotion. The core must
    // therefore allow it, exactly as `actions/settings-legacy.ts` did.
    const primaryDemotion = await changeStaffRoleMutation(
      admin,
      {
        staff_id: adminB.id,
        role: "manager",
        department_id: null,
        supervising_doctor_ids: [],
      },
      "preview",
    );
    expect(primaryDemotion.ok, JSON.stringify(primaryDemotion)).toBe(true);

    // The refusal lives at the Assistant boundary instead, against the real
    // database's primary-admin resolution — a second admin cannot demote the
    // founding administrator through the Assistant.
    const secondAdmin = domainUser(otherDoctorB, "admin");
    const privileged = registeredAction("staff.change_role");
    if (!privileged) throw new Error("staff.change_role is not registered");
    await expect(
      privileged.previewValidated(secondAdmin, {
        staff_id: adminB.id,
        role: "manager",
        department_id: null,
        supervising_doctor_ids: [],
      }),
    ).rejects.toMatchObject({
      name: "ActionBusinessRuleError",
      code: "settings.thePrimaryClinicAdminRoleCannotBeChanged",
    });

    const promoted = await changeStaffRoleMutation(admin, {
      staff_id: otherDoctorB.id,
      role: "assistant",
      department_id: ids.department,
      supervising_doctor_ids: [doctorB.id],
    });
    expect(promoted.ok, JSON.stringify(promoted)).toBe(true);
    expect(
      (
        await service
          .from("profiles")
          .select("role, department_id")
          .eq("id", otherDoctorB.id)
          .single()
      ).data,
    ).toEqual({ role: "assistant", department_id: ids.department });
    expect(
      (
        await service
          .from("assistant_doctor_assignments")
          .select("doctor_id")
          .eq("assistant_id", otherDoctorB.id)
      ).data,
    ).toEqual([{ doctor_id: doctorB.id }]);
    expect(
      (
        await service
          .from("user_page_permissions")
          .select("page_slug")
          .eq("user_id", otherDoctorB.id)
      ).data?.length,
    ).toBeGreaterThan(0);

    domainClients.session = managerB.client;
    const manager = domainUser(managerB, "manager");
    const managerRoleChange = await changeStaffRoleMutation(manager, {
      staff_id: otherDoctorB.id,
      role: "doctor",
      department_id: ids.department,
      supervising_doctor_ids: [],
    });
    expect(managerRoleChange).toMatchObject({
      ok: false,
      code: "settings.onlyAdminsCanChangeStaffRoles",
    });
    const managerAdminMutation = await setStaffActiveMutation(manager, {
      staff_id: adminB.id,
      is_active: false,
    });
    expect(managerAdminMutation).toMatchObject({
      ok: false,
      code: "settings.onlyAdminsCanManageAdminUsers",
    });
    const managerSelfMutation = await setStaffActiveMutation(manager, {
      staff_id: managerB.id,
      is_active: false,
    });
    expect(managerSelfMutation).toMatchObject({
      ok: false,
      code: "settings.youCannotDeactivateYourOwnAccount",
    });
    const managerNonAdminMutation = await setStaffActiveMutation(manager, {
      staff_id: otherDoctorB.id,
      is_active: false,
    });
    expect(managerNonAdminMutation.ok).toBe(true);

    domainClients.session = adminB.client;
    const restored = await changeStaffRoleMutation(admin, {
      staff_id: otherDoctorB.id,
      role: "doctor",
      department_id: ids.department,
      supervising_doctor_ids: [],
    });
    expect(restored.ok, JSON.stringify(restored)).toBe(true);
    await setStaffActiveMutation(admin, {
      staff_id: otherDoctorB.id,
      is_active: true,
    });
    expect(
      (
        await service
          .from("assistant_doctor_assignments")
          .select("doctor_id")
          .eq("assistant_id", otherDoctorB.id)
      ).data,
    ).toEqual([]);
  });

  it("restores a same-tenant soft-deleted medical note for an admin and its author, but not another doctor", async () => {
    const noteId = randomUUID();
    await mustSucceed(await service.from("medical_notes").insert({
      id: noteId,
      patient_id: ids.patient,
      appointment_id: ids.appointment,
      doctor_id: doctorB.id,
      created_by: doctorB.id,
      note: "Restorable Phase 5 note",
      deleted_at: new Date().toISOString(),
    }), "restorable medical note");

    domainClients.session = adminB.client;
    const adminRestore = await restoreMedicalNoteMutation(
      domainUser(adminB, "admin"),
      { note_id: noteId },
    );
    expect(adminRestore.ok).toBe(true);
    expect((await service.from("medical_notes").select("deleted_at").eq("id", noteId).single()).data?.deleted_at).toBeNull();

    await service.from("medical_notes").update({ deleted_at: new Date().toISOString() }).eq("id", noteId);
    domainClients.session = doctorB.client;
    const authorRestore = await restoreMedicalNoteMutation(
      domainUser(doctorB, "doctor"),
      { note_id: noteId },
    );
    expect(authorRestore.ok).toBe(true);

    await service.from("medical_notes").update({ deleted_at: new Date().toISOString() }).eq("id", noteId);
    domainClients.session = otherDoctorB.client;
    const denied = await restoreMedicalNoteMutation(
      domainUser(otherDoctorB, "doctor"),
      { note_id: noteId },
    );
    expect(denied).toMatchObject({
      ok: false,
      code: "patients.youCanOnlyRestoreYourOwnMedicalNotes",
    });
    expect((await service.from("medical_notes").select("deleted_at").eq("id", noteId).single()).data?.deleted_at).not.toBeNull();
  });

  for (const actor of ["admin", "manager"] as const) {
    it(`deletes every dependent row for same-tenant soft and permanent appointment deletion as ${actor}`, async () => {
      const appointmentId = randomUUID();
      const account = actor === "admin" ? adminB : managerB;
      domainClients.session = account.client;
      await mustSucceed(await service.from("appointments").insert({
        id: appointmentId,
        clinic_id: ids.clinicB,
        patient_id: ids.patient,
        doctor_id: doctorB.id,
        department_id: ids.department,
        scheduled_at: actor === "admin"
          ? "2026-08-20T10:00:00.000Z"
          : "2026-08-20T11:00:00.000Z",
        duration_minutes: 30,
        status: "pending",
        created_by: adminB.id,
      }), `${actor} deletion appointment`);

      async function seedDependents(label: string) {
        await mustSucceed(await service.from("appointment_services").insert({
          appointment_id: appointmentId,
          clinic_id: ids.clinicB,
          name: `${label} service`,
          price: 10,
        }), `${label} appointment service`);
        await mustSucceed(await service.from("feedback").insert({
          appointment_id: appointmentId,
          token: randomUUID(),
          token_expires_at: "2027-08-20T10:00:00.000Z",
        }), `${label} feedback`);
        await mustSucceed(await service.from("follow_ups").insert({
          appointment_id: appointmentId,
          clinic_id: ids.clinicB,
          patient_id: ids.patient,
          outcome: "all_fine",
          recorded_by: adminB.id,
        }), `${label} follow-up`);
        await mustSucceed(await service.from("outstanding_settlements").insert({
          appointment_id: appointmentId,
          clinic_id: ids.clinicB,
          patient_id: ids.patient,
          amount: 10,
          payment_method: "cash",
          created_by: adminB.id,
        }), `${label} settlement`);
      }

      await seedDependents("soft");
      const softDeleted = await softDeleteAppointmentMutation(
        domainUser(account, actor),
        { appointment_id: appointmentId },
      );
      expect(softDeleted.ok).toBe(true);
      for (const table of ["appointment_services", "feedback", "follow_ups", "outstanding_settlements"] as const) {
        expect((await service.from(table).select("id").eq("appointment_id", appointmentId)).data).toEqual([]);
      }

      await seedDependents("permanent");
      const permanentlyDeleted = await permanentDeleteAppointmentMutation(
        domainUser(account, actor),
        { appointment_id: appointmentId },
      );
      expect(
        permanentlyDeleted.ok,
        JSON.stringify(permanentlyDeleted),
      ).toBe(true);
      expect((await service.from("appointments").select("id").eq("id", appointmentId)).data).toEqual([]);
      for (const table of ["appointment_services", "feedback", "follow_ups", "outstanding_settlements"] as const) {
        expect((await service.from(table).select("id").eq("appointment_id", appointmentId)).data).toEqual([]);
      }
    });
  }
});
