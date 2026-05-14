import type { Metadata } from "next";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { getCachedDepartments, getCachedStaff } from "@/lib/cache/reference-data";
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
  DisplacedAppointments,
  type DisplacedAppointmentItem,
} from "@/components/appointments/displaced-appointments";
import {
  emptyAppointmentsTrash,
  permanentDeleteAppointment,
  restoreAppointment,
} from "@/actions/appointments";
import { getClinicWorkingHours } from "@/actions/settings";

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
    // Exclude displaced appointments from the 30-day auto-purge — they belong
    // in the rebook queue until explicitly dismissed.
    await (supabase as any)
      .from("appointments")
      .delete()
      .eq("clinic_id", user.clinicId)
      .lt("deleted_at", cutoff)
      .is("displaced_at", null);
  }

  const [cachedStaff, cachedDepartments, clinicHours] = isDoctor
    ? [[] as Awaited<ReturnType<typeof getCachedStaff>>, await getCachedDepartments(user.clinicId), await getClinicWorkingHours()]
    : await Promise.all([getCachedStaff(user.clinicId), getCachedDepartments(user.clinicId), getClinicWorkingHours()]);

  const doctors = cachedStaff
    .filter((s) => s.role === "doctor" && s.is_active && !s.deleted_at)
    .map((s) => ({ id: s.id, full_name: s.full_name }));
  const departments = cachedDepartments
    .filter((d) => !d.deleted_at && d.is_active)
    .map((d) => ({ id: d.id, name: d.name, color: d.color }));

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
      "id, scheduled_at, status, insurance_provider_id, notes, duration_minutes, patients(full_name, phone, file_number), profiles!doctor_id(full_name), departments(name, color)",
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
  // Recycle bin: soft-deleted but NOT displaced (displaced have their own section)
  const { data: deletedAppointments } = canEditAppointments
    ? await (supabase as any)
        .from("appointments")
        .select(
          "id, scheduled_at, deleted_at, patients(full_name), profiles!doctor_id(full_name)",
        )
        .eq("clinic_id", user.clinicId)
        .not("deleted_at", "is", null)
        .is("displaced_at", null)
        .gt("deleted_at", cutoff)
        .order("deleted_at", { ascending: false })
        .limit(100)
    : { data: [] };

  // Displaced appointments: pending appointments removed due to a confirmed conflict
  const { data: displacedRaw } = canEditAppointments
    ? await (supabase as any)
        .from("appointments")
        .select(
          "id, scheduled_at, duration_minutes, displaced_at, patient_id, doctor_id, department_id, insurance_provider_id, patients(full_name, file_number), profiles!doctor_id(full_name), departments(name, color)",
        )
        .eq("clinic_id", user.clinicId)
        .not("displaced_at", "is", null)
        .not("deleted_at", "is", null)
        .order("displaced_at", { ascending: false })
    : { data: [] };
  const appts = (appointments ?? []) as Parameters<
    typeof WeekCalendar
  >[0]["appointments"];
  const trashItems: AppointmentTrashItem[] = ((deletedAppointments ?? []) as any[]).map(
    (a) => ({
      id: a.id as string,
      patientName: (a.patients as { full_name: string } | null)?.full_name ?? "Unknown",
      doctorName: (a.profiles as { full_name: string } | null)?.full_name ?? "Unassigned",
      scheduledAt: a.scheduled_at as string,
      deletedAt: a.deleted_at as string,
    }),
  );

  const displacedItems: DisplacedAppointmentItem[] = ((displacedRaw ?? []) as any[]).map((a) => ({
    id: a.id as string,
    scheduled_at: a.scheduled_at as string,
    duration_minutes: a.duration_minutes as number,
    displaced_at: a.displaced_at as string,
    patient_id: a.patient_id as string,
    doctor_id: a.doctor_id as string,
    department_id: a.department_id as string | null,
    insurance_provider_id: a.insurance_provider_id as string | null,
    patientName: (a.patients as { full_name: string } | null)?.full_name ?? "Unknown",
    doctorName: (a.profiles as { full_name: string } | null)?.full_name ?? "Unassigned",
    departmentName: (a.departments as { name: string } | null)?.name ?? null,
    departmentColor: (a.departments as { color: string | null } | null)?.color ?? null,
  }));

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
        doctors={doctors}
        departments={departments}
        hideDoctorFilter={isDoctor}
        hideDeptFilter={isDoctor}
      />

      {view === "day" ? (
        <DayCalendar
          appointments={appts}
          date={dayAnchor}
          canEdit={canEditAppointments}
          clinicHours={clinicHours}
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
          clinicHours={clinicHours}
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

      {canEditAppointments && displacedItems.length > 0 && (
        <DisplacedAppointments items={displacedItems} />
      )}
    </div>
  );
}
