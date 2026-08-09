import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
const service = createClient<Database>(url, secretKey, { auth: { autoRefreshToken: false, persistSession: false } });
const suffix = `p76-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clinicId = randomUUID(); const patientId = randomUUID(); const appointmentId = randomUUID();
let adminId = ""; let doctorId = ""; let prescriptionId = ""; let documentId = "";
let admin: SupabaseClient<Database>;

async function cleanup() {
  await service.from("document_events").delete().eq("clinic_id", clinicId);
  await service.from("documents").delete().eq("clinic_id", clinicId);
  await service.from("document_counters").delete().eq("clinic_id", clinicId);
  await service.from("prescription_medications").delete().eq("prescription_id", prescriptionId || randomUUID());
  await service.from("prescriptions").delete().eq("clinic_id", clinicId);
  await service.from("appointments").delete().eq("clinic_id", clinicId);
  await service.from("patients").delete().eq("clinic_id", clinicId);
  await service.from("profiles").delete().eq("clinic_id", clinicId);
  await service.from("clinics").delete().eq("id", clinicId);
}

beforeAll(async () => {
  const password = "P76Document12345!";
  const [adminUser, doctorUser] = await Promise.all([
    service.auth.admin.createUser({ email: `${suffix}-admin@example.com`, password, email_confirm: true }),
    service.auth.admin.createUser({ email: `${suffix}-doctor@example.com`, password, email_confirm: true }),
  ]);
  if (!adminUser.data.user || adminUser.error) throw adminUser.error;
  if (!doctorUser.data.user || doctorUser.error) throw doctorUser.error;
  adminId = adminUser.data.user.id; doctorId = doctorUser.data.user.id;
  const login = createClient<Database>(url, publishableKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const session = await login.auth.signInWithPassword({ email: `${suffix}-admin@example.com`, password });
  if (session.error) throw session.error;
  admin = createClient<Database>(url, publishableKey, { auth: { autoRefreshToken: false, persistSession: false } });
  await admin.auth.setSession({ access_token: session.data.session!.access_token, refresh_token: session.data.session!.refresh_token });
  await cleanup();
  const clinic = await service.from("clinics").insert({ id: clinicId, name: `P76 Clinic ${suffix}` });
  if (clinic.error) throw clinic.error;
  const profiles = await service.from("profiles").insert([
    { id: adminId, clinic_id: clinicId, full_name: "P76 Admin", role: "admin" },
    { id: doctorId, clinic_id: clinicId, full_name: "Dr P76", role: "doctor",
      professional_license_no: "MD-P76", specialty: "Internal medicine" },
  ]); if (profiles.error) throw profiles.error;
  const patient = await service.from("patients").insert({ id: patientId, clinic_id: clinicId,
    created_by: adminId, full_name: "P76 Patient", date_of_birth: "1990-01-01",
    email: `${suffix}-patient@example.com`, phone: "+96550000000", file_number: `P76-${Date.now()}`,
    national_id: `${Date.now()}` }); if (patient.error) throw patient.error;
  const appointment = await service.from("appointments").insert({ id: appointmentId, clinic_id: clinicId,
    patient_id: patientId, doctor_id: doctorId, created_by: adminId,
    scheduled_at: "2026-08-02T09:00:00.000Z" }); if (appointment.error) throw appointment.error;
  const prescription = await service.from("prescriptions").insert({ clinic_id: clinicId, created_by: adminId,
    responsible_doctor_id: doctorId, patient_id: patientId, appointment_id: appointmentId,
    status: "draft" }).select("id").single(); if (prescription.error) throw prescription.error;
  prescriptionId = prescription.data.id;
  const medication = await service.from("prescription_medications").insert({ prescription_id: prescriptionId,
    drug_name: "Amoxicillin 500mg", dose: "1 capsule", is_controlled_snapshot: false });
  if (medication.error) throw medication.error;
  const finalized = await service.from("prescriptions").update({ status: "finalized",
    finalized_at: new Date().toISOString(), finalized_by: adminId }).eq("id", prescriptionId);
  if (finalized.error) throw finalized.error;
  const snapshot = { version: 1, documentType: "PRESCRIPTION", sourceRecordId: prescriptionId,
    physician: { id: doctorId, professionalLicenseNo: "MD-P76" }, medications: [{ isControlled: false }] };
  const reserved = await service.rpc("reserve_document_issue", { p_clinic_id: clinicId, p_actor_id: adminId,
    p_doc_type: "PRESCRIPTION", p_idempotency_key: `${suffix}:prescription`, p_locale: "en",
    p_numbering_prefix: "RX", p_period_key: "2026", p_sequence_padding: 4,
    p_params: { recordId: prescriptionId }, p_snapshot: snapshot, p_watermark_snapshot: null,
    p_patient_id: patientId, p_doctor_id: doctorId, p_appointment_id: appointmentId });
  if (reserved.error) throw reserved.error; documentId = reserved.data[0].document_id;
  const completed = await service.rpc("complete_document_issue", { p_clinic_id: clinicId, p_actor_id: adminId,
    p_document_id: documentId, p_pdf_storage_path: `documents/${clinicId}/PRESCRIPTION/${documentId}.pdf`, p_page_count: 1 });
  if (completed.error) throw completed.error;
}, 60_000);

afterAll(async () => { await cleanup(); if (adminId) await service.auth.admin.deleteUser(adminId); if (doctorId) await service.auth.admin.deleteUser(doctorId); });

describe("P7-6 clinical document database lifecycle", () => {
  it("reprints the canonical clinical PDF without changing its immutable source snapshot", async () => {
    const before = await service.from("documents").select("snapshot, document_number").eq("id", documentId).single();
    if (before.error) throw before.error;
    const result = await admin.rpc("record_clinical_document_reprint", { p_document_id: documentId });
    if (result.error) throw result.error;
    expect(result.data[0]).toMatchObject({ pdf_storage_path: `documents/${clinicId}/PRESCRIPTION/${documentId}.pdf`,
      document_number: before.data.document_number, print_count: 1 });
    const [after, events] = await Promise.all([
      service.from("documents").select("snapshot, print_count").eq("id", documentId).single(),
      service.from("document_events").select("event").eq("document_id", documentId).order("occurred_at"),
    ]);
    if (after.error) throw after.error; if (events.error) throw events.error;
    expect(after.data.snapshot).toEqual(before.data.snapshot); expect(after.data.print_count).toBe(1);
    expect(events.data.map((event) => event.event)).toEqual(["issued", "reprinted"]);
  });
});
