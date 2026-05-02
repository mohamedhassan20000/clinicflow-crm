import type { Metadata } from "next";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { AdminDashboard } from "@/components/dashboard/admin-dashboard";
import { ReceptionistDashboard } from "@/components/dashboard/receptionist-dashboard";
import { ManagerDashboard } from "@/components/dashboard/manager-dashboard";

export const metadata: Metadata = { title: "Dashboard" };

// ── Date helpers (Europe/Istanbul) ──────────────────────────────────────────

function toIstanbul(date: Date): Date {
  // Shift to Istanbul time so midnight comparisons are correct
  return new Date(
    date.toLocaleString("en-US", { timeZone: "Europe/Istanbul" }),
  );
}

function todayBounds() {
  const now = toIstanbul(new Date());
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

function weekBounds() {
  const now = toIstanbul(new Date());
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const mon = new Date(now);
  mon.setDate(mon.getDate() + diff);
  mon.setHours(0, 0, 0, 0);
  const sun = new Date(mon);
  sun.setDate(sun.getDate() + 7);
  return { start: mon.toISOString(), end: sun.toISOString() };
}

function monthBounds(offset = 0) {
  const now = toIstanbul(new Date());
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0, 23, 59, 59);
  return { start: start.toISOString(), end: end.toISOString() };
}

function nextNHoursBounds(hours: number) {
  const now = new Date();
  const end = new Date(now.getTime() + hours * 60 * 60 * 1000);
  return { start: now.toISOString(), end: end.toISOString() };
}

function last30DaysBounds() {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 29);
  start.setHours(0, 0, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
}

// ── Aggregate helpers ────────────────────────────────────────────────────────

