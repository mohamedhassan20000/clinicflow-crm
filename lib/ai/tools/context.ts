import "server-only";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";
import type { AuthedUser } from "@/lib/rbac";
import type { PromptLocale } from "@/lib/ai/prompts/doctor";
import type { AiTaskClass } from "@/lib/ai/platform/types";
import type { AiUserPermissionKey } from "@/lib/ai/permissions";
import type {
  ActiveContext,
  ConversationContextRecorder,
} from "@/lib/ai/conversation-context";
import type { Database } from "@/types/database";
import type { Tool } from "ai";

export type WorkflowMountDefinition = {
  name: string;
  workflow: {
    kind: "read" | "action" | "orchestrator";
    costUnits: number;
  };
};

export type WorkflowStepMount = {
  definitions: readonly WorkflowMountDefinition[];
  tools: Readonly<Record<string, Tool>>;
};

/**
 * Server-resolved context every doctor tool closes over. Identity is captured
 * from the authorized session at the surface boundary (never from the model),
 * so a tool's clinic and actor cannot be influenced by prompt content (§9.1).
 */
export type DoctorToolContext = {
  user: AuthedUser;
  locale: PromptLocale;
  /**
   * Optional patient the staff member opened the assistant on (the patient-
   * profile launcher, §6.2). Advisory only — the get_patient_summary tool still
   * takes an explicit patient_id and RLS still scopes every read.
   */
  patientId?: string | null;
  /**
   * The certified task class this turn is running under (P4.6A). The registry
   * filters the mount by it, so a tool is only reachable in the kinds of turn
   * it was declared for. Optional so non-route callers (tests, future surfaces)
   * can omit it; omission means "resolve the authorized union across the task
   * classes the router supports for this user's role". A supplied class still
   * produces the narrower active-turn mount.
   */
  taskClass?: AiTaskClass | null;
  /**
   * Per-user AI permissions resolved once at mount time (P4.6 phase review H1).
   *
   * This exists for tools whose *description* depends on a grant they do not
   * themselves require to mount. `run_clinic_report` is the only such tool: it
   * mounts for any administrative role because most of its reports are
   * non-financial, but its description enumerates the reports the user may run
   * — and enumerating `revenue` to a manager without the financial grant put a
   * promise into the model's context that `execute()` would then refuse.
   *
   * **Presentation only.** Never an authorization decision: every financial
   * path still calls `assertFinancialInsightsAccess`, which re-reads the grant
   * from the database on every invocation. A stale or absent set here can only
   * make the assistant offer less than it could, never more.
   */
  grantedPermissions?: ReadonlySet<AiUserPermissionKey>;
  /**
   * The active patient resolved from the conversation's session context
   * (P4.10A), captured at the start of the turn. Used as a **default parameter**
   * for entity-scoped patient tools when the model omits `patient_id`, so a
   * pronoun/"this patient" follow-up resolves to the same patient without
   * re-asking.
   *
   * Advisory identity default only. Every patient tool still re-runs its full
   * authorization and RLS on the effective id, so a stale context can only
   * return `found: false`, never data the user has lost access to. Omitted
   * (null) means the tool has no fallback and must ask which patient.
   */
  activePatientId?: string | null;
  /**
   * All validated conversation-scoped entity defaults (P4.10B). Tools read
   * only the id for the entity type they already support, and then re-run their
   * normal authorization/RLS query on that effective id. Broad/list tools use
   * a slot only when their matching `use_active_*` input explicitly represents
   * entity-scoped user intent; omission alone never narrows a list.
   */
  activeContext?: ActiveContext | null;
  /**
   * The conversation the turn belongs to. Present on the route surface; omitted
   * by non-route callers (tests, future surfaces), in which case no context is
   * recorded.
   */
  conversationId?: string | null;
  /**
   * Collects an active-context proposal from a tool during the turn (e.g. a
   * high-confidence patient resolution), applied once when the turn is
   * persisted. Server-derived ids only — a tool never asserts an id from model
   * free text. Omitted by callers that do not persist context.
   */
  contextRecorder?: ConversationContextRecorder | null;
  /**
   * P4.11A internal-only nested mount. The workflow orchestrator receives the
   * caller's already-resolved read-tool union without exposing those tools as
   * peer model calls in the dedicated workflow task class.
   */
  workflowStepMount?: (() => WorkflowStepMount) | null;
  /** Content-free link to the provider-budget reservation for this turn. */
  aiRequestId?: string | null;
};

/** ISO calendar date, e.g. "2026-07-18". */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function resolveClinicTimeZone(
  supabase: SupabaseClient<Database>,
  clinicId: string,
): Promise<string> {
  const { data: clinic } = await supabase
    .from("clinics")
    .select("timezone")
    .eq("id", clinicId)
    .maybeSingle();
  return typeof clinic?.timezone === "string" && clinic.timezone
    ? clinic.timezone
    : DEFAULT_TIME_ZONE;
}

export function clinicDateRangeToUtc(
  from: string,
  to: string,
  timeZone: string,
): { start: string; end: string } {
  return {
    start: fromZonedTime(`${from}T00:00:00.000`, timeZone).toISOString(),
    end: fromZonedTime(`${to}T23:59:59.999`, timeZone).toISOString(),
  };
}

export function omitElapsedClinicSlots(
  dateIso: string,
  slots: string[],
  timeZone: string,
  now = new Date(),
): string[] {
  const today = formatInTimeZone(now, timeZone, "yyyy-MM-dd");
  if (dateIso < today) return [];
  if (dateIso > today) return slots;

  return slots.filter(
    (time) => fromZonedTime(`${dateIso}T${time}:00`, timeZone).getTime() > now.getTime(),
  );
}
