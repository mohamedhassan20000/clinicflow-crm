"use server";

import { createClient } from "@/lib/supabase/server";
import { CLINIC_TZ } from "@/lib/datetime";
import { requireRole } from "@/lib/rbac";
import type { Database } from "@/types/database";

type AppointmentStatus = Database["public"]["Enums"]["appointment_status"];

export interface DoctorQueueItem {
  id: string;
  patientId: string;
  patientName: string;
  scheduledAt: string;
  updatedAt: string;
  serviceName: string | null;
  departmentName: string | null;
  status: Extract<AppointmentStatus, "confirmed" | "arrived" | "in_session">;
}

export interface DoctorDashboardQueue {
  inSession: DoctorQueueItem[];
  arrived: DoctorQueueItem[];
  confirmedToday: DoctorQueueItem[];
  confirmedTomorrow: DoctorQueueItem[];
}

export interface DoctorDashboardStats {
  todayAppts: number;
  weekAppts: number;
  monthAppts: number;
  // Period stats (for the selected range)
  myTotal: number;
  myCompleted: number;
  myNoShow: number;
  myCancelled: number;
  myPatients: number;
  myRevenue: number;
  // Department totals (same period)
  deptTotal: number;
  deptCompleted: number;
  deptNoShow: number;
  deptCancelled: number;
  deptPatients: number;
  deptRevenue: number;
  // Clinic totals (same period, for patient share)
  clinicPatients: number;
  // Daily series
  dailySeries: { date: string; mine: number; dept: number }[];
  // Follow-up outcomes for this doctor's patients
  followUpOutcomes: { allFine: number; hasProblem: number; total: number };
}

