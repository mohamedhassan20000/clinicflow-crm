import type { Metadata } from "next";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { WeekCalendar } from "@/components/appointments/week-calendar";
import { DayCalendar } from "@/components/appointments/day-calendar";
import { MonthCalendar } from "@/components/appointments/month-calendar";
import { AppointmentsFilterBar } from "@/components/appointments/filter-bar";
import {
  ViewSwitcher,
  type CalendarView,
} from "@/components/appointments/view-switcher";
import {
  AppointmentsRecycleBin,
  type AppointmentTrashItem,
} from "@/components/appointments/appointments-recycle-bin";
import {
  emptyAppointmentsTrash,
  permanentDeleteAppointment,
  restoreAppointment,
} from "@/actions/appointments";

export const metadata: Metadata = { title: "Appointments" };
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface PageProps {
  searchParams: Promise<{
    view?: string;
    week?: string;
    date?: string;
    month?: string;
    doctor?: string;
    dept?: string;
    file?: string;
    nat?: string;
    phone?: string;
    name?: string;
  }>;
}

function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return new Date();
  return new Date(y, m - 1, d);
}

function parseLocalMonth(iso: string): Date {
  const [y, m] = iso.split("-").map(Number);
  if (!y || !m) return new Date();
  return new Date(y, m - 1, 1);
}

