import "server-only";

import type { Json } from "@/types/database";
import type { ActiveContextEntityType } from "@/lib/ai/conversation-context";
import type {
  ResourceId,
  ResourceQueryInput,
  ResourceQueryResult,
} from "@/lib/ai/resources/types";
import type { DoctorToolContext } from "@/lib/ai/tools/context";

/**
 * Phase 7 — active-context proposals from the generic read path.
 *
 * The narrow tools this phase unmounts (`list_appointments`,
 * `list_doctor_appointments`, `get_patient_summary`, `search_patient_visits`)
 * each proposed an active-context slot when their result resolved to exactly one
 * record. Superset coverage is a claim about the *whole* capability, not only
 * about fields, so that behaviour has to survive the unmount — otherwise
 * "show me tomorrow's appointment for Sara" would stop leaving an appointment in
 * context and the next turn's "reschedule it" would lose its referent.
 *
 * The P4.10A discipline is preserved exactly, and it is the reason this is not
 * simply "propose whatever came back":
 *
 *   - **Server-derived only.** A single row that fell out of RLS-authorized
 *     filters is a deterministic resolution the server computed. A row the model
 *     addressed by id is not: that id may authorize the one call it was checked
 *     for, but it must never become trusted stored context. So an `id` filter
 *     (and therefore every `get_record` call) proposes nothing.
 *   - **Unambiguous only.** More than one row, or a truncated page, is a
 *     candidate list, not a resolution.
 *   - **Ids the server read back**, never ids the model asserted.
 *
 * `display_label` is UI-only state (see `conversation-context.ts`): prompt
 * construction reads entity type and id, never the label, so a hostile stored
 * name cannot reach the model through this path.
 */
const CONTEXT_ENTITY_BY_RESOURCE: Partial<
  Record<ResourceId, ActiveContextEntityType>
> = {
  patients: "patient",
  appointments: "appointment",
  profiles: "staff",
  departments: "department",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function relationText(
  row: Record<string, Json | undefined>,
  alias: string,
  field: string,
): string | null {
  const relation = row[alias];
  if (!relation || typeof relation !== "object" || Array.isArray(relation)) {
    return null;
  }
  return text((relation as Record<string, Json | undefined>)[field]);
}

function labelFor(
  resource: ResourceId,
  row: Record<string, Json | undefined>,
): string | null {
  switch (resource) {
    case "patients":
      return text(row.full_name) ?? text(row.file_number);
    case "appointments":
      return (
        [
          relationText(row, "patient", "full_name"),
          text(row.scheduled_at),
        ]
          .filter(Boolean)
          .join(" · ") || null
      );
    case "profiles":
      return text(row.full_name);
    case "departments":
      return text(row.name);
    default:
      return null;
  }
}

/**
 * Records at most one active-context proposal for a `query_resource` result.
 * Silent no-op whenever any of the conditions above fails — a missed proposal
 * costs a pronoun, a wrong one costs correctness.
 */
export function proposeResourceContext(
  ctx: DoctorToolContext,
  resource: ResourceId,
  input: Pick<ResourceQueryInput, "filters">,
  result: ResourceQueryResult,
): void {
  if (!ctx.conversationId || !ctx.contextRecorder) return;

  const entityType = CONTEXT_ENTITY_BY_RESOURCE[resource];
  if (!entityType) return;

  // A model-supplied id authorizes one call; it never becomes stored context.
  if (input.filters && Object.prototype.hasOwnProperty.call(input.filters, "id")) {
    return;
  }
  if (result.truncated || result.total !== 1 || result.rows.length !== 1) return;

  const row = result.rows[0]!;
  const id = text(row.id);
  if (!id || !UUID_RE.test(id)) return;

  const label = labelFor(resource, row);
  if (!label) return;

  ctx.contextRecorder.propose(entityType, id, label, "resolution");
}
