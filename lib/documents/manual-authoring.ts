import "server-only";

import type { AuthedUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";

export type PatientDocumentOption = {
  id: string;
  fullName: string;
  fileNumber: string | null;
};

export type InvoiceAuthoringOption = {
  id: string;
  patientId: string;
  patientName: string;
  fileNumber: string | null;
  scheduledAt: string;
  total: number;
  services: { id: string; name: string; unitPrice: number; quantity: number; total: number }[];
};

export async function loadPatientDocumentOptions(
  user: AuthedUser,
): Promise<PatientDocumentOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("patients")
    .select("id, full_name, file_number")
    .eq("clinic_id", user.clinicId)
    .is("deleted_at", null)
    .order("full_name")
    .limit(500);
  if (error) throw new Error(error.message);
  return (data ?? []).map((patient) => ({
    id: patient.id,
    fullName: patient.full_name,
    fileNumber: patient.file_number,
  }));
}

/**
 * Invoice authoring never accepts browser-authored financial facts. The form
 * selects a completed billing record and displays its persisted service rows;
 * the Preview/Issue resolver reads the same rows again through RLS.
 */
export async function loadInvoiceAuthoringOptions(
  user: AuthedUser,
): Promise<InvoiceAuthoringOption[]> {
  const supabase = await createClient();
  const [{ data: appointments, error: appointmentsError }, patients] = await Promise.all([
    supabase
      .from("appointments")
      .select("id, patient_id, scheduled_at, total_amount")
      .eq("clinic_id", user.clinicId)
      .eq("status", "completed")
      .is("deleted_at", null)
      .order("scheduled_at", { ascending: false })
      .limit(200),
    loadPatientDocumentOptions(user),
  ]);
  if (appointmentsError) throw new Error(appointmentsError.message);
  const rows = appointments ?? [];
  if (rows.length === 0) return [];

  const { data: services, error: servicesError } = await supabase
    .from("appointment_services")
    .select("id, appointment_id, name, price, quantity")
    .eq("clinic_id", user.clinicId)
    .in("appointment_id", rows.map((row) => row.id))
    .order("created_at");
  if (servicesError) throw new Error(servicesError.message);

  const patientById = new Map(patients.map((patient) => [patient.id, patient]));
  const servicesByAppointment = new Map<string, InvoiceAuthoringOption["services"]>();
  for (const service of services ?? []) {
    const quantity = Number(service.quantity ?? 1);
    const unitPrice = Number(service.price ?? 0);
    const list = servicesByAppointment.get(service.appointment_id) ?? [];
    list.push({ id: service.id, name: service.name, unitPrice, quantity, total: unitPrice * quantity });
    servicesByAppointment.set(service.appointment_id, list);
  }

  return rows.flatMap((appointment) => {
    const patient = patientById.get(appointment.patient_id);
    if (!patient) return [];
    const appointmentServices = servicesByAppointment.get(appointment.id) ?? [];
    return [{
      id: appointment.id,
      patientId: appointment.patient_id,
      patientName: patient.fullName,
      fileNumber: patient.fileNumber,
      scheduledAt: appointment.scheduled_at,
      total: appointmentServices.length > 0
        ? appointmentServices.reduce((sum, service) => sum + service.total, 0)
        : Number(appointment.total_amount ?? 0),
      services: appointmentServices,
    }];
  });
}