export default async function AppointmentsPage({ searchParams }: PageProps) {
  const user = await requireUser();
  const isDoctor = user.role === "doctor";

  const {
    view: viewParam,
    week,
    date,
    month,
    doctor,
    dept,
    file,
    nat,
    phone,
    name,
  } = await searchParams;

  const view: CalendarView =
    viewParam === "day" || viewParam === "month" ? viewParam : "week";

  // Compute range [rangeStart, rangeEnd) based on view
  let rangeStart: Date;
  let rangeEnd: Date;
  let dayAnchor: Date = new Date();
  let weekStart: Date = new Date();
  let monthStart: Date = new Date();

  if (view === "day") {
    dayAnchor = date ? parseLocalDate(date) : new Date();
    dayAnchor.setHours(0, 0, 0, 0);
    rangeStart = new Date(dayAnchor);
    rangeEnd = new Date(dayAnchor);
    rangeEnd.setDate(rangeEnd.getDate() + 1);
  } else if (view === "month") {
    monthStart = month ? parseLocalMonth(month) : new Date();
    monthStart = new Date(
      monthStart.getFullYear(),
      monthStart.getMonth(),
      1,
      0,
      0,
      0,
      0,
    );
    // Include the 6-week grid so trailing/leading cells render their events too
    const firstDay = monthStart.getDay();
    const mondayOffset = firstDay === 0 ? -6 : 1 - firstDay;
    rangeStart = new Date(monthStart);
    rangeStart.setDate(rangeStart.getDate() + mondayOffset);
    rangeEnd = new Date(rangeStart);
    rangeEnd.setDate(rangeEnd.getDate() + 42);
  } else {
    weekStart = getMonday(week ? parseLocalDate(week) : new Date());
    rangeStart = weekStart;
    rangeEnd = new Date(weekStart);
    rangeEnd.setDate(rangeEnd.getDate() + 7);
  }

  const supabase = await createClient();
  const canEditAppointments = !isDoctor && user.role !== "manager";
  const cutoff = new Date(new Date().getTime() - THIRTY_DAYS_MS).toISOString();

  if (canEditAppointments) {
    await supabase
      .from("appointments")
      .delete()
      .eq("clinic_id", user.clinicId)
      .lt("deleted_at", cutoff);
  }

  const [{ data: doctors }, { data: departments }] = await Promise.all([
    isDoctor
      ? Promise.resolve({ data: [] as { id: string; full_name: string }[] })
      : supabase
          .from("profiles")
          .select("id, full_name")
          .eq("clinic_id", user.clinicId)
          .eq("role", "doctor")
          .eq("is_active", true)
          .order("full_name"),
    supabase
      .from("departments")
      .select("id, name, color")
      .eq("clinic_id", user.clinicId)
      .eq("is_active", true)
      .order("name"),
  ]);

  let patientIds: string[] | null = null;
  const hasPatientFilter = !!file || !!nat || !!phone || !!name;

  if (hasPatientFilter) {
    let pq = supabase
      .from("patients")
      .select("id")
      .eq("clinic_id", user.clinicId)
      .eq("is_deleted", false);
    if (file) pq = pq.ilike("file_number", `%${file}%`);
    if (nat) pq = pq.ilike("national_id", `%${nat}%`);
    if (phone) pq = pq.ilike("phone", `%${phone}%`);
    if (name) pq = pq.ilike("full_name", `%${name}%`);
    const { data: pats } = await pq.limit(500);
    patientIds = (pats ?? []).map((p) => p.id);
    if (patientIds.length === 0) patientIds = ["__none__"];
  }

  let query = supabase
    .from("appointments")
    .select(
      "id, scheduled_at, status, insurance_provider_id, notes, patients(full_name, phone, file_number), profiles!doctor_id(full_name), departments(name, color)",
    )
    .eq("clinic_id", user.clinicId)
    .is("deleted_at", null)
    .gte("scheduled_at", rangeStart.toISOString())
    .lt("scheduled_at", rangeEnd.toISOString())
    .order("scheduled_at");

  // Doctors always see only their own appointments
  if (isDoctor) query = query.eq("doctor_id", user.id);
  else if (doctor) query = query.eq("doctor_id", doctor);
  if (dept) query = query.eq("department_id", dept);
  if (patientIds) query = query.in("patient_id", patientIds);

  const { data: appointments } = await query;
  const { data: deletedAppointments } = canEditAppointments
    ? await supabase
        .from("appointments")
        .select(
          "id, scheduled_at, deleted_at, patients(full_name), profiles!doctor_id(full_name)",
        )
        .eq("clinic_id", user.clinicId)
        .not("deleted_at", "is", null)
        .gt("deleted_at", cutoff)
        .order("deleted_at", { ascending: false })
        .limit(100)
    : { data: [] };
  const appts = (appointments ?? []) as Parameters<
    typeof WeekCalendar
  >[0]["appointments"];
  const trashItems: AppointmentTrashItem[] = (deletedAppointments ?? []).map(
    (a) => ({
      id: a.id,
      patientName:
        (a.patients as { full_name: string } | null)?.full_name ?? "Unknown",
      doctorName:
        (a.profiles as { full_name: string } | null)?.full_name ??
        "Unassigned",
      scheduledAt: a.scheduled_at,
      deletedAt: a.deleted_at!,
    }),
  );

  const total = appts.length;
  const activeFilterCount =
    Number(!isDoctor && !!doctor) +
    Number(!!dept) +
    Number(!!file) +
    Number(!!nat) +
    Number(!!phone) +
    Number(!!name);

  const rangeLabel =
    view === "day"
      ? "this day"
      : view === "month"
        ? "this month"
        : "this week";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Appointments</h1>
          <p className="text-sm text-muted-foreground">
            {total} appointment{total !== 1 ? "s" : ""} {rangeLabel}
            {activeFilterCount > 0 && " matching filters"}.
          </p>
        </div>
        <ViewSwitcher current={view} />
      </div>

      <AppointmentsFilterBar
        doctors={doctors ?? []}
        departments={departments ?? []}
        hideDoctorFilter={isDoctor}
        hideDeptFilter={isDoctor}
      />

      {view === "day" ? (
        <DayCalendar
          appointments={appts}
          date={dayAnchor}
          canEdit={canEditAppointments}
        />
      ) : view === "month" ? (
        <MonthCalendar
          appointments={appts}
          monthStart={monthStart}
          canEdit={canEditAppointments}
        />
      ) : (
        <WeekCalendar
          appointments={appts}
          weekStart={weekStart}
          canEdit={canEditAppointments}
        />
      )}

      {canEditAppointments && (
        <AppointmentsRecycleBin
          items={trashItems}
          onRestore={restoreAppointment}
          onPermanentDelete={permanentDeleteAppointment}
          onEmptyTrash={emptyAppointmentsTrash}
        />
      )}
    </div>
  );
}
