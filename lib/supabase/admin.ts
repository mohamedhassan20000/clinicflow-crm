import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { FxSnapshot } from "@/lib/currency/provider";
import { requirePlatformAdmin } from "@/lib/rbac";

/**
 * Service-role Supabase client. Server-only.
 * Use ONLY for privileged flows: staff provisioning, auth admin operations.
 * Never import this in a Client Component.
 */
export function createAdminClient() {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}

/** Platform-managed FX write boundary. Never accepts tenant financial data. */
export async function storeFxSnapshot(snapshot: FxSnapshot) {
  return createAdminClient().from("fx_rates").upsert(
    Object.entries(snapshot.rates).map(([currency_code, rate]) => ({
      currency_code,
      base_currency: snapshot.baseCurrency,
      rate,
      provider: snapshot.provider,
      provider_timestamp: snapshot.providerTimestamp,
      fetched_at: snapshot.fetchedAt,
      updated_at: snapshot.fetchedAt,
    })),
    { onConflict: "currency_code" },
  );
}

export async function provisionClinicOwner(input: {
  ownerId: string;
  tokenHash: string | null;
  clinicName: string;
  country: string;
  phone: string;
  ownerName: string;
  ownerEmail: string;
  locale: string;
}) {
  const admin = createAdminClient();
  return admin.rpc("create_clinic_with_owner", {
    p_owner_id: input.ownerId,
    p_invitation_token_hash: input.tokenHash ?? undefined,
    p_clinic_name: input.clinicName,
    p_country: input.country,
    p_phone: input.phone,
    p_owner_name: input.ownerName,
    p_owner_email: input.ownerEmail,
    p_locale: input.locale,
  });
}

export async function deleteSignupAuthUser(userId: string) {
  return createAdminClient().auth.admin.deleteUser(userId);
}

export type ResumableSignupUser = {
  userId: string;
  emailConfirmed: boolean;
};

export async function findResumableSignupUser(email: string): Promise<
  | { data: ResumableSignupUser | null; error: null }
  | { data: null; error: { message: string; code?: string } }
> {
  const result = await createAdminClient().rpc("find_resumable_clinic_owner", {
    p_email: email,
  });
  if (result.error) return { data: null, error: result.error };
  const row = result.data?.[0];
  return {
    data: row
      ? { userId: row.user_id, emailConfirmed: row.email_confirmed }
      : null,
    error: null,
  };
}

/**
 * Resets the password of an orphaned, unconfirmed clinic-owner signup user.
 * Callers must have verified the orphan via findResumableSignupUser AND hold
 * an invitation token bound to the orphan's email — never call this for a
 * confirmed account.
 */
export async function setSignupUserPassword(userId: string, password: string) {
  return createAdminClient().auth.admin.updateUserById(userId, { password });
}

export async function requestClinicInvitation(input: {
  clinicName: string;
  ownerName: string;
  phone: string;
  email: string;
}) {
  return createAdminClient().rpc("request_clinic_invitation", {
    p_clinic_name: input.clinicName,
    p_owner_name: input.ownerName,
    p_phone: input.phone,
    p_email: input.email,
  });
}

/**
 * Detail lists in the operator panel are explicitly bounded; headline totals
 * use the exact count returned alongside so they never depend on row-array
 * length (PostgREST caps each response at max_rows).
 */
export const OPERATOR_CLINIC_LIST_LIMIT = 500;

/**
 * Operator-panel clinic directory. `clinics` RLS is intentionally
 * clinic-members-only, so the platform-admin panel reads tenant *metadata*
 * (never clinical tables) through this reviewed helper. Callers must have
 * passed requirePlatformAdmin() first. Returns an exact total count plus the
 * newest OPERATOR_CLINIC_LIST_LIMIT rows.
 */
export async function listOperatorClinics(filters: { search?: string; country?: string } = {}) {
  let query = createAdminClient()
    .from("clinics")
    .select("id, name, phone, country, locale, timezone, onboarding_completed_at, created_at", {
      count: "exact",
    });

  if (filters.search) query = query.ilike("name", `%${filters.search}%`);
  if (filters.country) query = query.eq("country", filters.country);

  return query.order("created_at", { ascending: false }).limit(OPERATOR_CLINIC_LIST_LIMIT);
}

