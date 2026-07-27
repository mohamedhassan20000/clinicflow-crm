import "server-only";

import { notFound } from "next/navigation";
import { requireRole, type AuthedUser } from "@/lib/rbac";
import { getPageVisibilityState } from "@/lib/server-page-permissions";
import { getReportVisibilityState, getVisibleReportIds } from "@/lib/server-report-permissions";
import type { ClinicReportId } from "@/lib/ai/clinic-reports";
import {
  REPORT_CATALOG,
  reportsOpenableByRole,
} from "@/lib/reports/catalog";
import type { PermissionUserRole } from "@/lib/page-permissions";

/**
 * Whether a report's doctor dimension is locked to the caller's own scope.
 * Doctors and assistants only ever see their own / their assigned doctors'
 * data (RLS-enforced), so the cross-doctor filter is hidden for them and the
 * report shows their scoped aggregate.
 */
export function reportScopeLockedToSelf(role: string): boolean {
  return role === "doctor" || role === "assistant";
}

/** Every role that may reach the Reports index (data-authorized for ≥1 report). */
const REPORTS_INDEX_ROLES = [
  "admin",
  "manager",
  "receptionist",
  "doctor",
  "assistant",
] as const;

/**
 * Guards the Reports index. Requires an eligible role AND the Reports page to be
 * visible for this user. Returns the user plus the report ids they may open
 * (data-authorized AND per-user visible) so the index renders exactly those.
 */
export async function requireReportsIndexAccess(): Promise<{
  user: AuthedUser;
  visibleOpenableReportIds: ClinicReportId[];
}> {
  const user = await requireRole([...REPORTS_INDEX_ROLES]);

  const pageVisibility = await getPageVisibilityState(user, "reports");
  if (pageVisibility !== "visible") notFound();

  const openable = new Set(
    reportsOpenableByRole(user.role as PermissionUserRole),
  );
  const visible = new Set(await getVisibleReportIds(user));
  const visibleOpenableReportIds = [...openable].filter((id) =>
    visible.has(id),
  );

  return { user, visibleOpenableReportIds };
}

/**
 * Guards one report subpage. Enforces BOTH gates: data authorization (the
 * report's page role guard + Reports page visible) AND per-user report
 * visibility. A hidden report is a 404 on direct URL — visibility never leaks
 * that the report exists but is turned off.
 */
export async function requireReportAccess(
  reportId: ClinicReportId,
): Promise<AuthedUser> {
  const entry = REPORT_CATALOG[reportId];
  const user = await requireRole([...entry.pageRoles]);

  const [pageVisibility, reportVisibility] = await Promise.all([
    getPageVisibilityState(user, "reports"),
    getReportVisibilityState(user, reportId),
  ]);
  if (pageVisibility !== "visible") notFound();
  if (reportVisibility !== "visible") notFound();

  return user;
}
