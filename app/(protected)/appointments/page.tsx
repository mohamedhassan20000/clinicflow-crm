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
import { THIRTY_DAYS_MS } from "@/lib/constants";
import { clinicLocaleFromRow, type ClinicLocale } from "@/lib/datetime";
import type { Database } from "@/types/database";
import { pathWithSearch, withReturnTo } from "@/lib/navigation/return-url";
import { getTranslations } from "next-intl/server";
import { AssistantLauncherEntry } from "@/components/assistant/assistant-launcher-entry";
import { AssistantLauncherScope } from "@/components/assistant/assistant-launcher-scope";
import { resolveAssistantLauncher } from "@/lib/ai/launchers";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataAppointments") };
}

type AppointmentStatus = Database["public"]["Enums"]["appointment_status"];

const APPOINTMENT_STATUSES: AppointmentStatus[] = [
  "pending",
  "confirmed",
  "arrived",
  "in_session",
  "completed",
  "cancelled",
  "no_show",
  "replaced",
];

interface PageProps {
  searchParams: Promise<{
    view?: string;
    week?: string;
    date?: string;
    month?: string;
    status?: string;
    doctor?: string;
    dept?: string;
    file?: string;
    nat?: string;
    phone?: string;
    name?: string;
  }>;
}

function getWeekStart(
  date: Date,
  weekStartsOn: ClinicLocale["weekStart"],
): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day - weekStartsOn + 7) % 7;
  d.setDate(d.getDate() - diff);
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

function formatLocalDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export default async function AppointmentsPage({ searchParams }: PageProps) {
  const [t, user] = await Promise.all([
    getTranslations("protected"),
    requireUser(),
  ]);
  const isDoctor = user.role === "doctor";
  const isAssistant = user.role === "assistant";
  // Doctors and assistants get a data-scoped, read-only calendar (RLS filters to
  // their own / their assigned doctors' appointments). Managers now operate the
  // calendar like admins/receptionists.
  const isScopedViewer = isDoctor || isAssistant;
  const supabase = await createClient();
  const { data: clinic } = await supabase
    .from("clinics")
    .select("time_format, timezone, currency, locale, country, week_start, digits")
    .eq("id", user.clinicId)
    .single();
  const clinicLocale = clinicLocaleFromRow(clinic);

  const appointmentSearchParams = await searchParams;
  const {
    view: viewParam,
    week,
    date,
    month,
    status,
    doctor,
    dept,
    file,
    nat,
    phone,
    name,
  } = appointmentSearchParams;
  const currentAppointmentsUrl = pathWithSearch(
    "/appointments",
    new URLSearchParams(
      Object.entries(appointmentSearchParams).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
  );
  const newAppointmentHref = withReturnTo("/appointments/new", currentAppointmentsUrl);

  const view: CalendarView =
    viewParam === "day" || viewParam === "month" ? viewParam : "week";
  const statusFilter = APPOINTMENT_STATUSES.includes(
    status as AppointmentStatus,
  )
    ? (status as AppointmentStatus)
    : null;

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
    const weekOffset = (firstDay - clinicLocale.weekStart + 7) % 7;
    rangeStart = new Date(monthStart);
    rangeStart.setDate(rangeStart.getDate() - weekOffset);
    rangeEnd = new Date(rangeStart);
    rangeEnd.setDate(rangeEnd.getDate() + 42);
  } else {
    weekStart = getWeekStart(
      week ? parseLocalDate(week) : new Date(),
      clinicLocale.weekStart,
    );
    rangeStart = weekStart;
    rangeEnd = new Date(weekStart);
    rangeEnd.setDate(rangeEnd.getDate() + 7);
  }

  // Assistants can operate (create/edit/status) their assigned doctors' scoped
  // appointments; doctors remain read-only on this page. RLS + scoped action
  // guards restrict every assistant write to their assigned doctors.
  const canEditAppointments =
    user.role === "admin" ||
    user.role === "receptionist" ||
    user.role === "manager" ||
    user.role === "assistant";
  const canManageAppointmentTrash =
    user.role === "admin" ||
    user.role === "receptionist" ||
    user.role === "manager";
  const cutoff = new Date(new Date().getTime() - THIRTY_DAYS_MS).toISOString();

  if (canManageAppointmentTrash) {
    // Exclude displaced appointments from the 30-day auto-purge — they belong
    // in the rebook queue until explicitly dismissed.
    await supabase
      .from("appointments")
      .delete()
      .eq("clinic_id", user.clinicId)
      .lt("deleted_at", cutoff)
      .is("displaced_at", null);
  }

  const [cachedStaff, cachedDepartments, clinicHours] = isScopedViewer
    ? [[] as Awaited<ReturnType<typeof getCachedStaff>>, await getCachedDepartments(user.clinicId), await getClinicWorkingHours()]
    : await Promise.all([getCachedStaff(user.clinicId), getCachedDepartments(user.clinicId), getClinicWorkingHours()]);

  const doctors = cachedStaff
    .filter((s) => s.role === "doctor" && s.is_active && !s.deleted_at)
    .map((s) => ({ id: s.id, full_name: s.full_name }));
  const departments = cachedDepartments
    .filter((d) => !d.deleted_at && d.is_active)
    .map((d) => ({ id: d.id, name: d.name, color: d.color }));

  const contextRangeEnd = new Date(rangeEnd);
  contextRangeEnd.setDate(contextRangeEnd.getDate() - 1);
  const selectedDoctorId = isDoctor
    ? user.id
    : doctors.some((candidate) => candidate.id === doctor)
      ? doctor
      : undefined;
  const assistantPromise = resolveAssistantLauncher({
    user,
    context: {
      type: "appointments",
      dateRange: {
        from: formatLocalDate(rangeStart),
        to: formatLocalDate(contextRangeEnd),
      },
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(selectedDoctorId ? { doctorId: selectedDoctorId } : {}),
    },
  });
  const invoiceAssistantPromise = resolveAssistantLauncher({
    user,
    context: { type: "invoices", filter: "all" },
  });

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
      "id, patient_id, doctor_id, scheduled_at, status, insurance_provider_id, notes, duration_minutes, package_id, package_session_number, replaces_appointment_id, replaced_by_appointment_id, patients(full_name, phone, file_number), profiles!doctor_id(full_name), departments(name, color), patient_packages(name, total_sessions, used_sessions, price_per_session)",
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
  if (statusFilter) query = query.eq("status", statusFilter);
  if (patientIds) query = query.in("patient_id", patientIds);

  const { data: appointments } = await query;
  // Recycle bin: soft-deleted but NOT displaced (displaced have their own section)
  const { data: deletedAppointments } = canManageAppointmentTrash
    ? await supabase
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
    ? await supabase
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trashItems: AppointmentTrashItem[] = ((deletedAppointments ?? []) as any[]).map(
    (a) => ({
      id: a.id as string,
      patientName: (a.patients as { full_name: string } | null)?.full_name ?? t("unknown"),
      doctorName: (a.profiles as { full_name: string } | null)?.full_name ?? t("unassigned"),
      scheduledAt: a.scheduled_at as string,
      deletedAt: a.deleted_at as string,
    }),
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const displacedItems: DisplacedAppointmentItem[] = ((displacedRaw ?? []) as any[]).map((a) => ({
    id: a.id as string,
    scheduled_at: a.scheduled_at as string,
    duration_minutes: a.duration_minutes as number,
    displaced_at: a.displaced_at as string,
    patient_id: a.patient_id as string,
    doctor_id: a.doctor_id as string,
    department_id: a.department_id as string | null,
    insurance_provider_id: a.insurance_provider_id as string | null,
    patientName: (a.patients as { full_name: string } | null)?.full_name ?? t("unknown"),
    doctorName: (a.profiles as { full_name: string } | null)?.full_name ?? t("unassigned"),
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
    Number(!!name) +
    Number(!!statusFilter);

  const rangeLabel =
    view === "day"
      ? t("thisday")
      : view === "month"
        ? t("thismonth")
        : t("thisweek");
  const [assistant, invoiceAssistant] = await Promise.all([
    assistantPromise,
    invoiceAssistantPromise,
  ]);

  return (
    <AssistantLauncherScope
      context={invoiceAssistant?.context ?? null}
      role={user.role}
    >
      <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("appointments")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("appointmentCountRange", {
              count: total,
              range: rangeLabel,
              filters: activeFilterCount > 0 ? t("matchingFilters") : "",
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {assistant ? (
            <AssistantLauncherEntry
              resolution={assistant}
              role={user.role}
            />
          ) : null}
          <ViewSwitcher current={view} />
        </div>
      </div>

      <AppointmentsFilterBar
        doctors={doctors}
        departments={departments}
        hideDoctorFilter={isScopedViewer}
        hideDeptFilter={isScopedViewer}
      />

      {view === "day" ? (
        <DayCalendar
          appointments={appts}
          date={dayAnchor}
          canEdit={canEditAppointments}
          currentUserId={user.id}
          currentUserRole={user.role}
          clinicHours={clinicHours}
          newAppointmentHref={newAppointmentHref}
        />
      ) : view === "month" ? (
        <MonthCalendar
          appointments={appts}
          monthStart={monthStart}
          canEdit={canEditAppointments}
          clinicHours={clinicHours}
          newAppointmentHref={newAppointmentHref}
        />
      ) : (
        <WeekCalendar
          appointments={appts}
          weekStart={weekStart}
          canEdit={canEditAppointments}
          currentUserId={user.id}
          currentUserRole={user.role}
          clinicHours={clinicHours}
          newAppointmentHref={newAppointmentHref}
        />
      )}

      {canManageAppointmentTrash && (
        <AppointmentsRecycleBin
          items={trashItems}
          onRestore={restoreAppointment}
          onPermanentDelete={permanentDeleteAppointment}
          onEmptyTrash={emptyAppointmentsTrash}
        />
      )}

      {canEditAppointments && displacedItems.length > 0 && (
        <DisplacedAppointments
          items={displacedItems}
          returnHref={currentAppointmentsUrl}
          canDismiss={canManageAppointmentTrash}
        />
      )}
      </div>
    </AssistantLauncherScope>
  );
}
