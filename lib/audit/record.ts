import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database";
import type { AuditModule } from "@/lib/audit/events";

/**
 * P18 — the single application-side writer for the administrative trail.
 *
 * Almost nothing needs this. The high-value administrative mutations are
 * audited by database triggers precisely so that no server action has to
 * remember to call anything, and so an audit failure aborts the change instead
 * of leaving a silent hole. This helper exists for the one family the triggers
 * deliberately do not cover — scheduling configuration, which the application
 * saves as a multi-statement delete-then-insert replace and which would
 * otherwise produce one event per shift row.
 *
 * The RPC derives clinic, actor, role and display name from the session. This
 * helper cannot supply any of them, which is the point: there is no argument
 * here that a caller could get wrong or a compromised action could forge.
 */
export type AdminAuditEventInput = {
  module: AuditModule;
  action: string;
  entityType: string;
  entityId?: string | null;
  entityRef?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  changedFields?: readonly string[];
  metadata?: Record<string, unknown>;
};

export async function recordAdminAuditEvent(
  input: AdminAuditEventInput,
): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("record_admin_audit_event", {
    p_module: input.module,
    p_action: input.action,
    p_entity_type: input.entityType,
    p_entity_id: input.entityId ?? undefined,
    p_entity_ref: input.entityRef ?? undefined,
    p_before: (input.before ?? undefined) as Json | undefined,
    p_after: (input.after ?? undefined) as Json | undefined,
    p_changed_fields: [...(input.changedFields ?? [])],
    p_metadata: (input.metadata ?? {}) as Json,
  });
  return !error;
}

/**
 * Renders a set of shifts as short, sortable strings.
 *
 * Schedules are saved as a whole, so the honest diff is "these intervals became
 * those intervals". Storing the raw rows would carry surrogate ids and
 * timestamps that mean nothing to a reader a year later; storing counts alone
 * would not answer "what did Tuesday used to be".
 */
export function auditShiftSummary(
  shifts: readonly { day: number; start: string; end: string }[],
): Record<string, unknown> {
  const rendered = shifts
    .map((shift) => `${shift.day}:${clock(shift.start)}-${clock(shift.end)}`)
    .sort();
  return { shift_count: rendered.length, shifts: rendered };
}

function clock(value: string): string {
  return value.slice(0, 5);
}

/** Same idea for named shift templates, which carry a label and a toggle. */
export function auditTemplateSummary(
  templates: readonly {
    name: string;
    start_time: string;
    end_time: string;
    is_enabled: boolean;
  }[],
): Record<string, unknown> {
  const rendered = templates
    .map(
      (template) =>
        `${template.name} ${clock(template.start_time)}-${clock(template.end_time)}${
          template.is_enabled ? "" : " (disabled)"
        }`,
    )
    .sort();
  return { template_count: rendered.length, templates: rendered };
}
