import "server-only";

import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/rbac";
import {
  countAllOperatorClinics,
  loadOperatorGrowthSource,
  loadOperatorAiProviderHealthSource,
  loadOperatorAiUsageReport,
  loadOperatorUserAggregateSource,
  queryOperatorClinicReport,
} from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  REPORT_AGGREGATE_SOURCE_LIMIT,
  REPORT_EXPORT_LIMIT,
  exportReportCsv,
  type OperatorReportDefinition,
  type ParsedReportParams,
  type ReportFilterOption,
  type ReportQueryMode,
  type ReportQueryResult,
  type ReportRow,
} from "./types";

const ALL = { value: "all", label: "All" } as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const dateSchema = z.string().regex(DATE_PATTERN).refine(isValidDateOnly);
const monthSchema = z.string().regex(MONTH_PATTERN).refine(isValidMonth);
const shortTextSchema = z.string().trim().min(1).max(80);
const countrySchema = z.union([z.literal("all"), z.string().regex(/^[A-Z]{2}$/)]);
const subscriptionStatusSchema = z.enum([
  "all",
  "live",
  "trialing",
  "active",
  "past_due",
  "cancelled",
]);
const invitationStatusSchema = z.enum([
  "all",
  "pending",
  "accepted",
  "revoked",
  "expired",
]);
const yesNoSchema = z.enum(["all", "yes", "no"]);
const onboardingSchema = z.enum(["all", "complete", "incomplete"]);
const aiCredentialModeSchema = z.enum(["all", "managed", "byok_strict", "hybrid"]);
const aiProviderHealthSchema = z.enum([
  "all",
  "not_connected",
  "valid",
  "invalid",
  "insufficient_scope",
  "quota",
  "provider_unavailable",
]);
const idSchema = z.union([z.literal("all"), z.string().uuid()]);
const slugSchema = z.union([
  z.literal("all"),
  z.string().regex(/^[a-z0-9][a-z0-9_-]{0,49}$/),
]);

type DirectResult = {
  data: unknown[] | null;
  error: { message: string } | null;
  count: number | null;
};
type RangeableQuery = {
  range: (from: number, to: number) => PromiseLike<DirectResult>;
};

function isValidDateOnly(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isValidMonth(value: string): boolean {
  if (!MONTH_PATTERN.test(value)) return false;
  const [year, month] = value.split("-").map(Number);
  return Boolean(year && month && month >= 1 && month <= 12);
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthOnly(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function daysAgo(now: Date, days: number): string {
  return dateOnly(new Date(now.getTime() - days * 86_400_000));
}

function monthsAgo(now: Date, months: number): string {
  return monthOnly(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1)),
  );
}

function startOfDate(value: string): string | undefined {
  return value ? `${value}T00:00:00.000Z` : undefined;
}

function endOfDateExclusive(value: string): string | undefined {
  if (!value) return undefined;
  return new Date(
    new Date(`${value}T00:00:00.000Z`).getTime() + 86_400_000,
  ).toISOString();
}

function startOfMonth(value: string): string | undefined {
  return value ? `${value}-01T00:00:00.000Z` : undefined;
}

function endOfMonthExclusive(value: string): string | undefined {
  if (!value) return undefined;
  const [year, month] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month!, 1)).toISOString();
}

function normalizeRange(
  fromKey: string,
  toKey: string,
  fallback: (now: Date) => [string, string],
) {
  return (params: ParsedReportParams, now: Date): ParsedReportParams => {
    const from = params.filters[fromKey];
    const to = params.filters[toKey];
    if (from && to && from > to) {
      const [safeFrom, safeTo] = fallback(now);
      return {
        ...params,
        filters: { ...params.filters, [fromKey]: safeFrom, [toKey]: safeTo },
        page: 1,
      };
    }
    return params;
  };
}

function definition(
  input: Omit<OperatorReportDefinition, "export">,
): OperatorReportDefinition {
  const report: OperatorReportDefinition = {
    ...input,
    export: (rows) => exportReportCsv(report, rows),
  };
  return report;
}