function buildDailySeries(
  appointments: { scheduled_at: string }[],
): { date: string; appointments: number }[] {
  const map = new Map<string, number>();
  // Pre-fill 30 days
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toLocaleDateString("en-US", {
      timeZone: "Europe/Istanbul",
      month: "short",
      day: "numeric",
    });
    map.set(key, 0);
  }
  for (const a of appointments) {
    const key = new Date(a.scheduled_at).toLocaleDateString("en-US", {
      timeZone: "Europe/Istanbul",
      month: "short",
      day: "numeric",
    });
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return Array.from(map.entries()).map(([date, appointments]) => ({
    date,
    appointments,
  }));
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const user = await requireUser();
  const supabase = await createClient();
  const clinicId = user.clinicId;

  if (user.role === "admin") {
    const today = todayBounds();
    const week = weekBounds();
    const thisMonth = monthBounds(0);
    const lastMonth = monthBounds(-1);
    const next7Start = new Date();
    next7Start.setDate(next7Start.getDate() + 1);
    next7Start.setHours(0, 0, 0, 0);
    const next7End = new Date();
    next7End.setDate(next7End.getDate() + 8);

    // 6 months of history (offset -1 … -6) for the revenue widget
    const priorMonthRanges = Array.from({ length: 6 }, (_, i) =>
      monthBounds(-(i + 1)),
    );
    const earliestPriorStart =
      priorMonthRanges[priorMonthRanges.length - 1].start;

    const [
      { count: todayCount },
      { count: weekCount },
      { count: thisMonthCount },
      { count: lastMonthCount },
      { count: totalPatients },
      { count: pendingCount },
      { data: todayAppts },
      { data: upcomingAppts },
      { data: revenueRows },
      { data: outstandingRows },
    ] = await Promise.all([
      supabase
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("clinic_id", clinicId)
        .gte("scheduled_at", today.start)
        .lte("scheduled_at", today.end),
      supabase
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("clinic_id", clinicId)
        .gte("scheduled_at", week.start)
        .lt("scheduled_at", week.end),
      supabase
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("clinic_id", clinicId)
        .gte("scheduled_at", thisMonth.start)
        .lte("scheduled_at", thisMonth.end),
      supabase
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("clinic_id", clinicId)
        .gte("scheduled_at", lastMonth.start)
        .lte("scheduled_at", lastMonth.end),
      supabase
        .from("patients")
        .select("id", { count: "exact", head: true })
        .eq("clinic_id", clinicId)
        .eq("is_deleted", false),
      supabase
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("clinic_id", clinicId)
        .eq("status", "pending"),
      supabase
        .from("appointments")
        .select("*, patients(full_name), profiles!doctor_id(full_name)")
        .eq("clinic_id", clinicId)
        .gte("scheduled_at", today.start)
        .lte("scheduled_at", today.end)
        .order("scheduled_at"),
      supabase
        .from("appointments")
        .select("*, patients(full_name), profiles!doctor_id(full_name)")
        .eq("clinic_id", clinicId)
        .gte("scheduled_at", next7Start.toISOString())
        .lt("scheduled_at", next7End.toISOString())
        .eq("status", "pending")
        .order("scheduled_at")
        .limit(8),
      // Completed revenue across the last 6 months + current month for the widget
      supabase
        .from("appointments")
        .select("paid_at, paid_amount, insurance_amount, secondary_amount")
        .eq("clinic_id", clinicId)
        .eq("status", "completed")
        .gte("paid_at", earliestPriorStart),
      // Outstanding balances (pay-later rows)
      supabase
        .from("appointments")
        .select("outstanding_amount")
        .eq("clinic_id", clinicId)
        .gt("outstanding_amount", 0),
    ]);

    // ── Revenue aggregation ──────────────────────────────────────────────
    type RevenueRow = {
      paid_at: string | null;
      paid_amount: number | null;
      insurance_amount: number | null;
      secondary_amount: number | null;
    };
    const rows = (revenueRows ?? []) as RevenueRow[];
    const sumInRange = (start: string, end: string) =>
      rows.reduce((acc, r) => {
        if (!r.paid_at) return acc;
        if (r.paid_at < start || r.paid_at > end) return acc;
        return (
          acc +
          (r.paid_amount ?? 0) +
          (r.insurance_amount ?? 0) +
          (r.secondary_amount ?? 0)
        );
      }, 0);

    const revenueToday = sumInRange(today.start, today.end);
    const revenueWeek = sumInRange(week.start, week.end);
    const revenueThisMonth = sumInRange(thisMonth.start, thisMonth.end);
    const revenueLastMonth = sumInRange(lastMonth.start, lastMonth.end);

    const priorMonths = priorMonthRanges.map(({ start, end }) => ({
      label: new Date(start).toLocaleDateString("en-US", {
        timeZone: "Europe/Istanbul",
        month: "short",
      }),
      amount: sumInRange(start, end),
    }));

    const outstandingTotal = (outstandingRows ?? []).reduce(
      (acc, r) => acc + (r.outstanding_amount ?? 0),
      0,
    );

    return (
      <AdminDashboard
        fullName={user.fullName}
        todayCount={todayCount ?? 0}
        weekCount={weekCount ?? 0}
        thisMonthCount={thisMonthCount ?? 0}
        lastMonthCount={lastMonthCount ?? 0}
        totalPatients={totalPatients ?? 0}
        pendingCount={pendingCount ?? 0}
        todayAppointments={(todayAppts ?? []) as Parameters<typeof AdminDashboard>[0]["todayAppointments"]}
        upcomingAppointments={(upcomingAppts ?? []) as Parameters<typeof AdminDashboard>[0]["upcomingAppointments"]}
        revenue={{
          today: revenueToday,
          week: revenueWeek,
          month: revenueThisMonth,
          lastMonth: revenueLastMonth,
          priorMonths,
          outstanding: outstandingTotal,
        }}
      />
    );
  }

  if (user.role === "receptionist") {
    const today = todayBounds();
    const next2h = nextNHoursBounds(2);

    const [
      { count: todayCount },
      { count: pendingCount },
      { count: confirmedCount },
      { data: todayAppts },
      { data: pendingAppts },
      { data: next2hAppts },
    ] = await Promise.all([
      supabase
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("clinic_id", clinicId)
        .gte("scheduled_at", today.start)
        .lte("scheduled_at", today.end),
      supabase
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("clinic_id", clinicId)
        .eq("status", "pending"),
      supabase
        .from("appointments")
        .select("id", { count: "exact", head: true })
        .eq("clinic_id", clinicId)
        .eq("status", "confirmed")
        .gte("scheduled_at", today.start)
        .lte("scheduled_at", today.end),
      supabase
        .from("appointments")
        .select("*, patients(full_name), profiles!doctor_id(full_name)")
        .eq("clinic_id", clinicId)
        .gte("scheduled_at", today.start)
        .lte("scheduled_at", today.end)
        .order("scheduled_at"),
      supabase
        .from("appointments")
        .select("*, patients(full_name), profiles!doctor_id(full_name)")
        .eq("clinic_id", clinicId)
        .eq("status", "pending")
        .order("scheduled_at")
        .limit(20),
      supabase
        .from("appointments")
        .select("*, patients(full_name), profiles!doctor_id(full_name)")
        .eq("clinic_id", clinicId)
        .gte("scheduled_at", next2h.start)
        .lte("scheduled_at", next2h.end)
        .not("status", "in", '("cancelled","completed")')
        .order("scheduled_at"),
    ]);

    return (
      <ReceptionistDashboard
        fullName={user.fullName}
        todayCount={todayCount ?? 0}
        pendingCount={pendingCount ?? 0}
        confirmedCount={confirmedCount ?? 0}
        todayAppointments={(todayAppts ?? []) as Parameters<typeof ReceptionistDashboard>[0]["todayAppointments"]}
        pendingAppointments={(pendingAppts ?? []) as Parameters<typeof ReceptionistDashboard>[0]["pendingAppointments"]}
        nextTwoHoursAppointments={(next2hAppts ?? []) as Parameters<typeof ReceptionistDashboard>[0]["nextTwoHoursAppointments"]}
      />
    );
  }

  // Manager
  const today = todayBounds();
  const week = weekBounds();
  const thisMonth = monthBounds(0);
  const last30 = last30DaysBounds();

  const [
    { count: todayCount },
    { count: weekCount },
    { count: monthCount },
    { count: totalPatients },
    { count: noShowCount },
    { count: cancelCount },
    { data: last30Appts },
    { data: insuranceAppts },
    { data: allDoctorProfiles },
    { data: doctorAppts },
    { data: allDepartments },
  ] = await Promise.all([
    supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .gte("scheduled_at", today.start)
      .lte("scheduled_at", today.end),
    supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .gte("scheduled_at", week.start)
      .lt("scheduled_at", week.end),
    supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .gte("scheduled_at", thisMonth.start)
      .lte("scheduled_at", thisMonth.end),
    supabase
      .from("patients")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .eq("is_deleted", false),
    supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .eq("status", "no_show")
      .gte("scheduled_at", thisMonth.start)
      .lte("scheduled_at", thisMonth.end),
    supabase
      .from("appointments")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId)
      .eq("status", "cancelled")
      .gte("scheduled_at", thisMonth.start)
      .lte("scheduled_at", thisMonth.end),
    supabase
      .from("appointments")
      .select("scheduled_at")
      .eq("clinic_id", clinicId)
      .gte("scheduled_at", last30.start)
      .lte("scheduled_at", last30.end)
      .not("status", "eq", "cancelled"),
    supabase
      .from("appointments")
      .select("insurance_provider_id, insurance_providers(name)")
      .eq("clinic_id", clinicId)
      .gte("scheduled_at", thisMonth.start)
      .lte("scheduled_at", thisMonth.end),
    supabase
      .from("profiles")
      .select("id, full_name")
      .eq("clinic_id", clinicId)
      .eq("role", "doctor")
      .eq("is_active", true),
    supabase
      .from("appointments")
      .select("doctor_id, department_id, patient_id, status, paid_amount, insurance_amount, secondary_amount")
      .eq("clinic_id", clinicId)
      .gte("scheduled_at", thisMonth.start)
      .lte("scheduled_at", thisMonth.end),
    supabase
      .from("departments")
      .select("id, name")
      .eq("clinic_id", clinicId)
      .eq("is_active", true),
  ]);

  // Build insurance breakdown
  const insuranceMap = new Map<string, number>();
  for (const a of insuranceAppts ?? []) {
    const raw = a.insurance_providers as { name: string } | null;
    const name = raw?.name ?? "No insurance";
    insuranceMap.set(name, (insuranceMap.get(name) ?? 0) + 1);
  }
  const initialInsuranceSeries = Array.from(insuranceMap.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  // Build doctor stats — all doctors, including those with 0 appointments
  const doctorStatsMap = new Map<
    string,
    { name: string; total: number; confirmed: number; cancelled: number; other: number; revenue: number }
  >();
  for (const doc of allDoctorProfiles ?? []) {
    doctorStatsMap.set(doc.id, {
      name: doc.full_name,
      total: 0,
      confirmed: 0,
      cancelled: 0,
      other: 0,
      revenue: 0,
    });
  }
  for (const a of doctorAppts ?? []) {
    const entry = doctorStatsMap.get(a.doctor_id);
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
  const initialDoctors = Array.from(doctorStatsMap.values()).sort(
    (a, b) => b.total - a.total,
  );

  // Build department stats
  const deptStatsMap = new Map<
    string,
    { name: string; appointments: number; patients: number; revenue: number }
  >();
  const deptPatientSets = new Map<string, Set<string>>();
  for (const dept of allDepartments ?? []) {
    deptStatsMap.set(dept.id, { name: dept.name, appointments: 0, patients: 0, revenue: 0 });
    deptPatientSets.set(dept.id, new Set());
  }
  for (const a of doctorAppts ?? []) {
    if (!a.department_id) continue;
    const entry = deptStatsMap.get(a.department_id);
    const pset = deptPatientSets.get(a.department_id);
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
  for (const [id, pset] of deptPatientSets) {
    const entry = deptStatsMap.get(id);
    if (entry) entry.patients = pset.size;
  }
  const initialDepartments = Array.from(deptStatsMap.values()).sort(
    (a, b) => b.appointments - a.appointments,
  );

  // Calculate rates
  const mc = monthCount ?? 0;
  const noShowRate = mc === 0 ? 0 : Math.round(((noShowCount ?? 0) / mc) * 100);
  const cancelRate = mc === 0 ? 0 : Math.round(((cancelCount ?? 0) / mc) * 100);

  return (
    <ManagerDashboard
      clinicId={clinicId}
      fullName={user.fullName}
      todayCount={todayCount ?? 0}
      weekCount={weekCount ?? 0}
      monthCount={mc}
      noShowRate={noShowRate}
      cancelRate={cancelRate}
      totalPatients={totalPatients ?? 0}
      initialDailySeries={buildDailySeries(last30Appts ?? [])}
      initialInsuranceSeries={initialInsuranceSeries}
      initialDoctors={initialDoctors}
      initialDepartments={initialDepartments}
    />
  );
}