/** Reviewed metadata-only read for executive growth and registry reports. */
export async function listOperatorClinicMetadata() {
  return createAdminClient().from("clinics").select("id, name, country, created_at").order("created_at", { ascending: false }).limit(1000);
}

type OperatorClinicReportInput = {
  country?: string;
  onboarding?: "complete" | "incomplete";
  createdFrom?: string;
  createdToExclusive?: string;
  sort: "name" | "country" | "created_at";
  ascending: boolean;
  from: number;
  to: number;
  count?: boolean;
};

/**
 * Reviewed metadata-only WS7 query. The caller must re-guard with
 * requirePlatformAdmin(); this helper exists because clinic RLS deliberately
 * grants platform admins no direct tenant-row access.
 */
export async function queryOperatorClinicReport(input: OperatorClinicReportInput) {
  let query = createAdminClient()
    .from("clinics")
    .select("id, name, country, onboarding_completed_at, created_at", {
      count: input.count === false ? undefined : "exact",
    });
  if (input.country) query = query.eq("country", input.country);
  if (input.onboarding === "complete") {
    query = query.not("onboarding_completed_at", "is", null);
  } else if (input.onboarding === "incomplete") {
    query = query.is("onboarding_completed_at", null);
  }
  if (input.createdFrom) query = query.gte("created_at", input.createdFrom);
  if (input.createdToExclusive) query = query.lt("created_at", input.createdToExclusive);
  return query
    .order(input.sort, { ascending: input.ascending })
    .range(input.from, input.to);
}

export async function countAllOperatorClinics() {
  return createAdminClient().from("clinics").select("id", { count: "exact", head: true });
}

const OPERATOR_REPORT_SOURCE_CHUNK = 1_000;

async function collectOperatorRows<Row>(
  limit: number,
  load: (from: number, to: number) => PromiseLike<{
    data: Row[] | null;
    error: { message: string } | null;
    count: number | null;
  }>,
): Promise<
  | { data: Row[]; count: number; truncated: boolean; error: null }
  | { data: null; count: number; truncated: false; error: { message: string } }
> {
  const rows: Row[] = [];
  let exactCount = 0;
  for (let from = 0; from < limit; from += OPERATOR_REPORT_SOURCE_CHUNK) {
    const to = Math.min(limit, from + OPERATOR_REPORT_SOURCE_CHUNK) - 1;
    const result = await load(from, to);
    if (result.error) {
      return { data: null, count: 0, truncated: false, error: result.error };
    }
    if (from === 0) exactCount = result.count ?? result.data?.length ?? 0;
    rows.push(...(result.data ?? []));
    if ((result.data?.length ?? 0) < to - from + 1) break;
  }
  return {
    data: rows,
    count: exactCount,
    truncated: exactCount > rows.length,
    error: null,
  };
}

/**
 * Bounded aggregate inputs for the Users report. PostgREST aggregates are
 * disabled in the local/production-compatible configuration (PGRST123), so
 * this keeps the existing no-PHI shape while refusing an unbounded profile
 * materialization. Only clinic ids/names and profile clinic/timestamps cross
 * this boundary.
 */
export async function loadOperatorUserAggregateSource(input: {
  clinicId?: string;
  limit: number;
}) {
  const db = createAdminClient();
  const clinics = await collectOperatorRows(input.limit, (from, to) => {
    let query = db
      .from("clinics")
      .select("id, name", { count: "exact" })
      .order("name", { ascending: true });
    if (input.clinicId) query = query.eq("id", input.clinicId);
    return query.range(from, to);
  });
  if (clinics.error) return { data: null, error: clinics.error };

  const profiles = await collectOperatorRows(input.limit, (from, to) => {
    let query = db
      .from("profiles")
      .select("clinic_id, created_at", { count: "exact" })
      .order("created_at", { ascending: false });
    if (input.clinicId) query = query.eq("clinic_id", input.clinicId);
    return query.range(from, to);
  });
  if (profiles.error) return { data: null, error: profiles.error };

  return {
    data: {
      clinics: clinics.data,
      profiles: profiles.data,
      truncated: clinics.truncated || profiles.truncated,
    },
    error: null,
  };
}

