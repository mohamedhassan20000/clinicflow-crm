import type { UserRole } from "@/lib/rbac";

/**
 * One shared report vocabulary and authorization metadata for page context,
 * capability presentation, and the report tool. Data execution remains in the
 * server-only tool module; this policy module is safe to import from clients.
 */
export const CLINIC_REPORT_IDS = [
  "cancellations",
  "no_shows",
  "revenue",
  "followups",
  "doctor_performance",
  "receptionist_performance",
] as const;

export type ClinicReportId = (typeof CLINIC_REPORT_IDS)[number];

export type ClinicReportPolicy = {
  roles: readonly UserRole[];
  financial: boolean;
  acceptsDoctor: boolean;
  href: string;
  auditTable: string;
};

export const CLINIC_REPORTS = {
  cancellations: {
    roles: ["admin", "manager", "receptionist"],
    financial: false,
    acceptsDoctor: true,
    href: "/reports/cancellations",
    auditTable: "appointments",
  },
  no_shows: {
    roles: ["admin", "manager", "receptionist"],
    financial: false,
    acceptsDoctor: true,
    href: "/reports/no-shows",
    auditTable: "appointments",
  },
  revenue: {
    roles: ["admin", "manager"],
    financial: true,
    acceptsDoctor: true,
    href: "/reports/revenue",
    auditTable: "appointments",
  },
  followups: {
    roles: ["admin", "receptionist"],
    financial: false,
    acceptsDoctor: false,
    href: "/reports/follow-ups",
    auditTable: "follow_ups",
  },
  doctor_performance: {
    roles: ["admin", "manager"],
    financial: false,
    acceptsDoctor: true,
    href: "/reports/doctors",
    auditTable: "appointments",
  },
  receptionist_performance: {
    roles: ["admin", "manager"],
    financial: false,
    acceptsDoctor: false,
    href: "/reports/receptionists",
    auditTable: "profiles",
  },
} as const satisfies Record<ClinicReportId, ClinicReportPolicy>;

export function allowedClinicReports(
  role: UserRole,
  options: { financialGranted?: boolean } = {},
): ClinicReportId[] {
  const financialGranted = options.financialGranted ?? true;
  return CLINIC_REPORT_IDS.filter((id) => {
    const report = CLINIC_REPORTS[id];
    const roles: readonly UserRole[] = report.roles;
    return (
      roles.includes(role) &&
      (financialGranted || !report.financial)
    );
  });
}
