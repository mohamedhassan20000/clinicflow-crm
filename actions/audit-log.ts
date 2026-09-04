"use server";

import "server-only";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import {
  AUDIT_MODULES,
  type AuditModule,
} from "@/lib/audit/events";
import {
  decodeAuditCursor,
  mergeAuditPages,
  normalizeActivityRow,
  normalizeAdminAuditRow,
  normalizeLegacyRow,
  type ActivityAuditRow,
  type AdminAuditRow,
  type AuditCursor,
  type AuditFeedEvent,
  type LegacyAuditRow,
} from "@/lib/audit/feed";

/**
 * P18 — the read side of the administrative audit trail.
 *
 * Every query below runs through the caller's own RLS-scoped client, so the
 * database policies are the authoritative boundary and this action can only
 * ever narrow what a caller may already read: `admin_audit_events` is
 * admin-and-manager, with AI configuration admin-only; `audit_logs` and
 * `activity_events` carry their own long-standing policies. Clinic isolation is
 * never expressed here — it is not this layer's to enforce.
 *
 * The three trails are read as three bounded, index-backed keyset pages and
 * merged in memory. A database view unioning them would have been tidier to
 * write and much harder to keep fast: each branch would have had to be planned
 * under RLS predicates, and one unindexed branch would have silently made the
 * whole feed a sequential scan.
 */

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
/** Receipts are written within the same request as the mutation they describe. */
const AI_CORRELATION_WINDOW_MS = 15_000;

export type AuditLogFilters = {
  module?: AuditModule;
  action?: string;
  actorId?: string;
  entityType?: string;
  entityId?: string;
  /** Matches the event's human reference (a service, department or staff name). */
  search?: string;
  /** Inclusive ISO bounds. */
  from?: string;
  to?: string;
  outcome?: "success" | "failure";
  cursor?: string;
  limit?: number;
};

export type AuditLogPage = {
  events: AuditFeedEvent[];
  nextCursor: string | null;
};

export type AuditLogActor = {
  id: string;
  name: string;
  role: string;
};

function isModule(value: string | undefined): value is AuditModule {
  return !!value && (AUDIT_MODULES as readonly string[]).includes(value);
}

const ADMIN_COLUMNS =
  "id, occurred_at, actor_type, actor_user_id, actor_role, actor_display, module, action, entity_type, entity_id, entity_ref, before, after, changed_fields, source, outcome, correlation_id, metadata";

export async function getAuditLog(
  filters: AuditLogFilters = {},
): Promise<AuditLogPage> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();

  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cursor = decodeAuditCursor(filters.cursor);
  const moduleFilter = isModule(filters.module) ? filters.module : undefined;
  // Managers cannot open the AI provider screen, so they do not read its
  // history either. The `admin_audit_events` policy already enforces this; the
  // curated `AI_PROVIDER_*` rows live in `audit_logs`, whose policy predates
  // this split, so the same rule is applied to that branch here.
  const canReadAi = user.role === "admin";

  const wantsAdmin = moduleFilter !== "appointments";
  const wantsActivity = !moduleFilter || moduleFilter === "appointments";
  const wantsMessaging = !moduleFilter || moduleFilter === "messaging";
  const wantsAiLegacy = canReadAi && (!moduleFilter || moduleFilter === "ai");

  const [adminRows, activityRows, legacyRows] = await Promise.all([
    wantsAdmin ? readAdminTrail(supabase, filters, moduleFilter, cursor, limit) : [],
    wantsActivity ? readActivityTrail(supabase, filters, cursor, limit) : [],
    wantsMessaging || wantsAiLegacy
      ? readLegacyTrail(supabase, filters, cursor, limit, {
          messaging: wantsMessaging,
          aiProvider: wantsAiLegacy,
        })
      : [],
  ]);

  const actorIds = new Set<string>();
  for (const row of activityRows) if (row.actor_id) actorIds.add(row.actor_id);
  for (const row of legacyRows) if (row.actor_id) actorIds.add(row.actor_id);
  const actors = await loadActorNames(supabase, [...actorIds]);

  const pages = [
    adminRows.map(normalizeAdminAuditRow),
    activityRows.map((row) =>
      normalizeActivityRow(row, actors.get(row.actor_id ?? "")?.name ?? null),
    ),
    legacyRows
      .map((row) =>
        normalizeLegacyRow(
          row,
          actors.get(row.actor_id ?? "")?.name ?? null,
          actors.get(row.actor_id ?? "")?.role ?? null,
        ),
      )
      .filter((event): event is AuditFeedEvent => event !== null),
  ];

  const merged = mergeAuditPages(pages, limit, cursor);
  return {
    events: await annotateAiOrigin(supabase, merged.events),
    nextCursor: merged.nextCursor,
  };
}

type Db = Awaited<ReturnType<typeof createClient>>;

async function readAdminTrail(
  supabase: Db,
  filters: AuditLogFilters,
  moduleFilter: AuditModule | undefined,
  cursor: AuditCursor | null,
  limit: number,
): Promise<AdminAuditRow[]> {
  let query = supabase
    .from("admin_audit_events")
    .select(ADMIN_COLUMNS)
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (moduleFilter) query = query.eq("module", moduleFilter);
  if (filters.action) query = query.eq("action", filters.action);
  if (filters.actorId) query = query.eq("actor_user_id", filters.actorId);
  if (filters.entityType) query = query.eq("entity_type", filters.entityType);
  if (filters.entityId) query = query.eq("entity_id", filters.entityId);
  if (filters.outcome) query = query.eq("outcome", filters.outcome);
  if (filters.from) query = query.gte("occurred_at", filters.from);
  if (filters.to) query = query.lte("occurred_at", filters.to);
  if (cursor) query = query.lte("occurred_at", cursor.occurredAt);
  if (filters.search) {
    query = query.ilike("entity_ref", `%${escapeLike(filters.search)}%`);
  }

  const { data, error } = await query;
  if (error || !data) return [];
  return data as unknown as AdminAuditRow[];
}

