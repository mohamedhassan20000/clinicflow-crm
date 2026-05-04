"use server";

import { createClient } from "@/lib/supabase/server";

export interface DoctorStat {
  name: string;
  total: number;
  confirmed: number;
  cancelled: number;
  other: number;
  revenue: number;
}

export async function fetchInsuranceBreakdown(
  clinicId: string,
  start: string,
  end: string,
): Promise<{ name: string; value: number }[]> {
  const supabase = await createClient();

  const { data } = await supabase
    .from("appointments")
    .select("insurance_provider_id, insurance_providers(name)")
    .eq("clinic_id", clinicId)
    .gte("scheduled_at", start)
    .lte("scheduled_at", end);

  const map = new Map<string, number>();
  for (const a of data ?? []) {
    const raw = a.insurance_providers as { name: string } | null;
    const name = raw?.name ?? "No insurance";
    map.set(name, (map.get(name) ?? 0) + 1);
  }

  return Array.from(map.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
}

export async function fetchDoctorStats(
  clinicId: string,
  start: string,
  end: string,
): Promise<DoctorStat[]> {
  const supabase = await createClient();

  const [{ data: doctors }, { data: appts }] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name")
      .eq("clinic_id", clinicId)
      .eq("role", "doctor")
      .eq("is_active", true),
    supabase
      .from("appointments")
      .select("doctor_id, status, paid_amount, insurance_amount, secondary_amount")
      .eq("clinic_id", clinicId)
      .gte("scheduled_at", start)
      .lte("scheduled_at", end),
  ]);

  const statsMap = new Map<string, DoctorStat>();
  for (const doc of doctors ?? []) {
    statsMap.set(doc.id, {
      name: doc.full_name,
      total: 0,
      confirmed: 0,
      cancelled: 0,
      other: 0,
      revenue: 0,
    });
  }

  for (const a of appts ?? []) {
    const entry = statsMap.get(a.doctor_id);
    if (!entry) continue;
    entry.total++;
    if (a.status === "confirmed") entry.confirmed++;
    else if (a.status === "cancelled") entry.cancelled++;
    else entry.other++;
    if (a.status === "completed") {
      entry.revenue +=
        (a.paid_amount ?? 0) +
        (a.insurance_amount ?? 0) +
        (a.secondary_amount ?? 0);
    }
  }

  return Array.from(statsMap.values()).sort((a, b) => b.total - a.total);
}

export interface DepartmentStat {
  name: string;
  appointments: number;
  patients: number;
  revenue: number;
}

export async function fetchDepartmentStats(
  clinicId: string,
  start: string,
  end: string,
): Promise<DepartmentStat[]> {
  const supabase = await createClient();

  const [{ data: departments }, { data: appts }] = await Promise.all([
    supabase
      .from("departments")
      .select("id, name")
      .eq("clinic_id", clinicId)
      .eq("is_active", true),
    supabase
      .from("appointments")
      .select("department_id, patient_id, status, paid_amount, insurance_amount, secondary_amount")
      .eq("clinic_id", clinicId)
      .gte("scheduled_at", start)
      .lte("scheduled_at", end),
  ]);

  const statsMap = new Map<string, DepartmentStat>();
  const patientSets = new Map<string, Set<string>>();

  for (const dept of departments ?? []) {
    statsMap.set(dept.id, { name: dept.name, appointments: 0, patients: 0, revenue: 0 });
    patientSets.set(dept.id, new Set());
  }

  for (const a of appts ?? []) {
    if (!a.department_id) continue;
    const entry = statsMap.get(a.department_id);
    const pset = patientSets.get(a.department_id);
    if (!entry || !pset) continue;
    entry.appointments++;
    pset.add(a.patient_id);
    if (a.status === "completed") {
      entry.revenue +=
        (a.paid_amount ?? 0) +
        (a.insurance_amount ?? 0) +
        (a.secondary_amount ?? 0);
    }
  }

  for (const [id, pset] of patientSets) {
    const entry = statsMap.get(id);
    if (entry) entry.patients = pset.size;
  }

  return Array.from(statsMap.values()).sort((a, b) => b.appointments - a.appointments);
}