async function fetchDirectReport(input: {
  name: string;
  params: ParsedReportParams;
  mode: ReportQueryMode;
  build: (includeCount: boolean) => RangeableQuery;
  map: (row: unknown) => ReportRow;
  countAll: () => Promise<number>;
}): Promise<ReportQueryResult> {
  if (input.mode === "export") {
    const rows: ReportRow[] = [];
    let total = 0;
    for (let from = 0; from < REPORT_EXPORT_LIMIT; from += 1_000) {
      const to = Math.min(REPORT_EXPORT_LIMIT, from + 1_000) - 1;
      const result = await input.build(from === 0).range(from, to);
      if (result.error) throw new Error(`Unable to load ${input.name} report.`);
      if (from === 0) total = result.count ?? result.data?.length ?? 0;
      rows.push(...(result.data ?? []).map(input.map));
      if ((result.data?.length ?? 0) < to - from + 1) break;
    }
    return {
      rows,
      total,
      page: 1,
      pageSize: REPORT_EXPORT_LIMIT,
      totalPages: total === 0 ? 1 : Math.ceil(total / REPORT_EXPORT_LIMIT),
      hasAnyData: total > 0 || (await input.countAll()) > 0,
      sourceTruncated: total > rows.length,
    };
  }

  const requestedFrom = (input.params.page - 1) * input.params.pageSize;
  let result = await input
    .build(true)
    .range(requestedFrom, requestedFrom + input.params.pageSize - 1);
  if (result.error) throw new Error(`Unable to load ${input.name} report.`);
  const total = result.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / input.params.pageSize));
  const page = Math.min(input.params.page, totalPages);
  if (page !== input.params.page && total > 0) {
    const from = (page - 1) * input.params.pageSize;
    result = await input.build(false).range(from, from + input.params.pageSize - 1);
    if (result.error) throw new Error(`Unable to load ${input.name} report.`);
  }
  return {
    rows: (result.data ?? []).map(input.map),
    total,
    page,
    pageSize: input.params.pageSize,
    totalPages,
    hasAnyData: total > 0 || (await input.countAll()) > 0,
  };
}

function paginateDerived(
  rows: ReportRow[],
  params: ParsedReportParams,
  mode: ReportQueryMode,
  hasAnyData: boolean,
  sourceTruncated = false,
): ReportQueryResult {
  const total = rows.length;
  if (mode === "export") {
    const exportRows = rows.slice(0, REPORT_EXPORT_LIMIT);
    return {
      rows: exportRows,
      total,
      page: 1,
      pageSize: REPORT_EXPORT_LIMIT,
      totalPages: Math.max(1, Math.ceil(total / REPORT_EXPORT_LIMIT)),
      hasAnyData,
      sourceTruncated: sourceTruncated || total > exportRows.length,
    };
  }
  const totalPages = Math.max(1, Math.ceil(total / params.pageSize));
  const page = Math.min(params.page, totalPages);
  const from = (page - 1) * params.pageSize;
  return {
    rows: rows.slice(from, from + params.pageSize),
    total,
    page,
    pageSize: params.pageSize,
    totalPages,
    hasAnyData,
    sourceTruncated,
  };
}

async function clinicsQuery(
  params: ParsedReportParams,
  mode: ReportQueryMode = "page",
): Promise<ReportQueryResult> {
  await requirePlatformAdmin();
  const input = {
    country: params.filters.country === "all" ? undefined : params.filters.country,
    onboarding:
      params.filters.onboarding === "all"
        ? undefined
        : (params.filters.onboarding as "complete" | "incomplete"),
    createdFrom: startOfDate(params.filters.createdFrom!),
    createdToExclusive: endOfDateExclusive(params.filters.createdTo!),
    sort: params.sort as "name" | "country" | "created_at",
    ascending: params.direction === "asc",
  };
  const countAll = async () => (await countAllOperatorClinics()).count ?? 0;

  if (mode === "export") {
    const rows: ReportRow[] = [];
    let total = 0;
    for (let from = 0; from < REPORT_EXPORT_LIMIT; from += 1_000) {
      const to = Math.min(REPORT_EXPORT_LIMIT, from + 1_000) - 1;
      const result = await queryOperatorClinicReport({
        ...input,
        from,
        to,
        count: from === 0,
      });
      if (result.error) throw new Error("Unable to load clinics report.");
      if (from === 0) total = result.count ?? result.data?.length ?? 0;
      rows.push(
        ...(result.data ?? []).map((row) => ({
          clinic_id: row.id,
          name: row.name,
          country: row.country,
          onboarding: row.onboarding_completed_at ? "Complete" : "Incomplete",
          created_at: row.created_at,
        })),
      );
      if ((result.data?.length ?? 0) < to - from + 1) break;
    }
    return {
      rows,
      total,
      page: 1,
      pageSize: REPORT_EXPORT_LIMIT,
      totalPages: Math.max(1, Math.ceil(total / REPORT_EXPORT_LIMIT)),
      hasAnyData: total > 0 || (await countAll()) > 0,
      sourceTruncated: total > rows.length,
    };
  }

  const requestedFrom = (params.page - 1) * params.pageSize;
  let result = await queryOperatorClinicReport({
    ...input,
    from: requestedFrom,
    to: requestedFrom + params.pageSize - 1,
  });
  if (result.error) throw new Error("Unable to load clinics report.");
  const total = result.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / params.pageSize));
  const page = Math.min(params.page, totalPages);
  if (page !== params.page && total > 0) {
    const from = (page - 1) * params.pageSize;
    result = await queryOperatorClinicReport({
      ...input,
      from,
      to: from + params.pageSize - 1,
      count: false,
    });
    if (result.error) throw new Error("Unable to load clinics report.");
  }
  return {
    rows: (result.data ?? []).map((row) => ({
      clinic_id: row.id,
      name: row.name,
      country: row.country,
      onboarding: row.onboarding_completed_at ? "Complete" : "Incomplete",
      created_at: row.created_at,
    })),
    total,
    page,
    pageSize: params.pageSize,
    totalPages,
    hasAnyData: total > 0 || (await countAll()) > 0,
  };
}

