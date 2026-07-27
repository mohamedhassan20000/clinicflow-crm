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
  "my_revenue",
  "my_performance",
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

export const CLINIC_REPORT_LABELS: Record<
  ClinicReportId,
  { en: string; ar: string }
> = {
  cancellations: { en: "Cancellations report", ar: "تقرير الإلغاءات" },
  no_shows: { en: "No-show report", ar: "تقرير عدم الحضور" },
  revenue: { en: "Revenue report", ar: "تقرير الإيرادات" },
  my_revenue: { en: "My revenue report", ar: "تقرير إيراداتي" },
  my_performance: { en: "My performance report", ar: "تقرير أدائي" },
  followups: { en: "Follow-ups report", ar: "تقرير المتابعات" },
  doctor_performance: {
    en: "Doctor performance report",
    ar: "تقرير أداء الأطباء",
  },
  receptionist_performance: {
    en: "Receptionist performance report",
    ar: "تقرير أداء موظفي الاستقبال",
  },
};

export function clinicReportLabel(
  report: ClinicReportId,
  locale: "ar" | "en",
): string {
  return CLINIC_REPORT_LABELS[report][locale];
}

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
  my_revenue: {
    // Doctor-oriented, self/assigned-scoped revenue. Never admin/manager — those
    // use the clinic-wide `revenue` report. Scope is enforced by RLS in the
    // dedicated RPC; no doctor dimension (the aggregate is already the caller's
    // own / their supervised-doctor union).
    roles: ["doctor", "assistant"],
    financial: true,
    acceptsDoctor: false,
    href: "/reports/my-revenue",
    auditTable: "appointments",
  },
  my_performance: {
    // Doctor-oriented, self-scoped operational performance. Never admin/manager
    // (they use the clinic-wide `doctor_performance` report) and never
    // assistant. The scope is enforced by RLS + an explicit `doctor_id`
    // predicate in the dedicated RPC; no doctor dimension (the aggregate is the
    // caller's own).
    roles: ["doctor"],
    financial: false,
    acceptsDoctor: false,
    href: "/reports/my-performance",
    auditTable: "appointments",
  },
  followups: {
    roles: ["admin", "manager", "receptionist"],
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