export interface ReceptionistStat {
  name: string;
  total: number;
  confirmed: number;
  cancelled: number;
  other: number;
}

export async function fetchReceptionistStats(
  clinicId: string,
  start: string,
  end: string,
): Promise<ReceptionistStat[]> {
  const supabase = await createClient();

  const [{ data: receptionists }, { data: appts }] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name")
      .eq("clinic_id", clinicId)
      .eq("role", "receptionist")
      .eq("is_active", true),
    supabase
      .from("appointments")
      .select("created_by, status")
      .eq("clinic_id", clinicId)
      .gte("scheduled_at", start)
      .lte("scheduled_at", end),
  ]);

  const statsMap = new Map<string, ReceptionistStat>();
  for (const r of receptionists ?? []) {
    statsMap.set(r.id, { name: r.full_name, total: 0, confirmed: 0, cancelled: 0, other: 0 });
  }

  for (const a of appts ?? []) {
    if (!a.created_by) continue;
    const entry = statsMap.get(a.created_by);
    if (!entry) continue;
    entry.total++;
    if (a.status === "confirmed") entry.confirmed++;
    else if (a.status === "cancelled") entry.cancelled++;
    else entry.other++;
  }

  return Array.from(statsMap.values()).sort((a, b) => b.total - a.total);
}

export interface FollowUpOutcomes {
  allFine: number;
  hasProblem: number;
  total: number;
}

export async function fetchFollowUpOutcomes(
  clinicId: string,
  start: string,
  end: string,
  departmentId?: string | null,
  doctorId?: string | null,
): Promise<FollowUpOutcomes> {
  const supabase = await createClient();

  let apptIds: string[] | null = null;
  if (departmentId || doctorId) {
    let apptQ = supabase.from("appointments").select("id").eq("clinic_id", clinicId);
    if (departmentId) apptQ = apptQ.eq("department_id", departmentId);
    if (doctorId) apptQ = apptQ.eq("doctor_id", doctorId);
    const { data: appts } = await apptQ;
    apptIds = (appts ?? []).map((a) => a.id);
  }

  if (apptIds !== null && apptIds.length === 0) {
    return { allFine: 0, hasProblem: 0, total: 0 };
  }

  let fuQ = supabase
    .from("follow_ups")
    .select("outcome")
    .eq("clinic_id", clinicId)
    .gte("recorded_at", start)
    .lte("recorded_at", end);

  if (apptIds !== null) {
    fuQ = fuQ.in("appointment_id", apptIds);
  }

  const { data } = await fuQ;

  let allFine = 0;
  let hasProblem = 0;
  for (const fu of data ?? []) {
    if (fu.outcome === "all_fine") allFine++;
    else if (fu.outcome === "has_problem") hasProblem++;
  }

  return { allFine, hasProblem, total: (data ?? []).length };
}

export async function fetchAppointmentsSeries(
  clinicId: string,
  start: string,
  end: string,
): Promise<{ date: string; appointments: number }[]> {
  const supabase = await createClient();

  const { data } = await supabase
    .from("appointments")
    .select("scheduled_at")
    .eq("clinic_id", clinicId)
    .gte("scheduled_at", start)
    .lte("scheduled_at", end)
    .not("status", "eq", "cancelled");

  const map = new Map<string, number>();
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);
  const endDate = new Date(end);

  while (current <= endDate) {
    const key = current.toLocaleDateString("en-US", {
      timeZone: "Europe/Istanbul",
      month: "short",
      day: "numeric",
    });
    map.set(key, 0);
    current.setDate(current.getDate() + 1);
  }

  for (const a of data ?? []) {
    const key = new Date(a.scheduled_at).toLocaleDateString("en-US", {
      timeZone: "Europe/Istanbul",
      month: "short",
      day: "numeric",
    });
    if (map.has(key)) map.set(key, (map.get(key) ?? 0) + 1);
  }

  return Array.from(map.entries()).map(([date, appointments]) => ({
    date,
    appointments,
  }));
}
