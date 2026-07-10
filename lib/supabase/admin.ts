import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

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