/** Bounded clinic timestamps used only to derive month-level Growth rows. */
export async function loadOperatorGrowthSource(input: {
  createdFrom?: string;
  createdToExclusive?: string;
  limit: number;
}) {
  const db = createAdminClient();
  return collectOperatorRows(input.limit, (from, to) => {
    let query = db
      .from("clinics")
      .select("created_at", { count: "exact" })
      .order("created_at", { ascending: true });
    if (input.createdFrom) query = query.gte("created_at", input.createdFrom);
    if (input.createdToExclusive) query = query.lt("created_at", input.createdToExclusive);
    return query.range(from, to);
  });
}

export async function getOperatorAggregateInputs() {
  const db=createAdminClient(), now=new Date(), nowIso=now.toISOString();
  const monthStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)).toISOString(), previousStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,1)).toISOString(), sixMonthsStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-5,1)).toISOString();
  return Promise.all([
    db.from("subscriptions").select("clinic_id",{count:"exact",head:true}).eq("status","active").or(`current_period_end.is.null,current_period_end.gt.${nowIso}`),
    db.from("subscriptions").select("clinic_id",{count:"exact",head:true}).eq("status","trialing").gt("trial_ends_at",nowIso),
    db.from("clinics").select("id",{count:"exact",head:true}).gte("created_at",monthStart),
    db.from("clinics").select("id",{count:"exact",head:true}).gte("created_at",previousStart).lt("created_at",monthStart),
    db.from("profiles").select("id",{count:"exact",head:true}).gte("created_at",monthStart),
    db.from("profiles").select("id",{count:"exact",head:true}).gte("created_at",previousStart).lt("created_at",monthStart),
    db.from("clinics").select("id, created_at").gte("created_at",sixMonthsStart).order("created_at"),
  ]);
}

export async function listOperatorUserCounts() {
  const db=createAdminClient(); const [clinics,profiles]=await Promise.all([db.from("clinics").select("id, name"),db.from("profiles").select("clinic_id, created_at")]);
  if(clinics.error||profiles.error)return{data:null,error:clinics.error??profiles.error};
  const grouped=new Map<string,{count:number;latest:string|null}>();
  for(const row of profiles.data??[]){const item=grouped.get(row.clinic_id)??{count:0,latest:null};item.count++;if(!item.latest||row.created_at>item.latest)item.latest=row.created_at;grouped.set(row.clinic_id,item)}
  return{data:(clinics.data??[]).map(c=>({clinic_name:c.name,user_count:grouped.get(c.id)?.count??0,latest_signup:grouped.get(c.id)?.latest??null})),error:null};
}

export async function getExactActiveRevenueUsd() {
  const db=createAdminClient(),nowIso=new Date().toISOString();
  const plans=await db.from("plans").select("id, monthly_price_usd");
  if(plans.error)return{data:null,error:plans.error};
  let revenue=0;
  for(const plan of plans.data??[]){const count=await db.from("subscriptions").select("id",{count:"exact",head:true}).eq("plan_id",plan.id).eq("status","active").or(`current_period_end.is.null,current_period_end.gt.${nowIso}`);if(count.error)return{data:null,error:count.error};revenue+=(count.count??0)*Number(plan.monthly_price_usd)}
  return{data:revenue,error:null};
}

/**
 * Single-clinic variant of listOperatorClinics for the operator detail page —
 * same reviewed metadata column list, never clinical tables. Callers must have
 * passed requirePlatformAdmin() first.
 */
export async function getOperatorClinic(clinicId: string) {
  return createAdminClient()
    .from("clinics")
    .select("id, name, phone, country, locale, timezone, onboarding_completed_at, created_at")
    .eq("id", clinicId)
    .maybeSingle();
}

export const OPERATOR_CLINIC_USAGE_PAGE_SIZES = [25, 50, 100] as const;
export const OPERATOR_CLINIC_USAGE_METRICS = [
  "ai_messages",
  "wa_messages",
  "sms_messages",
  "emails",
] as const satisfies readonly Database["public"]["Enums"]["usage_metric"][];

