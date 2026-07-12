import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { FxSnapshot } from "@/lib/currency/provider";

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
export async function listOperatorClinics() {
  return createAdminClient()
    .from("clinics")
    .select("id, name, phone, country, locale, timezone, onboarding_completed_at, created_at", {
      count: "exact",
    })
    .order("created_at", { ascending: false })
    .limit(OPERATOR_CLINIC_LIST_LIMIT);
}

/** Reviewed metadata-only read for executive growth and registry reports. */
export async function listOperatorClinicMetadata() {
  return createAdminClient().from("clinics").select("id, name, country, created_at").order("created_at", { ascending: false }).limit(1000);
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
