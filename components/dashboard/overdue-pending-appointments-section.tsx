import { createClient } from "@/lib/supabase/server";
import { isOverduePending } from "@/lib/appointments/overdue-pending";
import {
  OverduePendingAppointmentsList,
  type OverduePendingAppointmentItem,
} from "@/components/dashboard/overdue-pending-appointments-list";

type OperationalRole = "admin" | "receptionist" | "manager" | "assistant";

export async function OverduePendingAppointmentsSection({
  clinicId,
  currentUserId,
  currentUserRole,
}: {
  clinicId: string;
  currentUserId: string;
  currentUserRole: OperationalRole;
}) {
  const supabase = await createClient();
  const now = new Date();
  const result = await supabase
    .from("appointments")
    .select("id, patient_id, doctor_id, scheduled_at, duration_minutes, status, deleted_at, displaced_at, replaced_by_appointment_id, patients(full_name), profiles!doctor_id(full_name)")
    .eq("clinic_id", clinicId)
    .eq("status", "pending")
    .is("deleted_at", null)
    .is("displaced_at", null)
    .is("replaced_by_appointment_id", null)
    // End-time filtering is completed below; start < now is a bounded superset.
    .lt("scheduled_at", now.toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(100);

  if (result.error) return null;

  const appointments: OverduePendingAppointmentItem[] = (result.data ?? [])
    .filter((appointment) => isOverduePending(appointment, now))
    .map((appointment) => ({
      id: appointment.id,
      patientId: appointment.patient_id,
      doctorId: appointment.doctor_id,
      patientName: appointment.patients?.full_name ?? "—",
      doctorName: appointment.profiles?.full_name ?? "—",
      scheduledAt: appointment.scheduled_at,
      durationMinutes: appointment.duration_minutes,
    }));

  return (
    <OverduePendingAppointmentsList
      appointments={appointments}
      currentUserId={currentUserId}
      currentUserRole={currentUserRole}
    />
  );
}
