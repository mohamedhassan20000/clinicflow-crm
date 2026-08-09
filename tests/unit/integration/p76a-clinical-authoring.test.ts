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
const service = createClient<Database>(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
type Client = SupabaseClient<Database>;

const suffix = `p76a-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P76aClinical123!";
const clinicA = randomUUID();
const clinicB = randomUUID();
const patientA = randomUUID();
const appointmentA = randomUUID();
const departmentA = randomUUID();
const userIds: string[] = [];
let adminA: Client;
let doctorA: Client;
let adminB: Client;
let adminAId = "";
let doctorAId = "";
let adminBId = "";

function anonClient(): Client {
  return createClient<Database>(url, publishableKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function createUser(label: string) {
  const email = `${suffix}-${label}@example.com`;
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw created.error ?? new Error("No auth user");
  userIds.push(created.data.user.id);
  const client = anonClient();
  const login = await client.auth.signInWithPassword({ email, password });
  if (login.error) throw login.error;
  return { id: created.data.user.id, client };
}

async function cleanup() {
  await service.from("document_settings").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("lab_requests").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("prescriptions").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("sick_leaves").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("drug_catalog_departments").delete().eq("department_id", departmentA);
  await service.from("lab_test_catalog_departments").delete().eq("department_id", departmentA);
  await service.from("drug_catalog").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("lab_test_catalog").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("medical_notes").delete().eq("patient_id", patientA);
  await service.from("appointments").delete().eq("id", appointmentA);
  await service.from("patients").delete().eq("id", patientA);
  await service.from("departments").delete().eq("id", departmentA);
  await service.from("audit_logs").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("profiles").delete().in("clinic_id", [clinicA, clinicB]);
  await service.from("clinics").delete().in("id", [clinicA, clinicB]);
}

beforeAll(async () => {
  const [a, doctor, b] = await Promise.all([createUser("admin-a"), createUser("doctor-a"), createUser("admin-b")]);
  adminA = a.client; doctorA = doctor.client; adminB = b.client;
  adminAId = a.id; doctorAId = doctor.id; adminBId = b.id;
  await cleanup();
  const clinics = await service.from("clinics").insert([{ id: clinicA, name: `Clinic A ${suffix}` }, { id: clinicB, name: `Clinic B ${suffix}` }]);
  if (clinics.error) throw clinics.error;
  const department = await service.from("departments").insert({ id: departmentA, clinic_id: clinicA, name: "Clinical" });
  if (department.error) throw department.error;
  const profiles = await service.from("profiles").insert([
    { id: adminAId, clinic_id: clinicA, full_name: "Admin A", role: "admin" },
    { id: doctorAId, clinic_id: clinicA, department_id: departmentA, full_name: "Doctor A", role: "doctor", professional_license_no: "LIC-A" },
    { id: adminBId, clinic_id: clinicB, full_name: "Admin B", role: "admin" },
  ]);
  if (profiles.error) throw profiles.error;
  const patient = await service.from("patients").insert({
    id: patientA, clinic_id: clinicA, full_name: "Patient A", date_of_birth: "1990-01-01",
    phone: "+905551112233", email: `${suffix}-patient@example.com`, national_id: `${Date.now()}`,
    file_number: `P-${Date.now()}`, created_by: adminAId, assigned_doctor_id: doctorAId, department_id: departmentA,
  });
  if (patient.error) throw patient.error;
  const appointment = await service.from("appointments").insert({
    id: appointmentA, clinic_id: clinicA, patient_id: patientA, doctor_id: doctorAId,
    department_id: departmentA, scheduled_at: "2026-08-02T09:00:00Z", created_by: adminAId,
  });
  if (appointment.error) throw appointment.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id)));
});

describe("P7-6A clinical authoring foundations", () => {
  it("keeps catalogs tenant-scoped and admin-managed with department relationships", async () => {
    const created = await adminA.from("drug_catalog").insert({ clinic_id: clinicA, name: "Aspirin", is_controlled: false }).select("id").single();
    if (created.error) throw created.error;
    const labCreated = await adminA.from("lab_test_catalog").insert({ clinic_id: clinicA, name: "Complete blood count" }).select("id").single();
    if (labCreated.error) throw labCreated.error;
    const scoped = await adminA.from("drug_catalog_departments").insert({ drug_catalog_id: created.data.id, department_id: departmentA });
    if (scoped.error) throw scoped.error;
    const labScoped = await adminA.from("lab_test_catalog_departments").insert({ lab_test_catalog_id: labCreated.data.id, department_id: departmentA });
    if (labScoped.error) throw labScoped.error;
    const foreign = await adminB.from("drug_catalog").select("id").eq("id", created.data.id);
    if (foreign.error) throw foreign.error;
    expect(foreign.data).toEqual([]);
    const foreignLab = await adminB.from("lab_test_catalog").select("id").eq("id", labCreated.data.id);
    if (foreignLab.error) throw foreignLab.error;
    expect(foreignLab.data).toEqual([]);
    const doctorWrite = await doctorA.from("drug_catalog").insert({ clinic_id: clinicA, name: "Denied" });
    expect(doctorWrite.error).toBeTruthy();
    const doctorLabWrite = await doctorA.from("lab_test_catalog").insert({ clinic_id: clinicA, name: "Denied" });
    expect(doctorLabWrite.error).toBeTruthy();
  });

  it("persists preparer and responsible physician separately, then locks final records", async () => {
    const header = await adminA.from("prescriptions").insert({
      clinic_id: clinicA, created_by: adminAId, responsible_doctor_id: doctorAId,
      patient_id: patientA, appointment_id: appointmentA, status: "draft",
    }).select("id, created_by, responsible_doctor_id").single();
    if (header.error) throw header.error;
    expect(header.data).toMatchObject({ created_by: adminAId, responsible_doctor_id: doctorAId });
    const line = await adminA.from("prescription_medications").insert({ prescription_id: header.data.id, drug_name: "Free text medicine", sort_order: 0 });
    if (line.error) throw line.error;
    const visible = await doctorA.from("prescriptions").select("id").eq("id", header.data.id);
    expect(visible.data).toHaveLength(1);
    const foreign = await adminB.from("prescriptions").select("id").eq("id", header.data.id);
    expect(foreign.data).toEqual([]);
    const finalized = await adminA.from("prescriptions").update({ status: "finalized", finalized_at: new Date().toISOString(), finalized_by: adminAId }).eq("id", header.data.id);
    if (finalized.error) throw finalized.error;
    const locked = await adminA.from("prescription_medications").update({ dose: "Changed" }).eq("prescription_id", header.data.id).select("id");
    expect(locked.error).toBeNull();
    expect(locked.data).toEqual([]);
    const audits = await adminA.from("audit_logs").select("action").eq("table_name", "prescriptions").eq("record_id", header.data.id);
    expect(audits.data?.map((row) => row.action)).toEqual(expect.arrayContaining(["INSERT", "UPDATE"]));
  });

  it("supports external subject snapshots and links medical notes to matching appointments", async () => {
    const external = await adminA.from("lab_requests").insert({
      clinic_id: clinicA, created_by: adminAId, responsible_doctor_id: doctorAId,
      subject_full_name: "External Subject", subject_dob: "1985-05-01", priority: "routine",
    }).select("id").single();
    if (external.error) throw external.error;
    const note = await adminA.from("medical_notes").insert({
      patient_id: patientA, doctor_id: adminAId, created_by: adminAId,
      appointment_id: appointmentA, note: "Appointment-linked note",
    });
    if (note.error) throw note.error;
    const crossTenant = await adminA.from("prescriptions").insert({
      clinic_id: clinicA, created_by: adminAId, responsible_doctor_id: adminBId,
      patient_id: patientA,
    });
    expect(crossTenant.error?.message).toContain("CLINICAL_DOCTOR_SCOPE_VIOLATION");
  });

  it("loads and writes Documents Settings only within the authorized clinic", async () => {
    const [clinicResult, settingsResult, cliniciansResult, drugResult, labResult] =
      await Promise.all([
        adminA.from("clinics").select("name, logo_url, address, phone, email, website, license_no, tax_id, document_footer").eq("id", clinicA).single(),
        adminA.from("document_settings").select("doc_type").eq("clinic_id", clinicA),
        adminA.from("profiles").select("id, professional_license_no, specialty, professional_title, signature_path").eq("clinic_id", clinicA),
        adminA.from("drug_catalog").select("id, is_active").eq("clinic_id", clinicA),
        adminA.from("lab_test_catalog").select("id, is_active").eq("clinic_id", clinicA),
      ]);
    expect([
      clinicResult.error,
      settingsResult.error,
      cliniciansResult.error,
      drugResult.error,
      labResult.error,
    ]).toEqual([null, null, null, null, null]);

    const saved = await adminA.from("document_settings").insert({
      clinic_id: clinicA,
      doc_type: "STAFF_FILE",
      updated_by: adminAId,
    });
    if (saved.error) throw saved.error;

    const foreignRead = await adminB.from("document_settings").select("id").eq("clinic_id", clinicA);
    expect(foreignRead.error).toBeNull();
    expect(foreignRead.data).toEqual([]);

    const doctorWrite = await doctorA.from("document_settings").insert({
      clinic_id: clinicA,
      doc_type: "PATIENT_FILE",
      updated_by: doctorAId,
    });
    expect(doctorWrite.error).toBeTruthy();

    const crossTenantWrite = await adminA.from("document_settings").insert({
      clinic_id: clinicB,
      doc_type: "STAFF_FILE",
      updated_by: adminAId,
    });
    expect(crossTenantWrite.error).toBeTruthy();
  });

  it("persists the Patient AI auto reply mode across a database reload", async () => {
    const saved = await service.from("clinics")
      .update({ ai_reply_mode: "auto" })
      .eq("id", clinicA)
      .select("ai_reply_mode")
      .single();
    if (saved.error) throw saved.error;
    expect(saved.data.ai_reply_mode).toBe("auto");

    const reloaded = await service.from("clinics")
      .select("ai_reply_mode")
      .eq("id", clinicA)
      .single();
    if (reloaded.error) throw reloaded.error;
    expect(reloaded.data.ai_reply_mode).toBe("auto");
  });

  it("allows frozen clinical records to finalize and void after doctor or patient deactivation", async () => {
    const doctorLifecycle = await adminA.from("prescriptions").insert({
      clinic_id: clinicA, created_by: adminAId, responsible_doctor_id: doctorAId,
      patient_id: patientA, status: "draft",
    }).select("id").single();
    if (doctorLifecycle.error) throw doctorLifecycle.error;

    const deactivateDoctor = await service.from("profiles").update({ is_active: false }).eq("id", doctorAId);
    if (deactivateDoctor.error) throw deactivateDoctor.error;

    const finalizeAfterDoctorDeactivation = await adminA.from("prescriptions").update({
      status: "finalized", finalized_at: new Date().toISOString(), finalized_by: adminAId,
    }).eq("id", doctorLifecycle.data.id);
    if (finalizeAfterDoctorDeactivation.error) throw finalizeAfterDoctorDeactivation.error;
    const voidAfterDoctorDeactivation = await adminA.from("prescriptions")
      .update({ status: "void" })
      .eq("id", doctorLifecycle.data.id);
    if (voidAfterDoctorDeactivation.error) throw voidAfterDoctorDeactivation.error;

    const inactiveDoctorInsert = await adminA.from("lab_requests").insert({
      clinic_id: clinicA, created_by: adminAId, responsible_doctor_id: doctorAId,
      subject_full_name: "New External Subject", priority: "routine",
    });
    expect(inactiveDoctorInsert.error?.message).toContain("CLINICAL_DOCTOR_SCOPE_VIOLATION");

    const reactivateDoctor = await service.from("profiles").update({ is_active: true }).eq("id", doctorAId);
    if (reactivateDoctor.error) throw reactivateDoctor.error;

    const patientLifecycle = await adminA.from("prescriptions").insert({
      clinic_id: clinicA, created_by: adminAId, responsible_doctor_id: doctorAId,
      patient_id: patientA, status: "draft",
    }).select("id").single();
    if (patientLifecycle.error) throw patientLifecycle.error;

    const softDeletePatient = await service.from("patients").update({
      is_deleted: true, updated_by: adminAId,
    }).eq("id", patientA);
    if (softDeletePatient.error) throw softDeletePatient.error;

    const finalizeAfterPatientDeletion = await adminA.from("prescriptions").update({
      status: "finalized", finalized_at: new Date().toISOString(), finalized_by: adminAId,
    }).eq("id", patientLifecycle.data.id);
    if (finalizeAfterPatientDeletion.error) throw finalizeAfterPatientDeletion.error;
    const voidAfterPatientDeletion = await adminA.from("prescriptions")
      .update({ status: "void" })
      .eq("id", patientLifecycle.data.id);
    if (voidAfterPatientDeletion.error) throw voidAfterPatientDeletion.error;

    const deletedPatientInsert = await adminA.from("prescriptions").insert({
      clinic_id: clinicA, created_by: adminAId, responsible_doctor_id: doctorAId,
      patient_id: patientA, status: "draft",
    });
    expect(deletedPatientInsert.error?.message).toContain("CLINICAL_PATIENT_SCOPE_VIOLATION");

    const statuses = await service.from("prescriptions")
      .select("id, status")
      .in("id", [doctorLifecycle.data.id, patientLifecycle.data.id]);
    if (statuses.error) throw statuses.error;
    expect(statuses.data).toEqual(expect.arrayContaining([
      { id: doctorLifecycle.data.id, status: "void" },
      { id: patientLifecycle.data.id, status: "void" },
    ]));
  });
});
