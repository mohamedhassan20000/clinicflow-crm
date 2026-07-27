import "server-only";

import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { ClinicReportId } from "@/lib/ai/clinic-reports";
import {
  REPORT_CATALOG_LIST,
  isReportId,
  reportDefaultVisibleForRole,
} from "@/lib/reports/catalog";
import type { PermissionUserRole } from "@/lib/page-permissions";
import type { AuthedUser } from "@/lib/rbac";

export type ReportVisibilityState = "visible" | "hidden" | "lookup_failed";

function asRole(role: string): PermissionUserRole | null {
  return role === "admin" ||
    role === "receptionist" ||
    role === "manager" ||
    role === "doctor" ||
    role === "assistant"
    ? role
    : null;
}

/**
 * The report ids visible to a user: the role's product defaults overlaid with
 * the admin's per-employee overrides (`user_report_permissions`). Visibility
 * only — every caller still applies its own data-authorization gate.
 */
export async function getVisibleReportIds(
  user: Pick<AuthedUser, "id" | "clinicId" | "role">,
): Promise<ClinicReportId[]> {
  const role = asRole(user.role);
  if (!role) return [];

  const visible = new Set<ClinicReportId>(
    REPORT_CATALOG_LIST.filter((entry) =>
      reportDefaultVisibleForRole(entry.id, role),
    ).map((entry) => entry.id),
  );

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("user_report_permissions")
    .select("report_id, is_visible")
    .eq("user_id", user.id)
    .eq("clinic_id", user.clinicId);

  // Discovery is authorization-sensitive: when stored overrides cannot be
  // resolved, role defaults are not evidence that a report remains visible.
  // Fail closed so the Reports index and AI capability presentation never
  // advertise a report that may have been hidden for this employee.
  if (error) return [];

  for (const row of data ?? []) {
    if (!isReportId(row.report_id)) continue;
    if (row.is_visible) visible.add(row.report_id);
    else visible.delete(row.report_id);
  }

  return Array.from(visible);
}

const readReportVisibilityFor = cache(
  async (
    id: string,
    clinicId: string,
    role: string,
    reportId: ClinicReportId,
  ): Promise<ReportVisibilityState> => {
    const parsedRole = asRole(role);
    if (!parsedRole) return "hidden";

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("user_report_permissions")
      .select("is_visible")
      .eq("user_id", id)
      .eq("clinic_id", clinicId)
      .eq("report_id", reportId)
      .maybeSingle();

    if (error) {
      // A real infrastructure failure must fail closed for authorization-
      // sensitive callers; but a missing row is not an error (maybeSingle).
      return "lookup_failed";
    }
    if (data) return data.is_visible ? "visible" : "hidden";
    // No override stored → fall back to the role's product default.
    return reportDefaultVisibleForRole(reportId, parsedRole)
      ? "visible"
      : "hidden";
  },
);

/**
 * Resolves one report's visibility for a user, distinguishing a saved denial
 * from an infrastructure failure so authorization-sensitive callers (report
 * pages, AI tool) can fail closed. Request-scoped memo mirrors the assistant
 * page-visibility pattern.
 */
export function getReportVisibilityState(
  user: Pick<AuthedUser, "id" | "clinicId" | "role">,
  reportId: ClinicReportId,
): Promise<ReportVisibilityState> {
  return readReportVisibilityFor(user.id, user.clinicId, user.role, reportId);
}
