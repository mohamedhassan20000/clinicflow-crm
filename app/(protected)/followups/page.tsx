import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { FollowupsView } from "@/components/followups/followups-view";

export const metadata: Metadata = { title: "Follow-ups" };

type Scope = "day" | "yesterday" | "week" | "month";
type FollowupOutcome = "all_fine" | "has_problem" | "no_response";

const PENDING_PREVIEW_LIMIT = 250;
const COMPLETED_PAGE_SIZE = 50;

interface FollowupsDashboardSummary {
  pendingCount: number;
  completedCount: number;
  allFineCount: number;
  hasProblemCount: number;
  noResponseCount: number;
}

const EMPTY_SUMMARY: FollowupsDashboardSummary = {
  pendingCount: 0,
  completedCount: 0,
  allFineCount: 0,
  hasProblemCount: 0,
  noResponseCount: 0,
};

interface FollowupsDashboardPayload {
  summary: FollowupsDashboardSummary;
  pending: unknown[];
  done: unknown[];
}

interface PageProps {
  searchParams: Promise<{
    scope?: string;
    date?: string;
    q?: string;
    name?: string;
    file?: string;
    nat?: string;
    phone?: string;
    dept?: string;
    doctor?: string;
    outcome?: string;
    completedPage?: string;
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

function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeDashboardPayload(payload: unknown): FollowupsDashboardPayload {
  if (!payload || typeof payload !== "object") {
    return { summary: EMPTY_SUMMARY, pending: [], done: [] };
  }

  const source = payload as {
    summary?: Record<string, unknown>;
    pending?: unknown;
    done?: unknown;
  };
  const summary = source.summary ?? {};

  return {
    summary: {
      pendingCount: toNumber(summary.pendingCount),
      completedCount: toNumber(summary.completedCount),
      allFineCount: toNumber(summary.allFineCount),
      hasProblemCount: toNumber(summary.hasProblemCount),
      noResponseCount: toNumber(summary.noResponseCount),
    },
    pending: Array.isArray(source.pending) ? source.pending : [],
    done: Array.isArray(source.done) ? source.done : [],
  };
}

export default async function FollowupsPage({ searchParams }: PageProps) {
  const user = await requireUser();
  if (user.role === "manager") redirect("/dashboard");

  const isDoctor = user.role === "doctor";

  const sp = await searchParams;
  const scope = ((sp.scope as Scope) ?? "day") as Scope;
  const dateStr = sp.date ?? "";
  const range = resolveRange(scope, dateStr);
  const q = sp.q?.trim() ?? "";
  const name = sp.name?.trim() ?? "";
  const file = sp.file?.trim() ?? "";
  const nat = sp.nat?.trim() ?? "";
  const phone = sp.phone?.trim() ?? "";
  // Doctors are always scoped to their own department
  const filterDept = isDoctor ? (user.departmentId ?? null) : (sp.dept?.trim() || null);
  const filterDoctor = isDoctor ? null : (sp.doctor?.trim() || null);
  const filterOutcome = (() => {
    const v = sp.outcome?.trim();
    if (v === "all_fine" || v === "has_problem" || v === "no_response") return v;
    return null;
  })() satisfies FollowupOutcome | null;
  const completedPage = Math.max(1, Number(sp.completedPage ?? "1") || 1);
  const completedOffset = (completedPage - 1) * COMPLETED_PAGE_SIZE;

  const supabase = await createClient();

  // Patient search → resolve to IDs first so we can scope downstream queries.
  let patientIdFilter: string[] | null = null;
  if (q || name || file || nat || phone) {
    let patientQuery = supabase
      .from("patients")
      .select("id")
      .eq("clinic_id", user.clinicId)
      .limit(500);
    if (q) {
      patientQuery = patientQuery.or(
        `full_name.ilike.%${q}%,phone.ilike.%${q}%,file_number.ilike.%${q}%,national_id.ilike.%${q}%`,
      );
    }
    if (name) patientQuery = patientQuery.ilike("full_name", `%${name}%`);
    if (file) patientQuery = patientQuery.ilike("file_number", `%${file}%`);
    if (nat) patientQuery = patientQuery.ilike("national_id", `%${nat}%`);
    if (phone) patientQuery = patientQuery.ilike("phone", `%${phone}%`);
    const { data: matches } = await patientQuery;
    patientIdFilter = (matches ?? []).map((m) => m.id);
  }
  const hasNoPatientMatches = patientIdFilter?.length === 0;

  const dashboardPromise = hasNoPatientMatches
    ? Promise.resolve({ data: { summary: EMPTY_SUMMARY, pending: [], done: [] } })
    : supabase.rpc("get_followups_dashboard" as never, {
        p_start: range.start.toISOString(),
        p_end: range.end.toISOString(),
        p_department_id: filterDept,
        p_doctor_id: filterDoctor,
        p_patient_ids: patientIdFilter,
        p_outcome: filterOutcome,
        p_pending_limit: PENDING_PREVIEW_LIMIT,
        p_done_limit: COMPLETED_PAGE_SIZE,
        p_done_offset: completedOffset,
      } as never);

  const [{ data: dashboardRaw }, { data: departments }, { data: doctors }] =
    await Promise.all([
      dashboardPromise,
      supabase
        .from("departments")
        .select("id, name, color")
        .eq("clinic_id", user.clinicId)
        .eq("is_active", true)
        .order("name"),
      isDoctor
        ? Promise.resolve({ data: [] })
        : supabase
            .from("profiles")
            .select("id, full_name")
            .eq("clinic_id", user.clinicId)
            .eq("role", "doctor")
            .eq("is_active", true)
            .order("full_name"),
    ]);

  const dashboard = normalizeDashboardPayload(dashboardRaw);

  return (
    <FollowupsView
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pending={dashboard.pending as any}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      done={dashboard.done as any}
      summary={dashboard.summary}
      pendingPreviewLimit={PENDING_PREVIEW_LIMIT}
      completedPage={completedPage}
      completedPageSize={COMPLETED_PAGE_SIZE}
      departments={departments ?? []}
      doctors={doctors ?? []}
      scope={scope}
      dateInput={dateStr || ""}
      activeDept={filterDept}
      hideScopeFilters={isDoctor}
      activeOutcome={filterOutcome}
      activeQuery={name || q || file || nat || phone}
      range={{
        start: range.start.toISOString(),
        end: range.end.toISOString(),
      }}
      readOnly={isDoctor}
    />
  );
}