export type OperatorClinicUsageParams = {
  metric: Database["public"]["Enums"]["usage_metric"] | "all";
  page: number;
  pageSize: (typeof OPERATOR_CLINIC_USAGE_PAGE_SIZES)[number];
};

export function parseOperatorClinicUsageParams(input: {
  usageMetric?: string;
  usagePage?: string;
  usagePageSize?: string;
}): OperatorClinicUsageParams {
  const metric = OPERATOR_CLINIC_USAGE_METRICS.includes(
    input.usageMetric as (typeof OPERATOR_CLINIC_USAGE_METRICS)[number],
  )
    ? (input.usageMetric as OperatorClinicUsageParams["metric"])
    : "all";
  const parsedPage = Number.parseInt(input.usagePage ?? "1", 10);
  const parsedPageSize = Number.parseInt(input.usagePageSize ?? "25", 10);
  const pageSize = OPERATOR_CLINIC_USAGE_PAGE_SIZES.includes(
    parsedPageSize as OperatorClinicUsageParams["pageSize"],
  )
    ? (parsedPageSize as OperatorClinicUsageParams["pageSize"])
    : 25;
  return {
    metric,
    page: Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1,
    pageSize,
  };
}

const SAFE_OPERATOR_CLINIC_AUDIT_ACTIONS = [
  "subscription.granted",
  "subscription.cancelled",
  "feature_override.upserted",
  "feature_override.removed",
  "invitation.issued",
  "invitation.revoked",
  "invitation.email_sent",
  "coupon.redeemed",
] as const;
const OPERATOR_CLINIC_AUDIT_SOURCE_LIMIT = 10_000;

