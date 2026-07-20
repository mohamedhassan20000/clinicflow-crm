import "server-only";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_TIME_ZONE } from "@/lib/datetime";
import type { AuthedUser } from "@/lib/rbac";
import type { PromptLocale } from "@/lib/ai/prompts/doctor";
import type { AiTaskClass } from "@/lib/ai/platform/types";
import type { AiUserPermissionKey } from "@/lib/ai/permissions";
import type { Database } from "@/types/database";

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
   * can omit it; omission means "do not filter by task class".
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