async function usersQuery(
  params: ParsedReportParams,
  mode: ReportQueryMode = "page",
): Promise<ReportQueryResult> {
  await requirePlatformAdmin();
  const source = await loadOperatorUserAggregateSource({
    clinicId: params.filters.clinic === "all" ? undefined : params.filters.clinic,
    limit: REPORT_AGGREGATE_SOURCE_LIMIT,
  });
  if (source.error || !source.data) throw new Error("Unable to load users report.");
  const grouped = new Map<string, { count: number; latest: string | null }>();
  for (const profile of source.data.profiles) {
    const item = grouped.get(profile.clinic_id) ?? { count: 0, latest: null };
    item.count += 1;
    if (!item.latest || profile.created_at > item.latest) item.latest = profile.created_at;
    grouped.set(profile.clinic_id, item);
  }
  const from = startOfDate(params.filters.signupFrom!);
  const to = endOfDateExclusive(params.filters.signupTo!);
  const rows: ReportRow[] = source.data.clinics
    .map((clinic) => ({
      clinic_id: clinic.id,
      clinic_name: clinic.name,
      user_count: grouped.get(clinic.id)?.count ?? 0,
      latest_signup: grouped.get(clinic.id)?.latest ?? null,
    }))
    .filter((row) => {
      if (from && (!row.latest_signup || row.latest_signup < from)) return false;
      if (to && (!row.latest_signup || row.latest_signup >= to)) return false;
      return true;
    });
  const factor = params.direction === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    if (params.sort === "user_count") {
      return (Number(a.user_count) - Number(b.user_count)) * factor;
    }
    return String(a[params.sort] ?? "").localeCompare(String(b[params.sort] ?? "")) * factor;
  });
  return paginateDerived(
    rows,
    params,
    mode,
    source.data.clinics.length > 0,
    source.data.truncated,
  );
}

async function invitationsQuery(
  params: ParsedReportParams,
  mode: ReportQueryMode = "page",
) {
  await requirePlatformAdmin();
  const db = await createClient();
  return fetchDirectReport({
    name: "invitations",
    params,
    mode,
    build: (includeCount) => {
      let query = db.from("clinic_invitations").select(
        "id, accepted_clinic_id, clinic_name, status, created_at, email_sent_at",
        { count: includeCount ? "exact" : undefined },
      );
      if (params.filters.status !== "all") query = query.eq("status", params.filters.status as "pending" | "accepted" | "revoked" | "expired");
      if (params.filters.clinic !== "all") query = query.eq("accepted_clinic_id", params.filters.clinic);
      if (params.filters.emailSent === "yes") query = query.not("email_sent_at", "is", null);
      if (params.filters.emailSent === "no") query = query.is("email_sent_at", null);
      const from = startOfDate(params.filters.createdFrom!);
      const to = endOfDateExclusive(params.filters.createdTo!);
      if (from) query = query.gte("created_at", from);
      if (to) query = query.lt("created_at", to);
      return query.order("created_at", { ascending: params.direction === "asc" });
    },
    map: (raw) => {
      const row = raw as {
        id: string;
        accepted_clinic_id: string | null;
        clinic_name: string;
        status: string;
        created_at: string;
        email_sent_at: string | null;
      };
      return {
        invitation_id: row.id,
        clinic_id: row.accepted_clinic_id,
        clinic_name: row.clinic_name,
        status: row.status,
        created_at: row.created_at,
        email_sent_at: row.email_sent_at,
      };
    },
    countAll: async () =>
      (await db.from("clinic_invitations").select("id", { count: "exact", head: true })).count ?? 0,
  });
}

type PlanRelation = {
  slug: string;
  name_en: string;
  monthly_price_usd: number;
} | null;