function auditPayload(payload: Database["public"]["Tables"]["platform_audit_logs"]["Row"]["payload"]) {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

function safeAuditSummary(row: {
  id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  payload: Database["public"]["Tables"]["platform_audit_logs"]["Row"]["payload"];
  created_at: string;
}) {
  const payload = auditPayload(row.payload);
  switch (row.action) {
    case "subscription.granted": {
      const plan = typeof payload.planSlug === "string" ? payload.planSlug : null;
      const months = typeof payload.months === "number" ? `${payload.months} months` : "unbounded";
      return {
        id: row.id,
        title: "Manual subscription granted or extended",
        detail: [plan ? `Plan: ${plan}` : null, `Duration: ${months}`].filter(Boolean).join(" · "),
        createdAt: row.created_at,
      };
    }
    case "subscription.cancelled":
      return { id: row.id, title: "Manual subscription cancelled", detail: null, createdAt: row.created_at };
    case "feature_override.upserted":
      return {
        id: row.id,
        title: "Feature override changed",
        detail: `${row.target_id ?? "Feature"}: ${payload.enabled === true ? "enabled" : "disabled"}`,
        createdAt: row.created_at,
      };
    case "feature_override.removed":
      return {
        id: row.id,
        title: "Feature override removed",
        detail: row.target_id,
        createdAt: row.created_at,
      };
    case "invitation.issued":
      return {
        id: row.id,
        title: payload.force === true ? "Invitation reissued" : "Invitation issued",
        detail: typeof payload.expiresAt === "string" ? `Expires ${payload.expiresAt}` : null,
        createdAt: row.created_at,
      };
    case "invitation.revoked":
      return { id: row.id, title: "Invitation revoked", detail: null, createdAt: row.created_at };
    case "invitation.email_sent":
      return { id: row.id, title: "Invitation email sent", detail: null, createdAt: row.created_at };
    case "coupon.redeemed":
      return {
        id: row.id,
        title: "Coupon redeemed",
        detail: typeof payload.kind === "string" ? `Kind: ${payload.kind.replaceAll("_", " ")}` : null,
        createdAt: row.created_at,
      };
    default:
      return null;
  }
}

/**
 * Read-only WS8 clinic-history boundary. Every field is clinic metadata,
 * platform commercial data, or a count/limit. Patient and clinical tables are
 * deliberately unreachable from this query path. Audit payloads are converted
 * to an allowlisted summary before leaving this server-only module.
 */
export async function getOperatorClinicHistory(
  clinicId: string,
  usage: OperatorClinicUsageParams,
) {
  await requirePlatformAdmin();
  const db = createAdminClient();

  async function loadUsagePage() {
    let countQuery = db
      .from("usage_counters")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", clinicId);
    if (usage.metric !== "all") countQuery = countQuery.eq("metric", usage.metric);
    const countResult = await countQuery;
    if (countResult.error) return { data: null, error: countResult.error };

    const total = countResult.count ?? 0;
    const pageCount = Math.max(1, Math.ceil(total / usage.pageSize));
    const page = Math.min(usage.page, pageCount);
    const from = (page - 1) * usage.pageSize;
    let rowsQuery = db
      .from("usage_counters")
      .select("id, period_start, metric, used, limit_snapshot, created_at, updated_at")
      .eq("clinic_id", clinicId);
    if (usage.metric !== "all") rowsQuery = rowsQuery.eq("metric", usage.metric);
    const rows = await rowsQuery
      .order("period_start", { ascending: false })
      .order("metric", { ascending: true })
      .range(from, from + usage.pageSize - 1);
    if (rows.error) return { data: null, error: rows.error };
    return {
      data: {
        rows: rows.data ?? [],
        total,
        page,
        pageSize: usage.pageSize,
        pageCount,
        metric: usage.metric,
      },
      error: null,
    };
  }

  const [clinic, subscription, workingHours, invitations, redemptions, overrides, usageRows, plans] =
    await Promise.all([
      db
        .from("clinics")
        .select(
          "id, name, country, timezone, locale, currency, created_at, onboarding_completed_at, working_hours_start, working_hours_end",
        )
        .eq("id", clinicId)
        .maybeSingle(),
      db
        .from("subscriptions")
        .select(
          "id, status, trial_ends_at, current_period_start, current_period_end, provider, provider_subscription_id, created_at, updated_at, plans(slug, name_en)",
        )
        .eq("clinic_id", clinicId)
        .maybeSingle(),
      db
        .from("clinic_working_hours")
        .select("id, day_of_week, shift_start, shift_end")
        .eq("clinic_id", clinicId)
        .order("day_of_week")
        .order("shift_start"),
      db
        .from("clinic_invitations")
        .select("id, status, created_at, expires_at, email_sent_at, accepted_at, revoked_at, updated_at")
        .eq("accepted_clinic_id", clinicId)
        .order("created_at", { ascending: false }),
      db
        .from("coupon_redemptions")
        .select("id, redeemed_at, coupon_id, coupons(code, kind, months, percent, expires_at, is_active)")
        .eq("clinic_id", clinicId)
        .order("redeemed_at", { ascending: false }),
      db
        .from("clinic_feature_overrides")
        .select("id, feature_key, enabled, created_at, updated_at")
        .eq("clinic_id", clinicId)
        .order("feature_key"),
      loadUsagePage(),
      db.from("plans").select("slug, name_en").eq("is_active", true).order("slug"),
    ]);

  if (clinic.error) return { data: null, error: clinic.error };
  if (!clinic.data) return { data: null, error: null };
  const firstError = [subscription, workingHours, invitations, redemptions, overrides, usageRows, plans]
    .map((result) => result.error)
    .find(Boolean);
  if (firstError) return { data: null, error: firstError };

  const invitationIds = (invitations.data ?? []).map((invitation) => invitation.id);
  const clinicAudit = await collectOperatorRows(OPERATOR_CLINIC_AUDIT_SOURCE_LIMIT, (from, to) =>
    db
      .from("platform_audit_logs")
      .select("id, action, target_type, target_id, payload, created_at", { count: "exact" })
      .eq("clinic_id", clinicId)
      .in("action", [...SAFE_OPERATOR_CLINIC_AUDIT_ACTIONS])
      .order("created_at", { ascending: false })
      .range(from, to),
  );
  if (clinicAudit.error) return { data: null, error: clinicAudit.error };

  const invitationAudit = invitationIds.length > 0
    ? await collectOperatorRows(OPERATOR_CLINIC_AUDIT_SOURCE_LIMIT, (from, to) =>
        db
          .from("platform_audit_logs")
          .select("id, action, target_type, target_id, payload, created_at", { count: "exact" })
          .eq("target_type", "clinic_invitation")
          .in("target_id", invitationIds)
          .in("action", ["invitation.issued", "invitation.revoked", "invitation.email_sent"])
          .order("created_at", { ascending: false })
          .range(from, to),
      )
    : { data: [], count: 0, truncated: false, error: null };
  if (invitationAudit.error) return { data: null, error: invitationAudit.error };

  const safeAudit = new Map<string, NonNullable<ReturnType<typeof safeAuditSummary>>>();
  for (const row of [...clinicAudit.data, ...invitationAudit.data]) {
    const event = safeAuditSummary(row);
    if (event) safeAudit.set(event.id, event);
  }

  return {
    data: {
      clinic: clinic.data,
      subscription: subscription.data,
      workingHours: workingHours.data ?? [],
      invitations: invitations.data ?? [],
      redemptions: redemptions.data ?? [],
      overrides: overrides.data ?? [],
      usage: usageRows.data!,
      plans: plans.data ?? [],
      auditEvents: [...safeAudit.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      auditTruncated: clinicAudit.truncated || invitationAudit.truncated,
    },
    error: null,
  };
}

// Safety bound for the Auth-user scan below: 500 pages × 100 users. The scan
// walks every page until the API reports a short (final) page; the bound only
// exists to keep a pathological directory from hanging the panel, and hitting
// it is surfaced as `truncated: true`, which Mission Control renders as an
// explicit warning instead of silently narrowing the orphan list.
const ORPHAN_SCAN_PER_PAGE = 100;
const ORPHAN_SCAN_MAX_PAGES = 500;

/**
 * Operational backstop for the P1C signup compensation path: Auth users that
 * carry the clinic-owner signup marker but never received a profile.
 */
export async function listOrphanedSignupUsers(): Promise<
  | { data: { orphans: Array<{ id: string; email: string | null; created_at: string }>; truncated: boolean }; error: null }
  | { data: null; error: { message: string } }
> {
  const admin = createAdminClient();
  const orphans: Array<{ id: string; email: string | null; created_at: string }> = [];
  let truncated = true;
  for (let page = 1; page <= ORPHAN_SCAN_MAX_PAGES; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: ORPHAN_SCAN_PER_PAGE });
    if (error) return { data: null, error };
    const marked = data.users.filter(
      (user) => user.user_metadata?.signup_flow === "clinic_owner",
    );
    if (marked.length > 0) {
      const profiles = await admin
        .from("profiles")
        .select("id")
        .in("id", marked.map((user) => user.id));
      if (profiles.error) return { data: null, error: profiles.error };
      const withProfile = new Set((profiles.data ?? []).map((row) => row.id));
      for (const user of marked) {
        if (!withProfile.has(user.id)) {
          orphans.push({ id: user.id, email: user.email ?? null, created_at: user.created_at });
        }
      }
    }
    if (data.users.length < ORPHAN_SCAN_PER_PAGE) {
      truncated = false;
      break;
    }
  }
  return { data: { orphans, truncated }, error: null };
}

