import type { Metadata } from "next";
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { getCachedDepartments, getCachedStaff } from "@/lib/cache/reference-data";
import { AdminDashboard } from "@/components/dashboard/admin-dashboard";
import { ReceptionistDashboard } from "@/components/dashboard/receptionist-dashboard";
import { ManagerDashboard } from "@/components/dashboard/manager-dashboard";
import { DoctorDashboard } from "@/components/dashboard/doctor-dashboard";
import { fetchDoctorDashboardStats } from "@/actions/doctor-dashboard";
import { fetchReceptionInSessionBoard } from "@/actions/receptionist-dashboard";
import { getTranslations } from "next-intl/server";
import { AssistantLauncherEntry } from "@/components/assistant/assistant-launcher-entry";
import {
  resolveAssistantLauncher,
  type AssistantLauncherResolution,
} from "@/lib/ai/launchers";
import type { UserRole } from "@/lib/rbac";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataDashboard") };
}

// ── Date helpers (default clinic timezone) ──────────────────────────────────────────

function toIstanbul(date: Date): Date {
  // Shift to Istanbul time so midnight comparisons are correct
  return new Date(
    date.toLocaleString("en-US", { timeZone: DEFAULT_TIME_ZONE }),
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

function buildSeriesForRange(
  appointments: { scheduled_at: string }[],
  startISO: string,
  endISO: string,
): { date: string; appointments: number }[] {
  const map = new Map<string, number>();
  const current = new Date(startISO);
  current.setHours(0, 0, 0, 0);
  const end = new Date(endISO);
  while (current <= end) {
    const key = current.toLocaleDateString("en-US", {
      timeZone: DEFAULT_TIME_ZONE,
      month: "short",
      day: "numeric",
    });
    map.set(key, 0);
    current.setDate(current.getDate() + 1);
  }
  for (const a of appointments) {
    const key = new Date(a.scheduled_at).toLocaleDateString("en-US", {
      timeZone: DEFAULT_TIME_ZONE,
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

function buildAnalyticsAggregates(
  insuranceAppts: { insurance_provider_id: string | null; insurance_providers: unknown }[] | null,
  allDoctorProfiles: { id: string; full_name: string }[] | null,
  periodAppts: {
    doctor_id: string;
    department_id: string | null;
    patient_id: string;
    status: string;
    paid_amount: number | null;
    insurance_amount: number | null;
    secondary_amount: number | null;
  }[] | null,
  allDepartments: { id: string; name: string }[] | null,
) {
  // Insurance
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

  // Doctors
  const doctorStatsMap = new Map<
    string,
    { name: string; total: number; confirmed: number; cancelled: number; other: number; revenue: number }
  >();
  for (const doc of allDoctorProfiles ?? []) {
    doctorStatsMap.set(doc.id, { name: doc.full_name, total: 0, confirmed: 0, cancelled: 0, other: 0, revenue: 0 });
  }
  for (const a of periodAppts ?? []) {
    const entry = doctorStatsMap.get(a.doctor_id);
    if (!entry) continue;
    entry.total++;
    if (a.status === "confirmed") entry.confirmed++;
    else if (a.status === "cancelled") entry.cancelled++;
    else entry.other++;
    if (a.status === "completed") {
      entry.revenue += (a.paid_amount ?? 0) + (a.insurance_amount ?? 0) + (a.secondary_amount ?? 0);
    }
  }
  const initialDoctors = Array.from(doctorStatsMap.values()).sort((a, b) => b.total - a.total);

  // Departments
  const deptStatsMap = new Map<string, { name: string; appointments: number; patients: number; revenue: number }>();
  const deptPatientSets = new Map<string, Set<string>>();
  for (const dept of allDepartments ?? []) {
    deptStatsMap.set(dept.id, { name: dept.name, appointments: 0, patients: 0, revenue: 0 });
    deptPatientSets.set(dept.id, new Set());
  }
  for (const a of periodAppts ?? []) {
    if (!a.department_id) continue;
    const entry = deptStatsMap.get(a.department_id);
    const pset = deptPatientSets.get(a.department_id);
    if (!entry || !pset) continue;
    entry.appointments++;
    pset.add(a.patient_id);
    if (a.status === "completed") {
      entry.revenue += (a.paid_amount ?? 0) + (a.insurance_amount ?? 0) + (a.secondary_amount ?? 0);
    }
  }
  for (const [id, pset] of deptPatientSets) {
    const entry = deptStatsMap.get(id);
    if (entry) entry.patients = pset.size;
  }
  const initialDepartments = Array.from(deptStatsMap.values()).sort((a, b) => b.appointments - a.appointments);

  return { initialInsuranceSeries, initialDoctors, initialDepartments };
}

// Dashboard queries degrade to empty sections (`?? []` / `?? 0`) instead of
// crashing, but a failed query must never be silent: surface it in the server
// log with enough context to identify the failing table.
function logAndReturn<T extends readonly unknown[]>(role: string, results: T): T {
  results.forEach((result, index) => {
    if (
      result &&
      typeof result === "object" &&
      "error" in result &&
      (result as { error: unknown }).error
    ) {
      console.error(
        `[dashboard] ${role} query #${index} failed`,
        (result as { error: unknown }).error,
      );
    }
  });
  return results;
}

function dashboardAssistantLauncher(
  resolution: AssistantLauncherResolution | null,
  role: UserRole,
) {
  if (!resolution) return null;
  return (
    <AssistantLauncherEntry
      resolution={resolution}
      role={role}
    />
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const [t, user] = await Promise.all([
    getTranslations("protected"),
    requireUser(),
  ]);
  const assistantPromise = resolveAssistantLauncher({
    user,
    context: { type: "dashboard" },
  });
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

    const adminStaffPromise = getCachedStaff(clinicId);
    const adminDeptsPromise = getCachedDepartments(clinicId);

    const [
      { count: todayCount },
      { count: weekCount },
      { count: thisMonthCount },
      {},
      { count: totalPatients },
      { count: pendingCount },
      { data: todayAppts },
      { data: upcomingAppts },
      { data: revenueRows },
      { data: outstandingRows },
      // Analytics data
      { count: aNoShowCount },
      { count: aCancelCount },
      { data: aSeriesAppts },
      { data: aInsuranceAppts },
      { data: aAllDoctors },
      { data: aPeriodAppts },
      { data: aAllDepartments },
      { data: aReceptionists },
      { data: aReceptionistAppts },
      { data: aFollowUps },
    ] = logAndReturn("admin", await Promise.all([
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
        .is("deleted_at", null)
        .gte("scheduled_at", today.start)
        .lte("scheduled_at", today.end)
        .order("scheduled_at"),
      supabase
        .from("appointments")
        .select("*, patients(full_name), profiles!doctor_id(full_name)")
        .eq("clinic_id", clinicId)
        .is("deleted_at", null)
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
      // Analytics: no-show + cancel counts for rate calculation
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
      // Analytics: appointments series (this month, non-cancelled)
      supabase
        .from("appointments")
        .select("scheduled_at")
        .eq("clinic_id", clinicId)
        .gte("scheduled_at", thisMonth.start)
        .lte("scheduled_at", thisMonth.end)
        .not("status", "eq", "cancelled"),
      // Analytics: insurance breakdown
      supabase
        .from("appointments")
        .select("insurance_provider_id, insurance_providers(name)")
        .eq("clinic_id", clinicId)
        .gte("scheduled_at", thisMonth.start)
        .lte("scheduled_at", thisMonth.end),
      // Analytics: all active doctors (cached)
      adminStaffPromise.then((s) => ({
        data: s
          .filter((x) => x.role === "doctor" && x.is_active && !x.deleted_at)
          .map((x) => ({ id: x.id, full_name: x.full_name })),
      })),
      // Analytics: period appointments with stats fields
      supabase
        .from("appointments")
        .select("doctor_id, department_id, patient_id, status, paid_amount, insurance_amount, secondary_amount")
        .eq("clinic_id", clinicId)
        .gte("scheduled_at", thisMonth.start)
        .lte("scheduled_at", thisMonth.end),
      // Analytics: all active departments (cached)
      adminDeptsPromise.then((d) => ({
        data: d
          .filter((x) => !x.deleted_at && x.is_active)
          .map((x) => ({ id: x.id, name: x.name })),
      })),
      // Analytics: all active receptionists (cached)
      adminStaffPromise.then((s) => ({
        data: s
          .filter((x) => x.role === "receptionist" && x.is_active && !x.deleted_at)
          .map((x) => ({ id: x.id, full_name: x.full_name })),
      })),
      // Analytics: appointments this month with created_by for receptionist stats
      supabase
        .from("appointments")
        .select("created_by, status")
        .eq("clinic_id", clinicId)
        .gte("scheduled_at", thisMonth.start)
        .lte("scheduled_at", thisMonth.end),
      // Analytics: follow-up outcomes this month
      supabase
        .from("follow_ups")
        .select("outcome")
        .eq("clinic_id", clinicId)
        .gte("recorded_at", thisMonth.start)
        .lte("recorded_at", thisMonth.end),
    ]));

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
        timeZone: DEFAULT_TIME_ZONE,
        month: "short",
      }),
      amount: sumInRange(start, end),
    }));

    const outstandingTotal = (outstandingRows ?? []).reduce(
      (acc, r) => acc + (r.outstanding_amount ?? 0),
      0,
    );

    // ── Analytics aggregation ──────────────────────────────────────────────
    const amc = thisMonthCount ?? 0;
    const aNoShowRate = amc === 0 ? 0 : Math.round(((aNoShowCount ?? 0) / amc) * 100);
    const aCancelRate = amc === 0 ? 0 : Math.round(((aCancelCount ?? 0) / amc) * 100);

    const { initialInsuranceSeries, initialDoctors, initialDepartments } =
      buildAnalyticsAggregates(
        aInsuranceAppts as Parameters<typeof buildAnalyticsAggregates>[0],
        aAllDoctors,
        aPeriodAppts as Parameters<typeof buildAnalyticsAggregates>[2],
        aAllDepartments,
      );

    // Receptionist stats aggregation
    const receptionistStatsMap = new Map<string, { name: string; total: number; confirmed: number; cancelled: number; other: number }>();
    for (const r of aReceptionists ?? []) {
      receptionistStatsMap.set(r.id, { name: r.full_name, total: 0, confirmed: 0, cancelled: 0, other: 0 });
    }
    for (const a of (aReceptionistAppts ?? []) as { created_by: string | null; status: string }[]) {
      if (!a.created_by) continue;
      const entry = receptionistStatsMap.get(a.created_by);
      if (!entry) continue;
      entry.total++;
      if (a.status === "confirmed") entry.confirmed++;
      else if (a.status === "cancelled") entry.cancelled++;
      else entry.other++;
    }
    const initialReceptionists = Array.from(receptionistStatsMap.values()).sort((a, b) => b.total - a.total);

    // Follow-up outcomes aggregation
    let fuAllFine = 0, fuHasProblem = 0;
    for (const fu of (aFollowUps ?? []) as { outcome: string }[]) {
      if (fu.outcome === "all_fine") fuAllFine++;
      else if (fu.outcome === "has_problem") fuHasProblem++;
    }
    const initialFollowUpOutcomes = { allFine: fuAllFine, hasProblem: fuHasProblem, total: (aFollowUps ?? []).length };

    return (
      <AdminDashboard
        assistantLauncher={dashboardAssistantLauncher(await assistantPromise, user.role)}
        fullName={user.fullName}
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
        analytics={{
          clinicId,
          todayCount: todayCount ?? 0,
          weekCount: weekCount ?? 0,
          monthCount: amc,
          noShowRate: aNoShowRate,
          cancelRate: aCancelRate,
          totalPatients: totalPatients ?? 0,
          initialDailySeries: buildSeriesForRange(aSeriesAppts ?? [], thisMonth.start, thisMonth.end),
          initialInsuranceSeries,
          initialDoctors,
          initialDepartments,
          initialReceptionists,
          initialFollowUpOutcomes,
          departmentsList: aAllDepartments ?? [],
          doctorsList: (aAllDoctors ?? []).map((d) => ({ id: d.id, name: d.full_name })),
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
      inSessionGroups,
    ] = logAndReturn("receptionist", await Promise.all([
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
      fetchReceptionInSessionBoard(),
    ]));

    return (
      <ReceptionistDashboard
        assistantLauncher={dashboardAssistantLauncher(await assistantPromise, user.role)}
        fullName={user.fullName}
        todayCount={todayCount ?? 0}
        pendingCount={pendingCount ?? 0}
        confirmedCount={confirmedCount ?? 0}
        todayAppointments={(todayAppts ?? []) as Parameters<typeof ReceptionistDashboard>[0]["todayAppointments"]}
        pendingAppointments={(pendingAppts ?? []) as Parameters<typeof ReceptionistDashboard>[0]["pendingAppointments"]}
        nextTwoHoursAppointments={(next2hAppts ?? []) as Parameters<typeof ReceptionistDashboard>[0]["nextTwoHoursAppointments"]}
        inSessionGroups={inSessionGroups}
      />
    );
  }

  if (user.role === "doctor") {
    const thisMonth = monthBounds(0);
    const deptId = user.departmentId ?? "";

    const [initial, { data: deptInfo }] = await Promise.all([
      fetchDoctorDashboardStats(clinicId, user.id, deptId, thisMonth.start, thisMonth.end),
      deptId
        ? supabase.from("departments").select("name").eq("id", deptId).single()
        : Promise.resolve({ data: null }),
    ]);

    return (
      <DoctorDashboard
        assistantLauncher={dashboardAssistantLauncher(await assistantPromise, user.role)}
        fullName={user.fullName}
        clinicId={clinicId}
        doctorId={user.id}
        departmentId={deptId}
        departmentName={deptInfo?.name ?? t("myDepartment")}
        initial={initial}
      />
    );
  }

  // Manager
  const today = todayBounds();
  const week = weekBounds();
  const thisMonth = monthBounds(0);

  const mgrStaffPromise = getCachedStaff(clinicId);
  const mgrDeptsPromise = getCachedDepartments(clinicId);

  const [
    { count: todayCount },
    { count: weekCount },
    { count: monthCount },
    { count: totalPatients },
    { count: noShowCount },
    { count: cancelCount },
    { data: seriesAppts },
    { data: insuranceAppts },
    { data: allDoctorProfiles },
    { data: doctorAppts },
    { data: allDepartments },
    { data: mgrReceptionists },
    { data: mgrReceptionistAppts },
    { data: mgrFollowUps },
  ] = logAndReturn("manager", await Promise.all([
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
      .gte("scheduled_at", thisMonth.start)
      .lte("scheduled_at", thisMonth.end)
      .not("status", "eq", "cancelled"),
    supabase
      .from("appointments")
      .select("insurance_provider_id, insurance_providers(name)")
      .eq("clinic_id", clinicId)
      .gte("scheduled_at", thisMonth.start)
      .lte("scheduled_at", thisMonth.end),
    // all active doctors (cached)
    mgrStaffPromise.then((s) => ({
      data: s
        .filter((x) => x.role === "doctor" && x.is_active && !x.deleted_at)
        .map((x) => ({ id: x.id, full_name: x.full_name })),
    })),
    supabase
      .from("appointments")
      .select("doctor_id, department_id, patient_id, status, paid_amount, insurance_amount, secondary_amount")
      .eq("clinic_id", clinicId)
      .gte("scheduled_at", thisMonth.start)
      .lte("scheduled_at", thisMonth.end),
    // all active departments (cached)
    mgrDeptsPromise.then((d) => ({
      data: d
        .filter((x) => !x.deleted_at && x.is_active)
        .map((x) => ({ id: x.id, name: x.name })),
    })),
    // all active receptionists (cached)
    mgrStaffPromise.then((s) => ({
      data: s
        .filter((x) => x.role === "receptionist" && x.is_active && !x.deleted_at)
        .map((x) => ({ id: x.id, full_name: x.full_name })),
    })),
    supabase
      .from("appointments")
      .select("created_by, status")
      .eq("clinic_id", clinicId)
      .gte("scheduled_at", thisMonth.start)
      .lte("scheduled_at", thisMonth.end),
    supabase
      .from("follow_ups")
      .select("outcome")
      .eq("clinic_id", clinicId)
      .gte("recorded_at", thisMonth.start)
      .lte("recorded_at", thisMonth.end),
  ]));

  const mc = monthCount ?? 0;
  const noShowRate = mc === 0 ? 0 : Math.round(((noShowCount ?? 0) / mc) * 100);
  const cancelRate = mc === 0 ? 0 : Math.round(((cancelCount ?? 0) / mc) * 100);

  const { initialInsuranceSeries, initialDoctors, initialDepartments } =
    buildAnalyticsAggregates(
      insuranceAppts as Parameters<typeof buildAnalyticsAggregates>[0],
      allDoctorProfiles,
      doctorAppts as Parameters<typeof buildAnalyticsAggregates>[2],
      allDepartments,
    );

  const mgrReceptionistMap = new Map<string, { name: string; total: number; confirmed: number; cancelled: number; other: number }>();
  for (const r of mgrReceptionists ?? []) {
    mgrReceptionistMap.set(r.id, { name: r.full_name, total: 0, confirmed: 0, cancelled: 0, other: 0 });
  }
  for (const a of (mgrReceptionistAppts ?? []) as { created_by: string | null; status: string }[]) {
    if (!a.created_by) continue;
    const entry = mgrReceptionistMap.get(a.created_by);
    if (!entry) continue;
    entry.total++;
    if (a.status === "confirmed") entry.confirmed++;
    else if (a.status === "cancelled") entry.cancelled++;
    else entry.other++;
  }
  const mgrInitialReceptionists = Array.from(mgrReceptionistMap.values()).sort((a, b) => b.total - a.total);

  let mgrFuAllFine = 0, mgrFuHasProblem = 0;
  for (const fu of (mgrFollowUps ?? []) as { outcome: string }[]) {
    if (fu.outcome === "all_fine") mgrFuAllFine++;
    else if (fu.outcome === "has_problem") mgrFuHasProblem++;
  }
  const mgrInitialFollowUpOutcomes = { allFine: mgrFuAllFine, hasProblem: mgrFuHasProblem, total: (mgrFollowUps ?? []).length };

  return (
    <ManagerDashboard
      assistantLauncher={dashboardAssistantLauncher(await assistantPromise, user.role)}
      clinicId={clinicId}
      fullName={user.fullName}
      todayCount={todayCount ?? 0}
      weekCount={weekCount ?? 0}
      monthCount={mc}
      noShowRate={noShowRate}
      cancelRate={cancelRate}
      totalPatients={totalPatients ?? 0}
      initialDailySeries={buildSeriesForRange(seriesAppts ?? [], thisMonth.start, thisMonth.end)}
      initialInsuranceSeries={initialInsuranceSeries}
      initialDoctors={initialDoctors}
      initialDepartments={initialDepartments}
      initialReceptionists={mgrInitialReceptionists}
      initialFollowUpOutcomes={mgrInitialFollowUpOutcomes}
      departmentsList={allDepartments ?? []}
      doctorsList={(allDoctorProfiles ?? []).map((d) => ({ id: d.id, name: d.full_name }))}
    />
  );
}