async function revenueQuery(
  params: ParsedReportParams,
  mode: ReportQueryMode = "page",
) {
  await requirePlatformAdmin();
  const db = await createClient();
  return fetchDirectReport({
    name: "revenue",
    params,
    mode,
    build: (includeCount) => {
      let query = db.from("subscriptions").select(
        "clinic_id, status, current_period_end, plans!inner(slug, name_en, monthly_price_usd)",
        { count: includeCount ? "exact" : undefined },
      );
      if (params.filters.plan !== "all") query = query.eq("plans.slug", params.filters.plan);
      if (params.filters.status === "live") query = query.in("status", ["active", "trialing"]);
      else if (params.filters.status !== "all") query = query.eq("status", params.filters.status as "trialing" | "active" | "past_due" | "cancelled");
      const from = startOfDate(params.filters.renewalFrom!);
      const to = endOfDateExclusive(params.filters.renewalTo!);
      if (from) query = query.gte("current_period_end", from);
      if (to) query = query.lt("current_period_end", to);
      return query.order("current_period_end", {
        ascending: params.direction === "asc",
        nullsFirst: false,
      });
    },
    map: (raw) => {
      const row = raw as {
        clinic_id: string;
        status: string;
        current_period_end: string | null;
        plans: PlanRelation;
      };
      return {
        clinic_id: row.clinic_id,
        plan: row.plans?.name_en ?? null,
        monthly_price_usd: row.plans?.monthly_price_usd ?? 0,
        status: row.status,
        current_period_end: row.current_period_end,
      };
    },
    countAll: async () =>
      (await db.from("subscriptions").select("id", { count: "exact", head: true })).count ?? 0,
  });
}

async function subscriptionsQuery(
  params: ParsedReportParams,
  mode: ReportQueryMode = "page",
) {
  await requirePlatformAdmin();
  const db = await createClient();
  return fetchDirectReport({
    name: "subscriptions",
    params,
    mode,
    build: (includeCount) => {
      let query = db.from("subscriptions").select(
        "clinic_id, status, provider, current_period_end, trial_ends_at, plans!inner(slug, name_en)",
        { count: includeCount ? "exact" : undefined },
      );
      if (params.filters.status !== "all") query = query.eq("status", params.filters.status as "trialing" | "active" | "past_due" | "cancelled");
      if (params.filters.provider !== "all") query = query.eq("provider", params.filters.provider);
      if (params.filters.plan !== "all") query = query.eq("plans.slug", params.filters.plan);
      const from = startOfDate(params.filters.trialFrom!);
      const to = endOfDateExclusive(params.filters.trialTo!);
      if (from) query = query.gte("trial_ends_at", from);
      if (to) query = query.lt("trial_ends_at", to);
      const sortColumn = params.sort === "trial_ends_at" ? "trial_ends_at" : "current_period_end";
      return query.order(sortColumn, {
        ascending: params.direction === "asc",
        nullsFirst: false,
      });
    },
    map: (raw) => {
      const row = raw as {
        clinic_id: string;
        status: string;
        provider: string;
        current_period_end: string | null;
        trial_ends_at: string | null;
        plans: { slug: string; name_en: string } | null;
      };
      return {
        clinic_id: row.clinic_id,
        plan: row.plans?.name_en ?? null,
        status: row.status,
        provider: row.provider,
        trial_ends_at: row.trial_ends_at,
        current_period_end: row.current_period_end,
      };
    },
    countAll: async () =>
      (await db.from("subscriptions").select("id", { count: "exact", head: true })).count ?? 0,
  });
}

async function activityQuery(
  params: ParsedReportParams,
  mode: ReportQueryMode = "page",
) {
  await requirePlatformAdmin();
  const db = await createClient();
  return fetchDirectReport({
    name: "activity",
    params,
    mode,
    build: (includeCount) => {
      let query = db.from("platform_audit_logs").select(
        "id, action, target_type, created_at",
        { count: includeCount ? "exact" : undefined },
      );
      if (params.filters.action) query = query.eq("action", params.filters.action);
      if (params.filters.targetType) query = query.eq("target_type", params.filters.targetType);
      const from = startOfDate(params.filters.createdFrom!);
      const to = endOfDateExclusive(params.filters.createdTo!);
      if (from) query = query.gte("created_at", from);
      if (to) query = query.lt("created_at", to);
      return query.order("created_at", { ascending: params.direction === "asc" });
    },
    map: (raw) => {
      const row = raw as { id: string; action: string; target_type: string; created_at: string };
      return { audit_id: row.id, action: row.action, target_type: row.target_type, created_at: row.created_at };
    },
    countAll: async () =>
      (await db.from("platform_audit_logs").select("id", { count: "exact", head: true })).count ?? 0,
  });
}

