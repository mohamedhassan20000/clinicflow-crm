import type { Metadata } from "next";
import { requireUser } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { FollowupsView } from "@/components/followups/followups-view";
import { getLocale, getTranslations } from "next-intl/server";
import {
  buildFollowupsDocumentHref,
  resolveFollowupsDateRange,
} from "@/lib/followups/filters";
import { resolveFollowupPatientIds } from "@/lib/followups/data";
import type { Locale } from "@/lib/i18n/config";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataFollowUps") };
}

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
    from?: string;
    to?: string;
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
  const [user, locale] = await Promise.all([
    requireUser(),
    getLocale() as Promise<Locale>,
  ]);

  const isDoctor = user.role === "doctor";
  const isAssistant = user.role === "assistant";
  // Doctors and assistants get a data-scoped, read-only follow-ups view (RLS
  // filters to their own / their assigned doctors' follow-ups). Managers now
  // operate follow-ups like admins/receptionists.
  const isScopedViewer = isDoctor || isAssistant;

  const sp = await searchParams;
  const range = resolveFollowupsDateRange(sp);
  const q = sp.q?.trim() ?? "";
  const name = sp.name?.trim() ?? "";
  const file = sp.file?.trim() ?? "";
  const nat = sp.nat?.trim() ?? "";
  const phone = sp.phone?.trim() ?? "";
  // Doctors are always scoped to their own department; assistants are scoped by
  // RLS to their assigned doctors, so no app-layer dept/doctor filter is applied.
  const filterDept = isDoctor
    ? (user.departmentId ?? null)
    : isScopedViewer
      ? null
      : (sp.dept?.trim() || null);
  const filterDoctor = isScopedViewer ? null : (sp.doctor?.trim() || null);
  const filterOutcome = (() => {
    const v = sp.outcome?.trim();
    if (v === "all_fine" || v === "has_problem" || v === "no_response") return v;
    return null;
  })() satisfies FollowupOutcome | null;
  const completedPage = Math.max(1, Number(sp.completedPage ?? "1") || 1);
  const completedOffset = (completedPage - 1) * COMPLETED_PAGE_SIZE;
  const previewDocumentHref = buildFollowupsDocumentHref({
    range,
    locale,
    filters: {
      doctorId: filterDoctor,
      departmentId: filterDept,
      outcome: filterOutcome,
      patientQuery: q,
      patientName: name,
      patientFileNumber: file,
      patientNationalId: nat,
      patientPhone: phone,
    },
  });

  const supabase = await createClient();
  const departmentsPromise = supabase
    .from("departments")
    .select("id, name, color")
    .eq("clinic_id", user.clinicId)
    .eq("is_active", true)
    .order("name");
  const doctorsPromise = isScopedViewer
    ? Promise.resolve({ data: [] })
    : supabase
        .from("profiles")
        .select("id, full_name")
        .eq("clinic_id", user.clinicId)
        .eq("role", "doctor")
        .eq("is_active", true)
        .order("full_name");
  const patientIdFilter = await resolveFollowupPatientIds(user.clinicId, {
    query: q,
    name,
    fileNumber: file,
    nationalId: nat,
    phone,
  }, supabase);
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
      departmentsPromise,
      doctorsPromise,
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
      scope={range.scope}
      dateInput={range.scope === "day" ? range.from : ""}
      fromInput={range.from}
      toInput={range.to}
      hideScopeFilters={isScopedViewer}
      activeOutcome={filterOutcome}
      range={{
        start: range.start.toISOString(),
        end: range.end.toISOString(),
      }}
      previewDocumentHref={previewDocumentHref}
      // Doctors are read-only; assistants operate their assigned doctors'
      // follow-ups (RLS + scoped action guards enforce the union scope).
      readOnly={isDoctor}
    />
  );
}
