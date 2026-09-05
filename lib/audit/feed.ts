/**
 * P18 — one shape for three trails.
 *
 * The Audit Log page answers "who changed what, when" across the clinic, and
 * ClinicFlow already answers part of that question in two places that work and
 * are not being replaced:
 *
 *   * `admin_audit_events` — the new administrative trail (this pass).
 *   * `activity_events` — the P8D operational trail (appointments, follow-ups).
 *   * `audit_logs` — but *only* its curated, namespaced half: the `messaging:*`
 *     events written by `log_messaging_event`, and the `AI_PROVIDER_*` events
 *     written by the provider-connection RPCs. The other half of that table is a
 *     raw `to_jsonb(row)` dump of `patients` and `medical_notes` and is
 *     deliberately never read here — surfacing it would turn an audit screen
 *     into a PHI browser.
 *
 * Copying those two trails into the new table would have created a second
 * source of truth for facts that already have one, so they are normalized at
 * read time instead. Nothing in this module writes.
 */

import { redactText } from "@/lib/ai/redact";
import {
  auditActionTone,
  auditModuleForAction,
  type AuditActorType,
  type AuditModule,
  type AuditOutcome,
  type AuditSurface,
  type AuditTone,
  type AuditTrail,
} from "@/lib/audit/events";

export type AuditFeedEvent = {
  id: string;
  trail: AuditTrail;
  occurredAt: string;
  module: AuditModule;
  action: string;
  tone: AuditTone;
  actorType: AuditActorType;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  /**
   * True when an AI action receipt proves this mutation was executed by the
   * assistant on the actor's behalf. The accountable human stays the actor —
   * the assistant runs inside their session and under their authorization — so
   * this annotates the actor rather than replacing them.
   */
  viaAi: boolean;
  entityType: string;
  entityId: string | null;
  entityRef: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changedFields: string[];
  surface: AuditSurface;
  outcome: AuditOutcome;
  correlationId: string | null;
  metadata: Record<string, unknown>;
};

/**
 * Second line of defence for the two trails this module does not control.
 *
 * `admin_audit_events` is allowlisted at the point of writing, so nothing
 * sensitive can be in it. The legacy and operational payloads were shaped by
 * other passes for other readers, so anything whose key looks like a secret, a
 * credential, a raw identifier or free clinical text is dropped before it can
 * reach a browser, and surviving strings are run through the existing audit
 * redactor that strips e-mails and long digit runs.
 */
const FORBIDDEN_KEY = new RegExp(
  [
    "secret", "token", "password", "api_?key", "credential", "authorization",
    "auth_?state", "session", "qr", "signature", "national_?id", "civil_?id",
    "note", "diagnos", "prescription", "attachment", "body", "content",
    "message_?text", "transcript", "email", "phone",
  ].join("|"),
  "i",
);

const MAX_PAYLOAD_KEYS = 40;

export function sanitizeAuditPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key)) continue;
    if (kept >= MAX_PAYLOAD_KEYS) break;
    kept += 1;
    if (typeof raw === "string") {
      out[key] = redactText(raw).slice(0, 300);
    } else if (
      typeof raw === "number" ||
      typeof raw === "boolean" ||
      raw === null
    ) {
      out[key] = raw;
    } else if (Array.isArray(raw)) {
      // Lists are summarized, never inlined: a schedule replace or a bulk
      // permission save would otherwise carry dozens of rows per event.
      out[key] = { count: raw.length };
    } else {
      const nested = sanitizeAuditPayload(raw);
      if (nested) out[key] = nested;
    }
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// ── admin_audit_events ───────────────────────────────────────────────────────

export type AdminAuditRow = {
  id: string;
  occurred_at: string;
  actor_type: string;
  actor_user_id: string | null;
  actor_role: string | null;
  actor_display: string | null;
  module: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  entity_ref: string | null;
  before: unknown;
  after: unknown;
  changed_fields: string[] | null;
  source: string;
  outcome: string;
  correlation_id: string | null;
  metadata: unknown;
};

export function normalizeAdminAuditRow(row: AdminAuditRow): AuditFeedEvent {
  return {
    id: row.id,
    trail: "admin",
    occurredAt: row.occurred_at,
    module: row.module as AuditModule,
    action: row.action,
    tone: auditActionTone(row.action),
    actorType: row.actor_type as AuditActorType,
    actorId: row.actor_user_id,
    actorName: row.actor_display,
    actorRole: row.actor_role,
    viaAi: false,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityRef: row.entity_ref,
    before: asRecord(row.before),
    after: asRecord(row.after),
    changedFields: row.changed_fields ?? [],
    surface: row.source as AuditSurface,
    outcome: row.outcome as AuditOutcome,
    correlationId: row.correlation_id,
    metadata: asRecord(row.metadata) ?? {},
  };
}

// ── activity_events (P8D operational trail) ──────────────────────────────────

export type ActivityAuditRow = {
  id: string;
  occurred_at: string;
  action: string;
  entity_type: string;
  entity_id: string;
  actor_id: string | null;
  actor_role: string | null;
  is_system: boolean;
  previous_state: unknown;
  new_state: unknown;
  metadata: unknown;
};