function monthSequence(from: string, to: string): string[] {
  const [fromYear, fromMonth] = from.split("-").map(Number);
  const [toYear, toMonth] = to.split("-").map(Number);
  const rows: string[] = [];
  const cursor = new Date(Date.UTC(fromYear!, fromMonth! - 1, 1));
  const end = new Date(Date.UTC(toYear!, toMonth! - 1, 1));
  while (cursor <= end && rows.length < 1_200) {
    rows.push(monthOnly(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return rows;
}

async function growthQuery(
  params: ParsedReportParams,
  mode: ReportQueryMode = "page",
) {
  await requirePlatformAdmin();
  const source = await loadOperatorGrowthSource({
    createdFrom: startOfMonth(params.filters.monthFrom!),
    createdToExclusive: endOfMonthExclusive(params.filters.monthTo!),
    limit: REPORT_AGGREGATE_SOURCE_LIMIT,
  });
  if (source.error || !source.data) throw new Error("Unable to load growth report.");
  const counts = new Map<string, number>();
  for (const row of source.data) {
    const month = row.created_at.slice(0, 7);
    counts.set(month, (counts.get(month) ?? 0) + 1);
  }
  const months = params.filters.monthFrom && params.filters.monthTo
    ? monthSequence(params.filters.monthFrom, params.filters.monthTo)
    : [...counts.keys()].sort();
  const rows: ReportRow[] = months.map((month) => ({
    month,
    new_clinics: counts.get(month) ?? 0,
  }));
  const factor = params.direction === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    if (params.sort === "new_clinics") {
      return (Number(a.new_clinics) - Number(b.new_clinics)) * factor;
    }
    return String(a.month).localeCompare(String(b.month)) * factor;
  });
  return paginateDerived(
    rows,
    params,
    mode,
    source.count > 0,
    source.truncated,
  );
}

function microsToUsd(value: number): number {
  return Number((value / 1_000_000).toFixed(6));
}

async function aiUsageQuery(
  params: ParsedReportParams,
  mode: ReportQueryMode = "page",
) {
  await requirePlatformAdmin();
  const source = await loadOperatorAiUsageReport({
    periodFrom: `${params.filters.monthFrom}-01`,
    periodTo: `${params.filters.monthTo}-01`,
    clinicId: params.filters.clinic === "all" ? undefined : params.filters.clinic,
  });
  if (source.error) throw new Error("Unable to load AI usage report.");
  const rows: ReportRow[] = (source.data ?? []).map((row) => ({
    clinic_id: row.clinic_id,
    clinic_name: row.clinic_name,
    period_start: row.period_start,
    allowance_used_percent: row.budget_limit_micros > 0
      ? Number((((row.managed_spent_micros + row.reserved_micros) / row.budget_limit_micros) * 100).toFixed(1))
      : 100,
    managed_cost_usd: microsToUsd(row.managed_spent_micros),
    provider_cost_usd: microsToUsd(row.provider_cost_micros),
    budget_usd: microsToUsd(row.budget_limit_micros),
    requests: `${row.request_used}/${row.request_limit}`,
  }));
  const factor = params.direction === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const left = a[params.sort];
    const right = b[params.sort];
    if (typeof left === "number" && typeof right === "number") return (left - right) * factor;
    return String(left ?? "").localeCompare(String(right ?? "")) * factor;
  });
  return paginateDerived(rows, params, mode, rows.length > 0);
}

async function aiProviderHealthQuery(
  params: ParsedReportParams,
  mode: ReportQueryMode = "page",
) {
  await requirePlatformAdmin();
  const source = await loadOperatorAiProviderHealthSource();
  if (source.error || !source.data) throw new Error("Unable to load AI provider health report.");
  const rows: ReportRow[] = source.data
    .filter((row) => params.filters.clinic === "all" || row.clinic_id === params.filters.clinic)
    .filter((row) => params.filters.mode === "all" || row.credential_mode === params.filters.mode)
    .filter((row) => {
      if (params.filters.health === "all") return true;
      if (params.filters.health === "not_connected") return row.health_status === null;
      return row.health_status === params.filters.health;
    })
    .map((row) => ({
      clinic_id: row.clinic_id,
      clinic_name: row.clinic_name,
      credential_mode: row.credential_mode,
      provider: row.provider,
      health_status: row.health_status ?? "not_connected",
      last_error_code: row.last_error_code,
      tested_at: row.tested_at,
      policy_updated_at: row.policy_updated_at,
    }));
  const factor = params.direction === "asc" ? 1 : -1;
  rows.sort((a, b) =>
    String(a[params.sort] ?? "").localeCompare(String(b[params.sort] ?? "")) * factor,
  );
  return paginateDerived(rows, params, mode, source.data.length > 0);
}