async function readActivityTrail(
  supabase: Db,
  filters: AuditLogFilters,
  cursor: AuditCursor | null,
  limit: number,
): Promise<ActivityAuditRow[]> {
  // The operational trail has no `entity_ref`, so a name search has nothing to
  // match there; returning nothing is honest, and pretending otherwise would
  // mean scanning appointment rows from an audit screen.
  if (filters.search || filters.outcome === "failure") return [];

  let query = supabase
    .from("activity_events")
    .select(
      "id, occurred_at, action, entity_type, entity_id, actor_id, actor_role, is_system, previous_state, new_state, metadata",
    )
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (filters.action) query = query.eq("action", filters.action);
  if (filters.actorId) query = query.eq("actor_id", filters.actorId);
  if (filters.entityType) query = query.eq("entity_type", filters.entityType);
  if (filters.entityId) query = query.eq("entity_id", filters.entityId);
  if (filters.from) query = query.gte("occurred_at", filters.from);
  if (filters.to) query = query.lte("occurred_at", filters.to);
  if (cursor) query = query.lte("occurred_at", cursor.occurredAt);

  const { data, error } = await query;
  if (error || !data) return [];
  return data as unknown as ActivityAuditRow[];
}

async function readLegacyTrail(
  supabase: Db,
  filters: AuditLogFilters,
  cursor: AuditCursor | null,
  limit: number,
  want: { messaging: boolean; aiProvider: boolean },
): Promise<LegacyAuditRow[]> {
  if (filters.search || filters.outcome === "failure") return [];
  if (filters.entityType && !["channel", "ai_provider"].includes(filters.entityType)) {
    return [];
  }

  let query = supabase
    .from("audit_logs")
    .select("id, created_at, action, actor_id, record_id, new_data, old_data")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  // The raw `INSERT`/`UPDATE`/`DELETE` half of this table is a full row dump of
  // patients and medical notes. It is excluded by construction: only these two
  // curated namespaces are ever selected.
  const namespaces: string[] = [];
  if (want.messaging) namespaces.push("action.like.messaging:*");
  if (want.aiProvider) namespaces.push("action.like.AI_PROVIDER_*");
  if (namespaces.length === 0) return [];
  query = query.or(namespaces.join(","));

  if (filters.actorId) query = query.eq("actor_id", filters.actorId);
  if (filters.entityId) query = query.eq("record_id", filters.entityId);
  if (filters.from) query = query.gte("created_at", filters.from);
  if (filters.to) query = query.lte("created_at", filters.to);
  if (cursor) query = query.lte("created_at", cursor.occurredAt);

  const { data, error } = await query;
  if (error || !data) return [];
  return data as unknown as LegacyAuditRow[];
}

function escapeLike(input: string): string {
  return input.replace(/[%_\\,]/g, "").slice(0, 80);
}

async function loadActorNames(
  supabase: Db,
  ids: readonly string[],
): Promise<Map<string, { name: string; role: string }>> {
  const map = new Map<string, { name: string; role: string }>();
  if (ids.length === 0) return map;
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .in("id", [...ids]);
  for (const row of data ?? []) {
    map.set(row.id, { name: row.full_name, role: row.role });
  }
  return map;
}

/**
 * Marks the events an AI action actually performed.
 *
 * The assistant executes privileged actions inside the requesting staff
 * member's session, so a trigger cannot tell the two apart — and inventing a
 * client-settable "this was the AI" flag would have made the actor forgeable,
 * which is the one property this trail exists to keep. `ai_action_receipts` is
 * already the authoritative record of what the assistant executed, including
 * the table and record ids it touched, so the correspondence is established by
 * reading it rather than by writing a second claim.
 */
async function annotateAiOrigin(
  supabase: Db,
  events: AuditFeedEvent[],
): Promise<AuditFeedEvent[]> {
  const candidates = events.filter((event) => event.entityId && event.actorType === "staff");
  if (candidates.length === 0) return events;

  const times = candidates.map((event) => Date.parse(event.occurredAt));
  const from = new Date(Math.min(...times) - AI_CORRELATION_WINDOW_MS).toISOString();
  const to = new Date(Math.max(...times) + AI_CORRELATION_WINDOW_MS).toISOString();

  const { data } = await supabase
    .from("ai_action_receipts")
    .select("actor_id, ai_request_id, target_record_ids, created_at")
    .eq("phase", "execute")
    .eq("outcome", "success")
    .gte("created_at", from)
    .lte("created_at", to)
    .limit(500);
  if (!data || data.length === 0) return events;

  return events.map((event) => {
    if (!event.entityId || event.actorType !== "staff") return event;
    const at = Date.parse(event.occurredAt);
    const receipt = data.find(
      (row) =>
        row.actor_id === event.actorId &&
        (row.target_record_ids ?? []).includes(event.entityId!) &&
        Math.abs(Date.parse(row.created_at) - at) <= AI_CORRELATION_WINDOW_MS,
    );
    return receipt
      ? { ...event, viaAi: true, correlationId: receipt.ai_request_id ?? event.correlationId }
      : event;
  });
}

/** Staff who could appear as an actor, for the Actor filter. */
export async function getAuditLogActors(): Promise<AuditLogActor[]> {
  await requireRole(["admin", "manager"]);
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .order("full_name");
  return (data ?? []).map((row) => ({
    id: row.id,
    name: row.full_name,
    role: row.role as string,
  }));
}