export function normalizeActivityRow(
  row: ActivityAuditRow,
  actorName: string | null,
): AuditFeedEvent {
  const before = sanitizeAuditPayload(row.previous_state);
  const after = sanitizeAuditPayload(row.new_state);
  return {
    id: row.id,
    trail: "activity",
    occurredAt: row.occurred_at,
    module: auditModuleForAction(row.action),
    action: row.action,
    tone: auditActionTone(row.action),
    actorType: row.is_system ? "system" : "staff",
    actorId: row.actor_id,
    actorName,
    actorRole: row.actor_role,
    viaAi: false,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityRef: null,
    before,
    after,
    changedFields: diffKeys(before, after),
    surface: row.is_system ? "system" : "staff_web",
    outcome: "success",
    correlationId: null,
    metadata: sanitizeAuditPayload(row.metadata) ?? {},
  };
}

/** Keys whose value differs between two sanitized snapshots. */
export function diffKeys(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string[] {
  if (!before || !after) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(
    (key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null),
  );
}

// ── audit_logs (curated namespaced half only) ────────────────────────────────

export type LegacyAuditRow = {
  id: string;
  created_at: string;
  action: string;
  actor_id: string | null;
  record_id: string | null;
  new_data: unknown;
  old_data: unknown;
};

const LEGACY_ACTION_MAP: Record<string, string> = {
  AI_PROVIDER_CONNECTION_CREATED: "ai.provider_credential_created",
  AI_PROVIDER_CONNECTION_ROTATED: "ai.provider_credential_rotated",
  AI_PROVIDER_CONNECTION_REVOKED: "ai.provider_credential_revoked",
  AI_PROVIDER_CONNECTION_TESTED: "ai.provider_credential_tested",
  AI_PROVIDER_MODE_CHANGED: "ai.provider_mode_changed",
  AI_PROVIDER_AUTO_FALLBACK_CHANGED: "ai.provider_auto_fallback_changed",
  AI_PROVIDER_HYBRID_FALLBACK: "ai.provider_hybrid_fallback",
};

/** The two namespaces the feed reads out of `audit_logs`, and nothing else. */
export const LEGACY_MESSAGING_PREFIX = "messaging:";
export const LEGACY_AI_PROVIDER_PREFIX = "AI_PROVIDER_";

export function normalizeLegacyRow(
  row: LegacyAuditRow,
  actorName: string | null,
  actorRole: string | null,
): AuditFeedEvent | null {
  const isMessaging = row.action.startsWith(LEGACY_MESSAGING_PREFIX);
  const mapped = isMessaging
    ? "messaging.channel_event"
    : LEGACY_ACTION_MAP[row.action];
  if (!mapped) return null;

  const before = sanitizeAuditPayload(row.old_data);
  const after = sanitizeAuditPayload(row.new_data);
  const channelEvent = isMessaging
    ? row.action.slice(LEGACY_MESSAGING_PREFIX.length)
    : null;

  return {
    id: row.id,
    trail: "legacy",
    occurredAt: row.created_at,
    module: isMessaging ? "messaging" : "ai",
    action: mapped,
    tone: auditActionTone(mapped),
    // `log_messaging_event` is service-role only and stores no actor: these are
    // provider- and worker-driven signals, and claiming a human for them would
    // be a fabrication.
    actorType: row.actor_id ? "staff" : isMessaging ? "integration" : "system",
    actorId: row.actor_id,
    actorName,
    actorRole,
    viaAi: false,
    entityType: isMessaging ? "channel" : "ai_provider",
    entityId: row.record_id,
    entityRef: channelEvent,
    before,
    after,
    changedFields: diffKeys(before, after),
    surface: isMessaging ? "whatsapp" : row.actor_id ? "staff_web" : "system",
    outcome: "success",
    correlationId: null,
    metadata: channelEvent ? { event: channelEvent } : {},
  };
}

// ── merge ────────────────────────────────────────────────────────────────────

export type AuditCursor = { occurredAt: string; id: string };

export function encodeAuditCursor(cursor: AuditCursor): string {
  return `${cursor.occurredAt}|${cursor.id}`;
}

export function decodeAuditCursor(raw: string | null | undefined): AuditCursor | null {
  if (!raw) return null;
  const separator = raw.lastIndexOf("|");
  if (separator <= 0) return null;
  const occurredAt = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  if (!occurredAt || !id || Number.isNaN(Date.parse(occurredAt))) return null;
  return { occurredAt, id };
}

/** Newest first, with `id` breaking ties so the keyset cursor is total. */
export function compareAuditEvents(a: AuditFeedEvent, b: AuditFeedEvent): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/**
 * Merges the per-trail pages into one page.
 *
 * Each trail is queried with `occurred_at <= cursor.occurredAt` rather than
 * `<`, because two trails can hold events with the same timestamp and a strict
 * bound would silently drop whichever one lost the tie. The over-fetched rows
 * are removed here against the full `(occurredAt, id)` cursor, which is total.
 */
export function mergeAuditPages(
  pages: readonly (readonly AuditFeedEvent[])[],
  limit: number,
  cursor: AuditCursor | null,
): { events: AuditFeedEvent[]; nextCursor: string | null } {
  const merged = pages
    .flat()
    .filter((event) => {
      if (!cursor) return true;
      if (event.occurredAt !== cursor.occurredAt) return event.occurredAt < cursor.occurredAt;
      return event.id < cursor.id;
    })
    .sort(compareAuditEvents);

  const page = merged.slice(0, limit);
  const hasMore = merged.length > limit;
  const last = page[page.length - 1];
  return {
    events: page,
    nextCursor:
      hasMore && last ? encodeAuditCursor({ occurredAt: last.occurredAt, id: last.id }) : null,
  };
}