const reports: OperatorReportDefinition[] = [
  definition({
    id: "clinics",
    title: "Clinics",
    description: "Tenant metadata and onboarding state.",
    columns: [
      { key: "name", label: "Clinic", sortable: true },
      { key: "country", label: "Country", sortable: true },
      { key: "onboarding", label: "Onboarding" },
      { key: "created_at", label: "Created", sortable: true },
    ],
    filters: [
      { key: "country", label: "Country", kind: "combobox", defaultValue: "all", clearValue: "all", schema: countrySchema, optionSource: "countries", placeholder: "All countries" },
      { key: "onboarding", label: "Onboarding", kind: "select", defaultValue: "all", clearValue: "all", schema: onboardingSchema, options: [ALL, { value: "complete", label: "Complete" }, { value: "incomplete", label: "Incomplete" }] },
      { key: "createdFrom", label: "Created from", kind: "date", defaultValue: (now) => daysAgo(now, 89), clearValue: "", schema: dateSchema },
      { key: "createdTo", label: "Created to", kind: "date", defaultValue: dateOnly, clearValue: "", schema: dateSchema },
    ],
    sorts: [
      { key: "created_at", label: "Created", defaultDirection: "desc" },
      { key: "name", label: "Clinic", defaultDirection: "asc" },
      { key: "country", label: "Country", defaultDirection: "asc" },
    ],
    defaultSort: "created_at",
    normalize: normalizeRange("createdFrom", "createdTo", (now) => [daysAgo(now, 89), dateOnly(now)]),
    query: clinicsQuery,
  }),
  definition({
    id: "users",
    title: "Users",
    description: "Platform-safe user totals by clinic; no personal fields.",
    columns: [
      { key: "clinic_name", label: "Clinic", sortable: true },
      { key: "user_count", label: "Users", numeric: true, sortable: true },
      { key: "latest_signup", label: "Latest signup", sortable: true },
    ],
    filters: [
      { key: "clinic", label: "Clinic", kind: "combobox", defaultValue: "all", clearValue: "all", schema: idSchema, optionSource: "clinics", placeholder: "All clinics" },
      { key: "signupFrom", label: "Latest signup from", kind: "date", defaultValue: "", clearValue: "", schema: dateSchema },
      { key: "signupTo", label: "Latest signup to", kind: "date", defaultValue: "", clearValue: "", schema: dateSchema },
    ],
    sorts: [
      { key: "user_count", label: "Users", defaultDirection: "desc" },
      { key: "latest_signup", label: "Latest signup", defaultDirection: "desc" },
      { key: "clinic_name", label: "Clinic", defaultDirection: "asc" },
    ],
    defaultSort: "user_count",
    normalize: normalizeRange("signupFrom", "signupTo", () => ["", ""]),
    query: usersQuery,
  }),
  definition({
    id: "invitations",
    title: "Invitations",
    description: "Invitation lifecycle and email delivery state.",
    columns: [
      { key: "clinic_name", label: "Clinic" },
      { key: "status", label: "Status" },
      { key: "created_at", label: "Created", sortable: true },
      { key: "email_sent_at", label: "Email sent" },
    ],
    filters: [
      { key: "status", label: "Status", kind: "select", defaultValue: "pending", clearValue: "all", schema: invitationStatusSchema, options: [ALL, { value: "pending", label: "Pending" }, { value: "accepted", label: "Accepted" }, { value: "revoked", label: "Revoked" }, { value: "expired", label: "Expired" }] },
      { key: "clinic", label: "Accepted clinic", kind: "combobox", defaultValue: "all", clearValue: "all", schema: idSchema, optionSource: "clinics", placeholder: "All clinics" },
      { key: "createdFrom", label: "Created from", kind: "date", defaultValue: (now) => daysAgo(now, 29), clearValue: "", schema: dateSchema },
      { key: "createdTo", label: "Created to", kind: "date", defaultValue: dateOnly, clearValue: "", schema: dateSchema },
      { key: "emailSent", label: "Email sent", kind: "select", defaultValue: "all", clearValue: "all", schema: yesNoSchema, options: [ALL, { value: "yes", label: "Yes" }, { value: "no", label: "No" }] },
    ],
    sorts: [{ key: "created_at", label: "Created", defaultDirection: "desc" }],
    defaultSort: "created_at",
    normalize: normalizeRange("createdFrom", "createdTo", (now) => [daysAgo(now, 29), dateOnly(now)]),
    query: invitationsQuery,
  }),
  definition({
    id: "revenue",
    title: "Revenue",
    description: "Canonical USD recurring plan revenue.",
    columns: [
      { key: "plan", label: "Plan" },
      { key: "monthly_price_usd", label: "Monthly USD", numeric: true },
      { key: "status", label: "Status" },
      { key: "current_period_end", label: "Period end", sortable: true },
    ],
    filters: [
      { key: "plan", label: "Plan", kind: "combobox", defaultValue: "all", clearValue: "all", schema: slugSchema, optionSource: "plans", placeholder: "All plans" },
      { key: "status", label: "Subscription status", kind: "select", defaultValue: "live", clearValue: "all", schema: subscriptionStatusSchema, options: [ALL, { value: "live", label: "Active + trialing" }, { value: "active", label: "Active" }, { value: "trialing", label: "Trialing" }, { value: "past_due", label: "Past due" }, { value: "cancelled", label: "Cancelled" }] },
      { key: "renewalFrom", label: "Renewal from", kind: "date", defaultValue: "", clearValue: "", schema: dateSchema },
      { key: "renewalTo", label: "Renewal to", kind: "date", defaultValue: "", clearValue: "", schema: dateSchema },
    ],
    sorts: [{ key: "current_period_end", label: "Period end", defaultDirection: "asc" }],
    defaultSort: "current_period_end",
    normalize: normalizeRange("renewalFrom", "renewalTo", () => ["", ""]),
    query: revenueQuery,
  }),
  definition({
    id: "subscriptions",
    title: "Subscriptions",
    description: "Current subscription states and providers.",
    columns: [
      { key: "plan", label: "Plan" },
      { key: "status", label: "Status" },
      { key: "provider", label: "Provider" },
      { key: "trial_ends_at", label: "Trial ends", sortable: true },
      { key: "current_period_end", label: "Period end", sortable: true },
    ],
    filters: [
      { key: "status", label: "Status", kind: "select", defaultValue: "all", clearValue: "all", schema: subscriptionStatusSchema.exclude(["live"]), options: [ALL, { value: "active", label: "Active" }, { value: "trialing", label: "Trialing" }, { value: "past_due", label: "Past due" }, { value: "cancelled", label: "Cancelled" }] },
      { key: "provider", label: "Provider", kind: "text", defaultValue: "all", clearValue: "all", schema: slugSchema, placeholder: "manual" },
      { key: "plan", label: "Plan", kind: "combobox", defaultValue: "all", clearValue: "all", schema: slugSchema, optionSource: "plans", placeholder: "All plans" },
      { key: "trialFrom", label: "Trial ending from", kind: "date", defaultValue: "", clearValue: "", schema: dateSchema },
      { key: "trialTo", label: "Trial ending to", kind: "date", defaultValue: "", clearValue: "", schema: dateSchema },
    ],
    sorts: [
      { key: "current_period_end", label: "Period end", defaultDirection: "asc" },
      { key: "trial_ends_at", label: "Trial end", defaultDirection: "asc" },
    ],
    defaultSort: "current_period_end",
    normalize: (params, now) => {
      const normalized = normalizeRange("trialFrom", "trialTo", () => ["", ""])(params, now);
      if (normalized.filters.trialFrom || normalized.filters.trialTo) {
        return { ...normalized, filters: { ...normalized.filters, status: "trialing" } };
      }
      return normalized;
    },
    query: subscriptionsQuery,
  }),
  definition({
    id: "activity",
    title: "Activity",
    description: "Audited operator actions.",
    columns: [
      { key: "action", label: "Action" },
      { key: "target_type", label: "Target" },
      { key: "created_at", label: "Time", sortable: true },
    ],
    filters: [
      { key: "action", label: "Action", kind: "text", defaultValue: "", clearValue: "", schema: shortTextSchema, placeholder: "Exact action" },
      { key: "targetType", label: "Target type", kind: "text", defaultValue: "", clearValue: "", schema: shortTextSchema, placeholder: "Exact target type" },
      { key: "createdFrom", label: "From", kind: "date", defaultValue: (now) => daysAgo(now, 6), clearValue: "", schema: dateSchema },
      { key: "createdTo", label: "To", kind: "date", defaultValue: dateOnly, clearValue: "", schema: dateSchema },
    ],
    sorts: [{ key: "created_at", label: "Time", defaultDirection: "desc" }],
    defaultSort: "created_at",
    normalize: normalizeRange("createdFrom", "createdTo", (now) => [daysAgo(now, 6), dateOnly(now)]),
    query: activityQuery,
  }),
  definition({
    id: "growth",
    title: "Growth",
    description: "Monthly new-clinic totals.",
    columns: [
      { key: "month", label: "Month", sortable: true },
      { key: "new_clinics", label: "New clinics", numeric: true, sortable: true },
    ],
    filters: [
      { key: "monthFrom", label: "Month from", kind: "month", defaultValue: (now) => monthsAgo(now, 11), clearValue: "", schema: monthSchema },
      { key: "monthTo", label: "Month to", kind: "month", defaultValue: monthOnly, clearValue: "", schema: monthSchema },
    ],
    sorts: [
      { key: "month", label: "Month", defaultDirection: "asc" },
      { key: "new_clinics", label: "New clinics", defaultDirection: "desc" },
    ],
    defaultSort: "month",
    normalize: normalizeRange("monthFrom", "monthTo", (now) => [monthsAgo(now, 11), monthOnly(now)]),
    query: growthQuery,
  }),
  definition({
    id: "ai-usage",
    title: "AI usage and cost",
    description: "Content-free monthly allowance, managed cost, provider cost, and request totals.",
    columns: [
      { key: "clinic_name", label: "Clinic", sortable: true },
      { key: "period_start", label: "Period", sortable: true },
      { key: "allowance_used_percent", label: "Allowance used %", numeric: true, sortable: true },
      { key: "managed_cost_usd", label: "Managed cost USD", numeric: true, sortable: true },
      { key: "provider_cost_usd", label: "All provider cost USD", numeric: true, sortable: true },
      { key: "budget_usd", label: "Budget USD", numeric: true, sortable: true },
      { key: "requests", label: "Requests" },
    ],
    filters: [
      { key: "clinic", label: "Clinic", kind: "combobox", defaultValue: "all", clearValue: "all", schema: idSchema, optionSource: "clinics", placeholder: "All clinics" },
      { key: "monthFrom", label: "Month from", kind: "month", defaultValue: (now) => monthsAgo(now, 11), clearValue: "", schema: monthSchema },
      { key: "monthTo", label: "Month to", kind: "month", defaultValue: monthOnly, clearValue: "", schema: monthSchema },
    ],
    sorts: [
      { key: "period_start", label: "Period", defaultDirection: "desc" },
      { key: "clinic_name", label: "Clinic", defaultDirection: "asc" },
      { key: "allowance_used_percent", label: "Allowance used", defaultDirection: "desc" },
      { key: "managed_cost_usd", label: "Managed cost", defaultDirection: "desc" },
      { key: "provider_cost_usd", label: "Provider cost", defaultDirection: "desc" },
      { key: "budget_usd", label: "Budget", defaultDirection: "desc" },
    ],
    defaultSort: "period_start",
    normalize: normalizeRange("monthFrom", "monthTo", (now) => [monthsAgo(now, 11), monthOnly(now)]),
    query: aiUsageQuery,
  }),
  definition({
    id: "ai-provider-health",
    title: "AI provider health",
    description: "Safe tenant provider mode and health metadata; credentials and fingerprints are excluded.",
    columns: [
      { key: "clinic_name", label: "Clinic", sortable: true },
      { key: "credential_mode", label: "Mode", sortable: true },
      { key: "provider", label: "Provider" },
      { key: "health_status", label: "Health", sortable: true },
      { key: "last_error_code", label: "Sanitized error" },
      { key: "tested_at", label: "Last tested", sortable: true },
      { key: "policy_updated_at", label: "Policy updated" },
    ],
    filters: [
      { key: "clinic", label: "Clinic", kind: "combobox", defaultValue: "all", clearValue: "all", schema: idSchema, optionSource: "clinics", placeholder: "All clinics" },
      { key: "mode", label: "Provider mode", kind: "select", defaultValue: "all", clearValue: "all", schema: aiCredentialModeSchema, options: [ALL, { value: "managed", label: "Managed" }, { value: "byok_strict", label: "Strict BYOK" }, { value: "hybrid", label: "Hybrid" }] },
      { key: "health", label: "Health", kind: "select", defaultValue: "all", clearValue: "all", schema: aiProviderHealthSchema, options: [ALL, { value: "not_connected", label: "Not connected" }, { value: "valid", label: "Valid" }, { value: "invalid", label: "Invalid" }, { value: "insufficient_scope", label: "Insufficient scope" }, { value: "quota", label: "Quota" }, { value: "provider_unavailable", label: "Provider unavailable" }] },
    ],
    sorts: [
      { key: "clinic_name", label: "Clinic", defaultDirection: "asc" },
      { key: "credential_mode", label: "Mode", defaultDirection: "asc" },
      { key: "health_status", label: "Health", defaultDirection: "asc" },
      { key: "tested_at", label: "Last tested", defaultDirection: "desc" },
    ],
    defaultSort: "clinic_name",
    query: aiProviderHealthQuery,
  }),
];