function buildDateRange(mode: "today" | "week" | "month", tz = CLINIC_TZ) {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();

  if (mode === "today") {
    const start = new Date(y, m, d, 0, 0, 0, 0);
    const end = new Date(y, m, d, 23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  if (mode === "week") {
    const start = new Date(y, m, d - 6, 0, 0, 0, 0);
    const end = new Date(y, m, d, 23, 59, 59, 999);
    return { start: start.toISOString(), end: end.toISOString() };
  }
  // month
  const start = new Date(y, m, 1, 0, 0, 0, 0);
  const end = new Date(y, m + 1, 0, 23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

function buildDayRange(offsetDays: number, tz = CLINIC_TZ) {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate() + offsetDays;
  const start = new Date(y, m, d, 0, 0, 0, 0);
  const end = new Date(y, m, d, 23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

type QueueAppointmentRow = {
  id: string;
  patient_id: string;
  scheduled_at: string;
  updated_at: string;
  status: AppointmentStatus;
  patients: { full_name: string } | { full_name: string }[] | null;
  services: { name: string } | { name: string }[] | null;
  departments: { name: string } | { name: string }[] | null;
};

function firstRelation<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

function toQueueItem(row: QueueAppointmentRow): DoctorQueueItem {
  const patient = firstRelation(row.patients);
  const service = firstRelation(row.services);
  const department = firstRelation(row.departments);

  return {
    id: row.id,
    patientId: row.patient_id,
    patientName: patient?.full_name ?? "Unknown patient",
    scheduledAt: row.scheduled_at,
    updatedAt: row.updated_at,
    serviceName: service?.name ?? null,
    departmentName: department?.name ?? null,
    status: row.status as DoctorQueueItem["status"],
  };
}

export async function fetchDoctorDashboardQueue(): Promise<DoctorDashboardQueue> {
  const user = await requireRole("doctor");
  const supabase = await createClient();

  const today = buildDayRange(0);
  const tomorrow = buildDayRange(1);

  const { data, error } = await supabase
    .from("appointments")
    .select(
      "id, patient_id, scheduled_at, updated_at, status, patients(full_name), services(name), departments(name)",
    )
    .eq("clinic_id", user.clinicId)
    .eq("doctor_id", user.id)
    .is("deleted_at", null)
    .gte("scheduled_at", today.start)
    .lte("scheduled_at", tomorrow.end)
    .in("status", ["confirmed", "arrived", "in_session"]);

  if (error) {
    console.error("[doctor-dashboard] Failed to fetch queue", error);
    return {
      inSession: [],
      arrived: [],
      confirmedToday: [],
      confirmedTomorrow: [],
    };
  }

  const rows = ((data ?? []) as QueueAppointmentRow[]).map(toQueueItem);
  const isToday = (item: DoctorQueueItem) =>
    item.scheduledAt >= today.start && item.scheduledAt <= today.end;
  const isTomorrow = (item: DoctorQueueItem) =>
    item.scheduledAt >= tomorrow.start && item.scheduledAt <= tomorrow.end;
  const byScheduledAsc = (a: DoctorQueueItem, b: DoctorQueueItem) =>
    new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime();
  const byUpdatedDesc = (a: DoctorQueueItem, b: DoctorQueueItem) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();

  return {
    inSession: rows
      .filter((item) => item.status === "in_session" && isToday(item))
      .sort(byUpdatedDesc),
    arrived: rows
      .filter((item) => item.status === "arrived" && isToday(item))
      .sort(byUpdatedDesc),
    confirmedToday: rows
      .filter((item) => item.status === "confirmed" && isToday(item))
      .sort(byScheduledAsc),
    confirmedTomorrow: rows
      .filter((item) => item.status === "confirmed" && isTomorrow(item))
      .sort(byScheduledAsc),
  };
}

export async function fetchDoctorDashboardStats(
  clinicId: string,
  doctorId: string,
  departmentId: string,
  start: string,
  end: string,
): Promise<DoctorDashboardStats> {
  const supabase = await createClient();

  const todayRange = buildDateRange("today");
  const weekRange = buildDateRange("week");
  const monthRange = buildDateRange("month");

  const [
    { count: todayAppts },
    { count: weekAppts },
    { count: monthAppts },
    { data: myAppts },
    { data: deptAppts },
    { data: clinicAppts },
    { data: myFollowUps },
  ] = await Promise.all([
    supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .eq("doctor_id", doctorId)
      .gte("scheduled_at", todayRange.start)
      .lte("scheduled_at", todayRange.end)
      .neq("status", "cancelled"),
    supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .eq("doctor_id", doctorId)
      .gte("scheduled_at", weekRange.start)
      .lte("scheduled_at", weekRange.end)
      .neq("status", "cancelled"),
    supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .eq("doctor_id", doctorId)
      .gte("scheduled_at", monthRange.start)
      .lte("scheduled_at", monthRange.end)
      .neq("status", "cancelled"),
    supabase
      .from("appointments")
      .select("id, scheduled_at, status, patient_id, paid_amount, insurance_amount, secondary_amount")
      .eq("clinic_id", clinicId)
      .eq("doctor_id", doctorId)
      .gte("scheduled_at", start)
      .lte("scheduled_at", end),
    supabase
      .from("appointments")
      .select("id, scheduled_at, status, patient_id, paid_amount, insurance_amount, secondary_amount")
      .eq("clinic_id", clinicId)
      .eq("department_id", departmentId)
      .gte("scheduled_at", start)
      .lte("scheduled_at", end),
    supabase
      .from("appointments")
      .select("patient_id")
      .eq("clinic_id", clinicId)
      .gte("scheduled_at", start)
      .lte("scheduled_at", end),
    supabase
      .from("follow_ups")
      .select("outcome, appointment:appointments!appointment_id(doctor_id)")
      .eq("clinic_id", clinicId)
      .gte("recorded_at", start)
      .lte("recorded_at", end),
  ]);

  // Doctor stats
  const myPatientsSet = new Set<string>();
  let myTotal = 0, myCompleted = 0, myNoShow = 0, myCancelled = 0, myRevenue = 0;
  for (const a of myAppts ?? []) {
    myTotal++;
    myPatientsSet.add(a.patient_id);
    if (a.status === "completed") {
      myCompleted++;
      myRevenue += (a.paid_amount ?? 0) + (a.insurance_amount ?? 0) + (a.secondary_amount ?? 0);
    } else if (a.status === "no_show") myNoShow++;
    else if (a.status === "cancelled") myCancelled++;
  }

  // Dept stats
  const deptPatientsSet = new Set<string>();
  let deptTotal = 0, deptCompleted = 0, deptNoShow = 0, deptCancelled = 0, deptRevenue = 0;
  for (const a of deptAppts ?? []) {
    deptTotal++;
    deptPatientsSet.add(a.patient_id);
    if (a.status === "completed") {
      deptCompleted++;
      deptRevenue += (a.paid_amount ?? 0) + (a.insurance_amount ?? 0) + (a.secondary_amount ?? 0);
    } else if (a.status === "no_show") deptNoShow++;
    else if (a.status === "cancelled") deptCancelled++;
  }

  // Clinic patients
  const clinicPatientsSet = new Set<string>((clinicAppts ?? []).map((a) => a.patient_id));

  // Daily series
  const myByDay = new Map<string, number>();
  const deptByDay = new Map<string, number>();
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);
  const endDate = new Date(end);
  while (current <= endDate) {
    const key = current.toLocaleDateString("en-US", {
      timeZone: CLINIC_TZ,
      month: "short",
      day: "numeric",
    });
    myByDay.set(key, 0);
    deptByDay.set(key, 0);
    current.setDate(current.getDate() + 1);
  }
  for (const a of myAppts ?? []) {
    if (a.status === "cancelled") continue;
    const key = new Date(a.scheduled_at).toLocaleDateString("en-US", {
      timeZone: CLINIC_TZ,
      month: "short",
      day: "numeric",
    });
    if (myByDay.has(key)) myByDay.set(key, (myByDay.get(key) ?? 0) + 1);
  }
  for (const a of deptAppts ?? []) {
    if (a.status === "cancelled") continue;
    const key = new Date(a.scheduled_at).toLocaleDateString("en-US", {
      timeZone: CLINIC_TZ,
      month: "short",
      day: "numeric",
    });
    if (deptByDay.has(key)) deptByDay.set(key, (deptByDay.get(key) ?? 0) + 1);
  }

  const dailySeries = Array.from(myByDay.keys()).map((date) => ({
    date,
    mine: myByDay.get(date) ?? 0,
    dept: deptByDay.get(date) ?? 0,
  }));

  // Follow-up outcomes scoped to this doctor's appointments
  let fuAllFine = 0, fuHasProblem = 0;
  for (const fu of (myFollowUps ?? []) as { outcome: string; appointment: { doctor_id: string } | null }[]) {
    if (fu.appointment?.doctor_id !== doctorId) continue;
    if (fu.outcome === "all_fine") fuAllFine++;
    else if (fu.outcome === "has_problem") fuHasProblem++;
  }
  const followUpOutcomes = { allFine: fuAllFine, hasProblem: fuHasProblem, total: fuAllFine + fuHasProblem };

  return {
    todayAppts: todayAppts ?? 0,
    weekAppts: weekAppts ?? 0,
    monthAppts: monthAppts ?? 0,
    myTotal,
    myCompleted,
    myNoShow,
    myCancelled,
    myPatients: myPatientsSet.size,
    myRevenue,
    deptTotal,
    deptCompleted,
    deptNoShow,
    deptCancelled,
    deptPatients: deptPatientsSet.size,
    deptRevenue,
    clinicPatients: clinicPatientsSet.size,
    dailySeries,
    followUpOutcomes,
  };
}
