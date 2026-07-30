"use server";

import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/rbac";
import type { ActivityEntityType } from "@/lib/activity/events";
import type { Json } from "@/types/database";

/**
 * Phase 8D — scoped, read-only access to the unified activity trail.
 *
 * The read is performed through the caller's RLS-scoped client, so the database
 * `activity_events_select_scoped` policy is the authoritative boundary: admins,
 * managers and receptionists see clinic-wide activity; doctors and assistants see
 * only events for entities in their authorized scope. This action never widens
 * that; it only shapes, paginates and enriches (actor name) the rows a caller is
 * already allowed to read.
 */

export type ActivityEventView = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  isSystem: boolean;
  occurredAt: string;
  previousState: Json | null;
  newState: Json | null;
  metadata: Json;
};

export type ActivityTimelineParams = {
  entityType?: ActivityEntityType;
  entityId?: string;
  patientId?: string;
  actorId?: string;
  action?: string;
  /** Keyset cursor: return only events strictly older than this ISO timestamp. */
  before?: string;
  limit?: number;
};

export type ActivityTimelineResult = {
  events: ActivityEventView[];
  nextCursor: string | null;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

type ActorEmbed = { full_name: string | null; role: string | null } | null;

export async function getActivityTimeline(
  params: ActivityTimelineParams = {},
): Promise<ActivityTimelineResult> {
  // Any authenticated clinic member may query; RLS decides what comes back.
  await requireUser();
  const supabase = await createClient();

  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  let query = supabase
    .from("activity_events")
    .select(
      "id, action, entity_type, entity_id, actor_id, actor_role, is_system, occurred_at, previous_state, new_state, metadata, actor:profiles!activity_events_actor_id_fkey(full_name, role)",
    )
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (params.entityType) query = query.eq("entity_type", params.entityType);
  if (params.entityId) query = query.eq("entity_id", params.entityId);
  if (params.patientId) query = query.eq("patient_id", params.patientId);
  if (params.actorId) query = query.eq("actor_id", params.actorId);
  if (params.action) query = query.eq("action", params.action);
  if (params.before) query = query.lt("occurred_at", params.before);

  const { data, error } = await query;
  if (error || !data) {
    // Fail closed: an unreadable trail yields an empty timeline, never a throw
    // that would break the host page.
    return { events: [], nextCursor: null };
  }

  const hasMore = data.length > limit;
  const page = hasMore ? data.slice(0, limit) : data;

  const events: ActivityEventView[] = page.map((row) => {
    const actor = (row.actor as ActorEmbed) ?? null;
    return {
      id: row.id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      actorId: row.actor_id,
      actorName: actor?.full_name ?? null,
      actorRole: row.actor_role ?? actor?.role ?? null,
      isSystem: row.is_system,
      occurredAt: row.occurred_at,
      previousState: row.previous_state,
      newState: row.new_state,
      metadata: row.metadata,
    };
  });

  const nextCursor = hasMore ? events[events.length - 1].occurredAt : null;
  return { events, nextCursor };
}
