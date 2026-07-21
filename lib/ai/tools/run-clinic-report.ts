import "server-only";

import { tool } from "ai";
import { z } from "zod";
import {
  assertAnalyticsToolAccess,
  assertFinancialInsightsAccess,
} from "@/lib/ai/authorization";
import { logAgentTool } from "@/lib/ai/audit";
import { AiToolAuthorizationError } from "@/lib/ai/errors";
import type { DoctorToolContext } from "@/lib/ai/tools/context";
import {
  filterClarification,
  resolveDoctorFilter,
} from "@/lib/ai/tools/entity-filters";
import {
  dateRangeInputSchema,
  describeRange,
  resolveToolDateRange,
} from "@/lib/ai/tools/range";
import { createClient } from "@/lib/supabase/server";
import {
  getCancellationReportData,
  getDoctorPerformanceData,
  getFollowupsReportData,
  getNoShowReportData,
  getReceptionistPerformanceData,
  getRevenueSummaryData,
} from "@/lib/reports/data";
import type { AuthedUser, UserRole } from "@/lib/rbac";
import type { ResolvedDateRange } from "@/lib/date-range";
import {
  allowedClinicReports,
  CLINIC_REPORT_IDS,
  CLINIC_REPORTS,
  type ClinicReportId,
} from "@/lib/ai/clinic-reports";

export { CLINIC_REPORT_IDS, type ClinicReportId } from "@/lib/ai/clinic-reports";

type ReportDefinition = {
  id: ClinicReportId;
  /**
   * Roles allowed to run the report. These mirror the role guards inside the
   * underlying report RPCs exactly — the assistant is never a way around a
   * denial the same user would hit on the reports page. Note `followups`
   * excludes managers and `revenue` excludes receptionists for that reason.
   */
  roles: readonly UserRole[];
  financial: boolean;
  /**
   * Whether the report core actually uses a doctor filter. `followups` and
   * `receptionist_performance` discard it, so resolving one for them produced
   * either an ambiguity clarification about a filter that would have had no
   * effect, or a filter that resolved and was then silently ignored. Declaring
   * it per report keeps the tool from asking a question its answer cannot use.
   */
  acceptsDoctor: boolean;
  href: string;
  /**
   * Primary table this report reads, for the audit ledger. Logging
   * "appointments" for every report — including `followups` and `revenue` —
   * made the ledger's answer to "what did the assistant touch" wrong.
   */
  auditTable: string;
  run: (input: {
    user: AuthedUser;
    range: ResolvedDateRange;
    doctorId: string | null;
  }) => Promise<unknown>;
};

const REPORTS: Record<ClinicReportId, ReportDefinition> = {
  cancellations: {
    id: "cancellations",
    ...CLINIC_REPORTS.cancellations,
    run: ({ user, range, doctorId }) => getCancellationReportData(user, range, doctorId),
  },
  no_shows: {
    id: "no_shows",
    ...CLINIC_REPORTS.no_shows,
    run: ({ range, doctorId }) => getNoShowReportData(range, doctorId),
  },
  revenue: {
    id: "revenue",
    ...CLINIC_REPORTS.revenue,
    run: ({ range, doctorId }) => getRevenueSummaryData(range, doctorId, null),
  },
  followups: {
    id: "followups",
    ...CLINIC_REPORTS.followups,
    run: ({ range }) => getFollowupsReportData(range, null),
  },
  doctor_performance: {
    id: "doctor_performance",
    ...CLINIC_REPORTS.doctor_performance,
    run: ({ range, doctorId }) => getDoctorPerformanceData(range, doctorId),
  },
  receptionist_performance: {
    id: "receptionist_performance",
    ...CLINIC_REPORTS.receptionist_performance,
    run: ({ range }) => getReceptionistPerformanceData(range, null),
  },
};

/**
 * The report ids a given user may actually run — and therefore the list the
 * tool's description advertises to the model.
 *
 * `financialGranted` is the P4.6 phase-review H1 fix. Filtering on `roles`
 * alone put *"Available reports for this user: … revenue …"* into the context of
 * a manager who holds no financial grant: the model would then offer the
 * revenue report, the user would ask for it, and `execute()` would refuse.
 * Every other financial tool avoids this by simply not mounting;
 * `run_clinic_report` cannot, because four of its six reports are non-financial
 * and the manager is legitimately entitled to those. So the *description* is
 * filtered instead of the mount.
 *
 * This is presentation, not authorization — `execute()` re-runs the full
 * financial gate against the database regardless of what the description said.
 */
export function allowedReportsForRole(
  role: UserRole,
  options: { financialGranted?: boolean } = {},
): ClinicReportId[] {
  return allowedClinicReports(role, options);
}

function reportDeepLink(report: ReportDefinition, range: ResolvedDateRange): string {
  const params = new URLSearchParams({
    preset: range.preset,
    from: range.from,
    to: range.to,
  });
  return `${report.href}?${params.toString()}`;
}