const CLINIC_SCOPED_TABLES = new Set([
  "appointment_services",
  "appointments",
  "audit_logs",
  "clinic_working_hours",
  "clinic_feature_overrides",
  "coupon_redemptions",
  "departments",
  "doctor_schedules",
  "follow_ups",
  "insurance_providers",
  "medical_note_attachments",
  "outstanding_settlements",
  "package_templates",
  "patient_deposits",
  "patient_documents",
  "patient_packages",
  "patients",
  "profiles",
  "services",
  "staff_invitations",
  "subscriptions",
  "usage_counters",
  "user_customizations",
  "user_page_permissions",
]);

const JOIN_SCOPED_TABLES = new Set([
  "feedback",
  "medical_notes",
]);

// These tables mix global and tenant-assigned rows. Callers must apply the
// reviewed assignment predicate explicitly; automatic clinic_id injection
// would make global and invitation-assigned rows unreachable.
const EXPLICIT_SCOPE_TABLES = new Set([
  "coupons",
]);

const INSERT_METHODS = new Set(["insert", "upsert"]);
const SCOPED_METHODS = new Set(["select", "update", "delete"]);
const BLOCKED_METHODS = new Set(["rpc", "schema"]);

type AdminClient = ReturnType<typeof createAdminClient>;

function assertKnownTable(table: string) {
  if (
    CLINIC_SCOPED_TABLES.has(table)
    || JOIN_SCOPED_TABLES.has(table)
    || EXPLICIT_SCOPE_TABLES.has(table)
  ) {
    return;
  }

  throw new Error(
    `createClinicScopedAdminClient cannot access unclassified table "${table}". Add it to a reviewed scope allow-list first.`,
  );
}

