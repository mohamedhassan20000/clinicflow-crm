import {
  CLINIC_REPORT_IDS,
  type ClinicReportId,
} from "@/lib/ai/clinic-reports";
import type { PermissionUserRole } from "@/lib/page-permissions";

/**
 * Single source of truth for report DISCOVERY and per-user VISIBILITY across the
 * whole product — the report pages, Settings → Customize, per-user report
 * visibility config, Reset to Product Defaults, AI capability discovery and the
 * AI reporting tool all iterate this catalog. Adding one entry here makes a new
 * report appear in every one of those surfaces with no role-specific UI code.
 *
 * The report *id* vocabulary is shared with `lib/ai/clinic-reports.ts`
 * (`ClinicReportId`) so the two never diverge on what a report is called.
 *
 * VISIBILITY IS NOT AUTHORIZATION. Two independent gates decide whether a user
 * may open a report and see data:
 *   1. Data authorization — the report page's own role guard (`pageRoles`) and,
 *      at the data layer, RLS + the scope-aware RPCs. Unchanged by this catalog.
 *   2. Per-user visibility — `defaultVisibilityByRole` (the product default for
 *      the role) overlaid with the admin's per-employee overrides
 *      (`user_report_permissions`). This catalog owns gate #2 only.
 * A report is openable only when BOTH gates pass.
 */
export type ReportCatalogEntry = {
  id: ClinicReportId;
  href: string;
  /** Report page role guard — the roles whose data authorization admits this
   * report page. Mirrors each subpage's `requireRole(...)`. Authorization, not
   * visibility; kept in lockstep with the page guards. */
  pageRoles: readonly PermissionUserRole[];
  /** Clinic-wide money figures. */
  financial: boolean;
  /** Clinic-wide administrative/performance report (staff rankings, etc.). */
  administrative: boolean;
  /** Product-default visibility per role. Every role has a key so a new role
   * only needs a value here to get a sensible initial default. */
  defaultVisibilityByRole: Record<PermissionUserRole, boolean>;
  /** `reports` namespace translation keys for the index card. */
  titleKey: string;
  descriptionKey: string;
};

function vis(
  roles: Partial<Record<PermissionUserRole, boolean>>,
): Record<PermissionUserRole, boolean> {
  return {
    admin: roles.admin ?? false,
    receptionist: roles.receptionist ?? false,
    manager: roles.manager ?? false,
    doctor: roles.doctor ?? false,
    assistant: roles.assistant ?? false,
  };
}

/**
 * Roles that may open the self-scoped operational report pages. Doctors and
 * assistants are included: the scope-aware RPCs + RLS filter these reports to
 * exactly the appointments/follow-ups they are authorized for (a doctor's own,
 * an assistant's assigned doctors'), never clinic-wide.
 */
const SCOPED_OPERATIONAL_PAGE_ROLES: readonly PermissionUserRole[] = [
  "admin",
  "manager",
  "receptionist",
  "doctor",
  "assistant",
];
/**
 * Roles that may open the revenue report page. Financial: kept to the existing
 * data-authorized roles — doctors/assistants never see clinic-wide revenue.
 */
const OPERATIONAL_PAGE_ROLES: readonly PermissionUserRole[] = [
  "admin",
  "manager",
  "receptionist",
];
/**
 * Roles that may open the doctor-oriented "My Revenue" report. Strictly doctor
 * + assistant — admins/managers use the clinic-wide revenue report. The scope
 * is enforced by the dedicated RLS-scoped RPC; enabling the report never widens
 * data access.
 */
const MY_REVENUE_PAGE_ROLES: readonly PermissionUserRole[] = ["doctor", "assistant"];
/**
 * Roles that may open the doctor-oriented "My Performance" report. Strictly
 * doctor — it is a doctor's own operational performance, not clinic-wide staff
 * rankings (which stay admin/manager on `doctor_performance`). Assistants have
 * no personal performance surface of their own (their operational activity is
 * measured under 8C). Scope is enforced by the dedicated RLS-scoped RPC.
 */
const MY_PERFORMANCE_PAGE_ROLES: readonly PermissionUserRole[] = ["doctor"];
/** Roles that may open the administrative performance report pages today. */
const PERFORMANCE_PAGE_ROLES: readonly PermissionUserRole[] = ["admin", "manager"];

