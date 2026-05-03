import type { Metadata } from "next";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { fetchUserCustomizationMap, featureAccess } from "@/lib/get-user-customizations";
import { FollowupsView } from "@/components/followups/followups-view";

export const metadata: Metadata = { title: "Follow-ups" };

type Scope = "day" | "yesterday" | "week" | "month";

interface PageProps {
  searchParams: Promise<{
    scope?: string;
    date?: string;
    q?: string;
    dept?: string;
    outcome?: string;
  }>;
}

function toIstanbul(date: Date): Date {
  return new Date(date.toLocaleString("en-US", { timeZone: "Europe/Istanbul" }));
}
function startOfDay(d: Date) {
  const n = new Date(d);
  n.setHours(0, 0, 0, 0);
  return n;
}
function endOfDay(d: Date) {
  const n = new Date(d);
  n.setHours(23, 59, 59, 999);
  return n;
}

function resolveRange(scope: Scope, dateStr?: string) {
  const base = dateStr ? new Date(dateStr) : toIstanbul(new Date());
  if (scope === "day") return { start: startOfDay(base), end: endOfDay(base) };
  if (scope === "yesterday") {
    const y = new Date(base);
    y.setDate(y.getDate() - 1);
    return { start: startOfDay(y), end: endOfDay(y) };
  }
  if (scope === "week") {
    // Rolling 7-day window: the 7 days *before* today (today excluded).
    const yesterday = new Date(base);
    yesterday.setDate(yesterday.getDate() - 1);
    const start7 = new Date(yesterday);
    start7.setDate(start7.getDate() - 6);
    return { start: startOfDay(start7), end: endOfDay(yesterday) };
  }
  // Rolling 30-day window: the 30 days *before* today (so today itself is
  // excluded). End of yesterday → start of the 30th day prior.
  const yesterday = new Date(base);
  yesterday.setDate(yesterday.getDate() - 1);
  const start30 = new Date(yesterday);
  start30.setDate(start30.getDate() - 29);
  return { start: startOfDay(start30), end: endOfDay(yesterday) };
}

export default async function FollowupsPage({ searchParams }: PageProps) {
  const user = await requireUser();
  const isDoctor = user.role === "doctor";
  const customMap = await fetchUserCustomizationMap(user.id);
  const canRecordOutcome = featureAccess(customMap, "followups", "record_outcome", user.role) === "read_edit";

  const sp = await searchParams;
  const scope = ((sp.scope as Scope) ?? "day") as Scope;
  const dateStr = sp.date ?? "";
  const range = resolveRange(scope, dateStr);
  const q = sp.q?.trim() ?? "";
  // Doctors are always scoped to their own department
  const filterDept = isDoctor ? (user.departmentId ?? null) : (sp.dept?.trim() || null);
  const filterOutcome = (() => {
    const v = sp.outcome?.trim();
    if (v === "all_fine" || v === "has_problem" || v === "no_response") return v;
    return null;
  })();

  const supabase = await createClient();

  // Patient search → resolve to IDs first so we can scope downstream queries.
  let patientIdFilter: string[] | null = null;
  if (q) {
    const { data: matches } = await supabase
      .from("patients")
      .select("id")
      .eq("clinic_id", user.clinicId)
      .or(
        `full_name.ilike.%${q}%,phone.ilike.%${q}%,file_number.ilike.%${q}%,national_id.ilike.%${q}%`,
      )
      .limit(500);
    patientIdFilter = (matches ?? []).map((m) => m.id);
    if (patientIdFilter.length === 0) patientIdFilter = ["__none__"];
  }

  // Completed appointments inside the window — we'll filter out any that
  // already have a follow_ups row in JS (PostgREST can't filter the parent
  // by emptiness of an embedded relation).
  let pendingQ = supabase
    .from("appointments")
    .select(
      "id, scheduled_at, paid_at, patient_id, department_id, doctor_id, total_amount, payment_note, patients(id, full_name, phone, file_number, national_id, department_id), profiles!doctor_id(full_name), departments(id, name, color), follow_ups(id)",
    )
    .eq("clinic_id", user.clinicId)
    .eq("status", "completed")
    .gte("scheduled_at", range.start.toISOString())
    .lte("scheduled_at", range.end.toISOString())
    .order("scheduled_at", { ascending: false })
    .limit(500);

  if (filterDept) pendingQ = pendingQ.eq("department_id", filterDept);
  if (patientIdFilter) pendingQ = pendingQ.in("patient_id", patientIdFilter);

  // Done: follow_ups inside the window, with their appointment + patient context.
  let doneQ = supabase
    .from("follow_ups")
    .select(
      "id, recorded_at, outcome, notes, patient_id, appointment_id, patients(id, full_name, phone, file_number, national_id, department_id), recorded_by:profiles!recorded_by(full_name), appointment:appointments!appointment_id(id, scheduled_at, department_id, doctor_id, profiles!doctor_id(full_name), departments(id, name, color))",
    )
    .eq("clinic_id", user.clinicId)
    .gte("recorded_at", range.start.toISOString())
    .lte("recorded_at", range.end.toISOString())
    .order("recorded_at", { ascending: false })
    .limit(500);

  if (patientIdFilter) doneQ = doneQ.in("patient_id", patientIdFilter);

  const [{ data: pendingRaw }, { data: done }, { data: departments }] =
    await Promise.all([
      pendingQ,
      doneQ,
      supabase
        .from("departments")
        .select("id, name, color")
        .eq("clinic_id", user.clinicId)
        .eq("is_active", true)
        .order("name"),
    ]);

  // Drop appointments that already have a follow-up.
  const pending = (pendingRaw ?? []).filter(
    (a) => !a.follow_ups || a.follow_ups.length === 0,
  );

  // Department + outcome filters apply on the JS side (the dept filter must
  // walk the joined appointment).
  const OUTCOME_RANK: Record<string, number> = {
    has_problem: 0,
    all_fine: 1,
    no_response: 2,
  };
  const doneFiltered = (done ?? [])
    .filter((d) => {
      if (filterDept && d.appointment?.department_id !== filterDept) return false;
      if (filterOutcome && d.outcome !== filterOutcome) return false;
      return true;
    })
    .sort((a, b) => {
      // Surface "Reported a problem" first so reception can address them.
      const da = OUTCOME_RANK[a.outcome] ?? 99;
      const db = OUTCOME_RANK[b.outcome] ?? 99;
      if (da !== db) return da - db;
      return (
        new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime()
      );
    });

  return (
    <FollowupsView
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pending={(pending ?? []) as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      done={doneFiltered as any}
      departments={departments ?? []}
      scope={scope}
      dateInput={dateStr || ""}
      activeDept={filterDept}
      activeOutcome={filterOutcome}
      activeQuery={q}
      range={{
        start: range.start.toISOString(),
        end: range.end.toISOString(),
      }}
      readOnly={!canRecordOutcome}
    />
  );
}