function assertNoMismatchedClinicId(payload: unknown, clinicId: string): void {
  if (Array.isArray(payload)) {
    payload.forEach((row) => assertNoMismatchedClinicId(row, clinicId));
    return;
  }

  if (payload && typeof payload === "object") {
    const row = payload as Record<string, unknown>;
    if (
      row.clinic_id !== undefined &&
      row.clinic_id !== null &&
      row.clinic_id !== clinicId
    ) {
      throw new Error("Clinic-scoped admin write attempted with a different clinic_id.");
    }
  }
}

function withClinicId(payload: unknown, clinicId: string): unknown {
  assertNoMismatchedClinicId(payload, clinicId);

  if (Array.isArray(payload)) {
    return payload.map((row) => withClinicId(row, clinicId));
  }

  if (payload && typeof payload === "object") {
    return { ...(payload as Record<string, unknown>), clinic_id: clinicId };
  }

  return payload;
}

function scopeQueryResult(result: unknown, table: string, clinicId: string) {
  if (!CLINIC_SCOPED_TABLES.has(table)) return result;

  if (result && typeof result === "object" && "eq" in result) {
    return (result as { eq: (column: string, value: string) => unknown }).eq(
      "clinic_id",
      clinicId,
    );
  }

  return result;
}

/**
 * Service-role client with tenant scoping guardrails for data-table access.
 * Auth admin APIs remain available, but table reads/writes for tenant tables are
 * automatically constrained to the provided clinic id. Tables without their own
 * clinic_id must be explicitly allow-listed as join-scoped and verified by the
 * caller before mutation. Tables with global-or-assigned rows are explicitly
 * scoped by each caller. RPC, schema, and storage access are intentionally not
 * exposed through this wrapper.
 */
export function createClinicScopedAdminClient(clinicId: string): AdminClient {
  const adminClient = createAdminClient();

  return new Proxy(adminClient, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && BLOCKED_METHODS.has(prop)) {
        throw new Error(
          `${prop}() is not available on createClinicScopedAdminClient; use an RLS client or an explicitly reviewed admin path.`,
        );
      }
      if (prop === "storage") {
        throw new Error(
          "storage is not available on createClinicScopedAdminClient; use an RLS client or an explicitly reviewed admin path.",
        );
      }
      if (prop !== "from") {
        return Reflect.get(target, prop, receiver);
      }

      return (table: string) => {
        assertKnownTable(table);
        const builder = target.from(
          table as Parameters<AdminClient["from"]>[0],
        );

        return new Proxy(builder, {
          get(builderTarget, builderProp, builderReceiver) {
            const value = Reflect.get(
              builderTarget,
              builderProp,
              builderReceiver,
            );

            if (typeof builderProp !== "string" || typeof value !== "function") {
              return value;
            }

            if (INSERT_METHODS.has(builderProp)) {
              return (payload: unknown, ...args: unknown[]) =>
                value.apply(builderTarget, [
                  CLINIC_SCOPED_TABLES.has(table)
                    ? withClinicId(payload, clinicId)
                    : payload,
                  ...args,
                ]);
            }

            if (builderProp === "update") {
              return (payload: unknown, ...args: unknown[]) => {
                if (CLINIC_SCOPED_TABLES.has(table)) {
                  assertNoMismatchedClinicId(payload, clinicId);
                }
                return scopeQueryResult(
                  value.apply(builderTarget, args.length ? [payload, ...args] : [payload]),
                  table,
                  clinicId,
                );
              };
            }

            if (SCOPED_METHODS.has(builderProp)) {
              return (...args: unknown[]) => {
                return scopeQueryResult(
                  value.apply(builderTarget, args),
                  table,
                  clinicId,
                );
              };
            }

            return value.bind(builderTarget);
          },
        });
      };
    },
  });
}