/**
 * run_clinic_report — runs one of the existing, already RLS-scoped report cores
 * from lib/reports/data.ts and returns its normalized result plus a deep link to
 * the real report page, so the user can verify any number the assistant quotes.
 *
 * Authorization is layered: the per-report role list is checked here, financial
 * reports additionally pass the full financial gate, and the underlying RPC
 * re-checks the caller a third time in the database.
 */
export function runClinicReportTool(ctx: DoctorToolContext) {
  const financialGranted =
    ctx.grantedPermissions?.has("ai.financial_insights") ?? false;
  const allowed = allowedReportsForRole(ctx.user.role, { financialGranted });
  // L7 (review #2): derived from `acceptsDoctor` over the reports this caller
  // may actually run, not hardcoded. The hardcoded sentence named `revenue` to
  // every caller — including the manager whose `allowed` list two lines above
  // deliberately excludes it — which is the same string re-introducing the same
  // report name into the same model context that review #1's H1 removed.
  const acceptsDoctor = allowed.filter((id) => REPORTS[id].acceptsDoctor);
  const ignoresDoctor = allowed.filter((id) => !REPORTS[id].acceptsDoctor);

  return tool({
    description:
      `Run one of the clinic's standard reports and return its computed results plus a link to the full report page. Available reports for this user: ${allowed.join(", ")}. Do not offer any report outside that list. Always offer the returned link so the user can open the full report.`,
    inputSchema: dateRangeInputSchema.extend({
      report: z.enum(CLINIC_REPORT_IDS).describe("Which report to run."),
      doctor: z
        .string()
        .trim()
        .min(2)
        .max(120)
        .optional()
        .describe(
          acceptsDoctor.length === 0
            ? "Optional doctor name or id. None of the reports available to this user has a doctor dimension, so it is ignored."
            : `Optional doctor name or id to scope the report to. Only ${acceptsDoctor.join(", ")} use it${
                ignoresDoctor.length > 0
                  ? `; ${ignoresDoctor.join(", ")} have no doctor dimension and ignore it`
                  : ""
              }.`,
        ),
    }),
    execute: async ({ report, doctor, ...rangeInput }) => {
      const definition = REPORTS[report];

      // Role check first: an unavailable report must deny before any read.
      if (!definition.roles.includes(ctx.user.role)) {
        throw new AiToolAuthorizationError(
          "role_forbidden",
          `Role "${ctx.user.role}" may not run the ${report} report.`,
        );
      }
      // One gate, asserted straight.
      //
      // This used to route the financial branch through a local
      // `financialDenialReason` helper that caught exactly two of the reasons
      // the chain can raise and returned them as a structured result, while
      // re-throwing `page_hidden`, `subscription_inactive`, and `lookup_failed`
      // — three denials that are just as user-actionable, and more likely
      // mid-conversation, since an admin can flip either of the first two from
      // a settings screen while a session is open (review #2, M3).
      //
      // The conversion now happens once in `harden()` for every tool and every
      // reason, so this call site is back to simply asserting. Note
      // `assertFinancialInsightsAccess` runs `assertAnalyticsToolAccess`
      // internally, which is why the financial branch does not call it too.
      if (definition.financial) {
        await assertFinancialInsightsAccess(ctx.user);
      } else {
        await assertAnalyticsToolAccess(ctx.user);
      }

      const supabase = await createClient();
      const range = resolveToolDateRange(rangeInput);

      // Only resolve a doctor filter for reports whose core actually applies
      // one; otherwise a name would trigger a clarification about a filter that
      // could not have changed the answer.
      const doctorFilter = definition.acceptsDoctor
        ? await resolveDoctorFilter(supabase, doctor)
        : ({ status: "unset", id: null } as const);
      const clarification =
        doctor && definition.acceptsDoctor
          ? filterClarification("doctor", doctor, doctorFilter)
          : null;
      if (clarification) return clarification;

      const result = await definition.run({
        user: ctx.user,
        range,
        doctorId: doctorFilter.id,
      });

      await logAgentTool({
        clinicId: ctx.user.clinicId,
        actorId: ctx.user.id,
        tool: "run_clinic_report",
        tableName: definition.auditTable,
        params: {
          report,
          preset: range.preset,
          from: range.from,
          to: range.to,
          doctor_filtered: Boolean(doctorFilter.id),
          doctor_filter_ignored: Boolean(doctor) && !definition.acceptsDoctor,
        },
      });

      return {
        report,
        // Says so out loud when a doctor name was given to a report that has no
        // doctor dimension, rather than answering as though it had been applied.
        doctor_filter_applied: Boolean(doctorFilter.id),
        doctor_filter_supported: definition.acceptsDoctor,
        range: describeRange(range),
        link: reportDeepLink(definition, range),
        result,
      };
    },
  });
}