export const operatorReportRegistry = new Map(reports.map((report) => [report.id, report]));
export const operatorReports = reports;

export async function loadOperatorReportFilterOptions(
  report: OperatorReportDefinition,
): Promise<Record<string, readonly ReportFilterOption[]>> {
  await requirePlatformAdmin();
  const sources = new Set(report.filters.map((filter) => filter.optionSource).filter(Boolean));
  const result: Record<string, readonly ReportFilterOption[]> = {};
  let clinicOptions: ReportFilterOption[] = [];
  let countryOptions: ReportFilterOption[] = [];
  let planOptions: ReportFilterOption[] = [];

  if (sources.has("clinics") || sources.has("countries")) {
    const clinics = await queryOperatorClinicReport({
      sort: "name",
      ascending: true,
      from: 0,
      to: 499,
      count: false,
    });
    if (clinics.error) throw new Error("Unable to load report filter options.");
    clinicOptions = [
      ALL,
      ...(clinics.data ?? []).map((clinic) => ({ value: clinic.id, label: clinic.name })),
    ];
    const countries = [...new Set((clinics.data ?? []).map((clinic) => clinic.country))].sort();
    countryOptions = [ALL, ...countries.map((country) => ({ value: country, label: country }))];
  }

  if (sources.has("plans")) {
    const db = await createClient();
    const plans = await db.from("plans").select("slug, name_en").order("name_en");
    if (plans.error) throw new Error("Unable to load report filter options.");
    planOptions = [ALL, ...(plans.data ?? []).map((plan) => ({ value: plan.slug, label: plan.name_en }))];
  }

  for (const filter of report.filters) {
    if (filter.optionSource === "clinics") result[filter.key] = clinicOptions;
    if (filter.optionSource === "countries") result[filter.key] = countryOptions;
    if (filter.optionSource === "plans") result[filter.key] = planOptions;
    if (filter.options) result[filter.key] = filter.options;
  }
  return result;
}
