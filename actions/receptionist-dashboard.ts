"use server";

import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import type { Database } from "@/types/database";

type AppointmentStatus = Database["public"]["Enums"]["appointment_status"];

export interface ReceptionInSessionItem {
  id: string;
  patientId: string;
  patientName: string;
  doctorName: string | null;
  serviceName: string | null;
  scheduledAt: string;
  updatedAt: string;
  sessionStartedAt: string;
  status: Extract<AppointmentStatus, "in_session">;
}

export interface ReceptionInSessionGroup {
  departmentId: string | null;
  departmentName: string;
  items: ReceptionInSessionItem[];
}

type ReceptionInSessionRow = {
  id: string;
  patient_id: string;
  scheduled_at: string;
  updated_at: string;
  status: AppointmentStatus;
  department_id: string | null;
  patients: { full_name: string } | { full_name: string }[] | null;
  profiles: { full_name: string } | { full_name: string }[] | null;
  services: { name: string } | { name: string }[] | null;
  departments: { name: string } | { name: string }[] | null;
};

function firstRelation<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

export async function fetchReceptionInSessionBoard(): Promise<ReceptionInSessionGroup[]> {
  const user = await requireRole(["admin", "receptionist"]);
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("appointments")
    .select(
      "id, patient_id, scheduled_at, updated_at, status, department_id, patients(full_name), profiles!doctor_id(full_name), services(name), departments(name)",
    )
    .eq("clinic_id", user.clinicId)
    .is("deleted_at", null)
    .eq("status", "in_session")
    .order("updated_at", { ascending: true });

  if (error) {
    console.error("[receptionist-dashboard] Failed to fetch in-session board", error);
    return [];
  }

  const grouped = new Map<string, ReceptionInSessionGroup>();

  for (const row of (data ?? []) as ReceptionInSessionRow[]) {
    const patient = firstRelation(row.patients);
    const doctor = firstRelation(row.profiles);
    const service = firstRelation(row.services);
    const department = firstRelation(row.departments);
    const departmentKey = row.department_id ?? "__unassigned__";

    if (!grouped.has(departmentKey)) {
      grouped.set(departmentKey, {
        departmentId: row.department_id,
        departmentName: department?.name ?? "Unassigned department",
        items: [],
      });
    }

    grouped.get(departmentKey)?.items.push({
      id: row.id,
      patientId: row.patient_id,
      patientName: patient?.full_name ?? "Unknown patient",
      doctorName: doctor?.full_name ?? null,
      serviceName: service?.name ?? null,
      scheduledAt: row.scheduled_at,
      updatedAt: row.updated_at,
      sessionStartedAt: row.updated_at,
      status: "in_session",
    });
  }

  return Array.from(grouped.values())
    .map((group) => ({
      ...group,
      items: group.items.sort(
        (a, b) =>
          new Date(a.sessionStartedAt).getTime() -
          new Date(b.sessionStartedAt).getTime(),
      ),
    }))
    .sort((a, b) => a.departmentName.localeCompare(b.departmentName));
}