export const REPORT_CATALOG: Record<ClinicReportId, ReportCatalogEntry> = {
  cancellations: {
    id: "cancellations",
    href: "/reports/cancellations",
    pageRoles: SCOPED_OPERATIONAL_PAGE_ROLES,
    financial: false,
    administrative: false,
    defaultVisibilityByRole: vis({
      admin: true,
      manager: true,
      receptionist: true,
      doctor: true,
      assistant: true,
    }),
    titleKey: "cancellationReport",
    descriptionKey: "cancelledAppointmentsByDoctorAndReason",
  },
  no_shows: {
    id: "no_shows",
    href: "/reports/no-shows",
    pageRoles: SCOPED_OPERATIONAL_PAGE_ROLES,
    financial: false,
    administrative: false,
    defaultVisibilityByRole: vis({
      admin: true,
      manager: true,
      receptionist: true,
      doctor: true,
      assistant: true,
    }),
    titleKey: "noShowReport",
    descriptionKey: "noShowAppointmentRatesByDoctor",
  },
  revenue: {
    id: "revenue",
    href: "/reports/revenue",
    pageRoles: OPERATIONAL_PAGE_ROLES,
    financial: true,
    administrative: false,
    defaultVisibilityByRole: vis({
      admin: true,
      manager: true,
      receptionist: true,
      doctor: false,
      assistant: false,
    }),
    titleKey: "revenueSalesReport",
    descriptionKey: "collectedPaymentsSettlementsAndBalances",
  },
  my_revenue: {
    id: "my_revenue",
    href: "/reports/my-revenue",
    pageRoles: MY_REVENUE_PAGE_ROLES,
    financial: true,
    administrative: false,
    // OFF for everyone by default — opt-in only. The primary admin enables it
    // per employee via Customize / Report Permissions.
    defaultVisibilityByRole: vis({ doctor: false, assistant: false }),
    titleKey: "myRevenueReport",
    descriptionKey: "yourCollectedRevenueFromCompletedAppointments",
  },
  my_performance: {
    id: "my_performance",
    href: "/reports/my-performance",
    pageRoles: MY_PERFORMANCE_PAGE_ROLES,
    financial: false,
    // Self-scoped, not clinic-wide staff rankings.
    administrative: false,
    // OFF for everyone by default — opt-in only. The primary admin enables it
    // per doctor via Customize / Report Permissions.
    defaultVisibilityByRole: vis({ doctor: false }),
    titleKey: "myPerformanceReport",
    descriptionKey: "yourOwnOperationalPerformance",
  },
  followups: {
    id: "followups",
    href: "/reports/follow-ups",
    pageRoles: SCOPED_OPERATIONAL_PAGE_ROLES,
    financial: false,
    administrative: false,
    defaultVisibilityByRole: vis({
      admin: true,
      manager: true,
      receptionist: true,
      doctor: true,
      assistant: true,
    }),
    titleKey: "followUpsReport",
    descriptionKey: "completedFollowUpOutcomes",
  },
  doctor_performance: {
    id: "doctor_performance",
    href: "/reports/doctors",
    pageRoles: PERFORMANCE_PAGE_ROLES,
    financial: false,
    administrative: true,
    defaultVisibilityByRole: vis({ admin: true, manager: true }),
    titleKey: "doctorPerformanceReport",
    descriptionKey: "doctorSessionsOutcomesRevenueAndShare",
  },
  receptionist_performance: {
    id: "receptionist_performance",
    href: "/reports/receptionists",
    pageRoles: PERFORMANCE_PAGE_ROLES,
    financial: false,
    administrative: true,
    defaultVisibilityByRole: vis({ admin: true, manager: true }),
    titleKey: "receptionistPerformanceReport",
    descriptionKey: "bookingsAndFollowUpsHandledByReceptionist",
  },
};

/** Ordered catalog list (stable UI order). */
export const REPORT_CATALOG_LIST: readonly ReportCatalogEntry[] =
  CLINIC_REPORT_IDS.map((id) => REPORT_CATALOG[id]);

export function isReportId(value: string): value is ClinicReportId {
  return (CLINIC_REPORT_IDS as readonly string[]).includes(value);
}

/** The product-default visibility for one report and role. */
export function reportDefaultVisibleForRole(
  id: ClinicReportId,
  role: PermissionUserRole,
): boolean {
  return REPORT_CATALOG[id].defaultVisibilityByRole[role];
}

/** Reports whose page role-guard admits this role (data-authorization gate). */
export function reportsOpenableByRole(
  role: PermissionUserRole,
): ClinicReportId[] {
  return REPORT_CATALOG_LIST.filter((entry) =>
    entry.pageRoles.includes(role),
  ).map((entry) => entry.id);
}
