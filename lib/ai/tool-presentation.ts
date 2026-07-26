/**
 * How the assistant surface presents a tool and its result (P4.6B).
 *
 * Deliberately dependency-free and shared by the client chat and its tests: it
 * is presentation metadata, not authorization. Nothing here decides what runs —
 * `lib/ai/tools/registry.ts` and each tool's own `execute()` do, on the server.
 * A tool absent from this map still works; it just renders with the generic
 * label, which is the correct failure mode for a display concern.
 */

import type { AiToolDenialReason } from "@/lib/ai/errors";

/**
 * Financial results are separated from operational ones because they are read
 * differently and are governed differently: the financial group is the one
 * behind `ai.financial_insights` plus a per-user grant, and a revenue figure
 * that looks visually identical to an appointment count invites a reader to
 * treat "the assistant said 42,000" with the same weight as "the assistant
 * listed 3 appointments".
 */
export type AssistantToolGroup = "clinical" | "operational" | "financial" | "guidance";

export type AssistantToolPresentation = {
  /** Key under the `assistant` i18n namespace. */
  labelKey: string;
  group: AssistantToolGroup;
};

export const ASSISTANT_TOOL_PRESENTATION: Readonly<
  Record<string, AssistantToolPresentation>
> = {
  // P4 tools
  get_patient_summary: { labelKey: "toolPatientSummary", group: "clinical" },
  search_authorized_patients: { labelKey: "toolPatientLookup", group: "clinical" },
  search_patient_visits: { labelKey: "toolVisitSearch", group: "clinical" },
  list_doctor_appointments: { labelKey: "toolAppointments", group: "clinical" },
  check_availability: { labelKey: "toolAvailability", group: "clinical" },

  // P4.6A clinic-wide aggregates
  get_clinic_summary: { labelKey: "toolClinicSummary", group: "operational" },
  get_patient_stats: { labelKey: "toolPatientStats", group: "operational" },
  get_appointment_stats: { labelKey: "toolAppointmentStats", group: "operational" },

  // P4.6A operational lists, counts, and reports
  list_appointments: { labelKey: "toolListAppointments", group: "operational" },
  count_new_patients: { labelKey: "toolCountNewPatients", group: "operational" },
  list_pending_followups: { labelKey: "toolPendingFollowups", group: "operational" },
  run_clinic_report: { labelKey: "toolRunReport", group: "operational" },

  // P4.6A financial tools
  get_revenue_summary: { labelKey: "toolRevenueSummary", group: "financial" },
  compare_revenue_periods: { labelKey: "toolCompareRevenue", group: "financial" },
  list_outstanding_invoices: { labelKey: "toolOutstandingInvoices", group: "financial" },

  // P4.7A help & navigation. Their own group so the label never reads as "reviewing
  // records": these tools touch no clinic data, and presenting a documentation
  // lookup as a record review would be a small dishonesty of exactly the kind the
  // phase is about.
  search_help: { labelKey: "toolSearchHelp", group: "guidance" },
  get_navigation_target: { labelKey: "toolNavigation", group: "guidance" },

  // P4.7B capability transparency. Guidance group for the same reason: it reads
  // no clinic data, and it frames what the assistant can do rather than reporting
  // a record.
  list_my_capabilities: { labelKey: "toolCapabilities", group: "guidance" },

  // P4.11 workflow envelope; action previews add their own confirmation card.
  execute_read_only_workflow: {
    labelKey: "toolWorkflow",
    group: "operational",
  },
  send_appointment_reminders: {
    labelKey: "toolAppointmentReminderWorkflow",
    group: "operational",
  },
  send_invoice_reminders: {
    labelKey: "toolInvoiceReminderWorkflow",
    group: "financial",
  },
  create_pending_booking: {
    labelKey: "toolPendingBookingWorkflow",
    group: "operational",
  },
};

export function presentationFor(toolName: string): AssistantToolPresentation {
  return (
    ASSISTANT_TOOL_PRESENTATION[toolName] ?? {
      labelKey: "toolRecordReview",
      group: "clinical",
    }
  );
}

/**
 * A caveat the *user* must see, extracted from a tool result.
 *
 * The tools already carry these signals for the model's benefit — `clamped`,
 * `truncated`, `suppressed_bucket_count`, `patients_total_exact` — and the
 * model is instructed to relay them. Rendering them from the structured result
 * as well means a caveat cannot be lost to a model that summarized loosely,
 * which is the failure mode that turns an honest tool into a misleading answer.
 */
export type AssistantResultNotice =
  | { kind: "range_clamped"; from: string; to: string }
  | { kind: "truncated"; rowCap: number }
  /**
   * Small groups were generalized into one aggregate bucket (phase review #3,
   * H1). There is no per-group caveat to render any more, because no group
   * below the floor is named or counted individually — the honest statement is
   * how many groups were combined and how many patients that covers, both of
   * which the payload gives exactly.
   */
  | {
      kind: "suppressed";
      groupedBuckets: number;
      groupedPatients: number;
      floor: number;
    }
  /**
   * Every bucket was suppressed, so the RPC declined the grouping rather than
   * emitting a list of nameless nulls. There is nothing to caveat here — there
   * is no distribution.
   */
  | { kind: "distribution_withheld" }
  | { kind: "all_time_scope" }
  | { kind: "needs_clarification" }
  /**
   * A tool refused for a reason the user can act on.
   *
   * `harden()` returns this instead of throwing, because a throw inside the
   * model loop cannot carry structure into an already-streaming message — the
   * user saw a generic "try again" for a denial that retrying can never fix.
   *
   * Widened from two reasons to the whole `AiToolDenialReason` union by review
   * #2's M3: `page_hidden` and `subscription_inactive` are as user-actionable
   * as the two that were handled, and are *more* likely to appear mid-turn,
   * since an admin can flip either while a session is open.
   */
  | { kind: "permission_denied"; reason: AiToolDenialReason }
  /** Free text in the result was length-capped on its way into model context. */
  | { kind: "text_truncated"; fields: number };

export type AssistantResultSummary = {
  notices: AssistantResultNotice[];
  /** Safe top-level deep link returned by report/navigation tools. */
  link: string | null;
  /** Controls destination-appropriate localized link copy. */
  linkKind: "report" | "navigation" | null;
  /** Localized section/label supplied by the navigation resolver. */
  linkLabel: string | null;
  /** Structured citations supplied by `search_help` results. */
  citations: AssistantHelpCitation[];
};

export type AssistantHelpCitation = {
  articleId: string;
  title: string;
  section: string;
  /** Absent when the destination is unavailable to this caller. */
  link: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Guards the reason before it selects copy. The value crosses the model loop as
 * plain JSON, so an unrecognized string must produce no notice rather than a
 * lookup miss rendered as a blank line.
 */
const DENIAL_REASONS: readonly AiToolDenialReason[] = [
  "unauthenticated",
  "role_forbidden",
  "page_hidden",
  "feature_not_entitled",
  "permission_not_granted",
  "usage_limit_reached",
  "lookup_failed",
  "subscription_inactive",
];

function isDenialReason(value: unknown): value is AiToolDenialReason {
  return (DENIAL_REASONS as readonly unknown[]).includes(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Reads a tool result defensively. Every field is optional and every shape is
 * checked, because this runs on model-loop output and must never throw inside
 * a message bubble — a malformed result should render as "no notices", not as
 * a broken conversation.
 */
export function summarizeToolResult(
  output: unknown,
  toolName?: string,
): AssistantResultSummary {
  const result = asRecord(output);
  if (!result) {
    return { notices: [], link: null, linkKind: null, linkLabel: null, citations: [] };
  }

  const notices: AssistantResultNotice[] = [];

  if (result.permission_denied === true && isDenialReason(result.reason)) {
    notices.push({ kind: "permission_denied", reason: result.reason });
  }

  const truncatedFields = result.text_truncated_fields;
  if (Array.isArray(truncatedFields) && truncatedFields.length > 0) {
    notices.push({ kind: "text_truncated", fields: truncatedFields.length });
  }

  const range = asRecord(result.range);
  if (range?.clamped === true) {
    notices.push({
      kind: "range_clamped",
      from: typeof range.from === "string" ? range.from : "",
      to: typeof range.to === "string" ? range.to : "",
    });
  }

  const rowCap = asNumber(result.row_cap);
  if (result.truncated === true && rowCap !== null) {
    notices.push({ kind: "truncated", rowCap });
  }

  // get_patient_stats nests its payload under `stats`; the suppression fields
  // come straight from the RPC.
  const stats = asRecord(result.stats);
  if (stats) {
    const suppressed = asNumber(stats.suppressed_bucket_count) ?? 0;
    const floor = asNumber(stats.suppression_floor);
    if (stats.distribution_withheld === true) {
      notices.push({ kind: "distribution_withheld" });
    } else if (suppressed > 0 && floor !== null) {
      // Both figures come straight from the RPC and are exact. The notice is
      // omitted rather than rendered with a blank if either is missing, since
      // "some groups were combined" without saying how many reads as a hedge
      // rather than as a disclosure.
      const groupedPatients = asNumber(stats.suppressed_patient_count);
      if (groupedPatients !== null) {
        notices.push({
          kind: "suppressed",
          groupedBuckets: suppressed,
          groupedPatients,
          floor,
        });
      }
    }
  }

  if (result.scope === "all_time") notices.push({ kind: "all_time_scope" });

  // The P4.6C contract: below high confidence the tool returns candidates and
  // asks the user to choose rather than guessing a namesake.
  if (
    result.needs_clarification === true ||
    (typeof result.confidence === "string" &&
      result.confidence !== "high" &&
      Array.isArray(result.patients))
  ) {
    notices.push({ kind: "needs_clarification" });
  }

  const link = safeInternalLink(result.link);
  const linkLabel =
    typeof result.section === "string"
      ? result.section
      : typeof result.label === "string"
        ? result.label
        : null;

  const citations: AssistantHelpCitation[] = [];
  if (toolName === "search_help" && Array.isArray(result.results)) {
    for (const value of result.results) {
      const article = asRecord(value);
      if (!article) continue;
      if (
        typeof article.article_id !== "string" ||
        typeof article.title !== "string" ||
        typeof article.section !== "string"
      ) {
        continue;
      }
      citations.push({
        articleId: article.article_id,
        title: article.title,
        section: article.section,
        link: safeInternalLink(article.link),
      });
    }
  }

  return {
    notices,
    link,
    linkKind: link
      ? toolName === "run_clinic_report"
        ? "report"
        : "navigation"
      : null,
    linkLabel,
    citations,
  };
}

/**
 * Only same-origin, absolute-path links are rendered.
 *
 * Report links, resolved navigation targets, and nested help-result links all
 * pass through this boundary. Their current producers use fixed registered
 * routes, but tool output crosses the model loop before it is rendered, so the
 * UI must not rely on every present and future producer staying well-behaved.
 *
 * A leading "/" alone is not enough: `//evil.example` is protocol-relative and
 * a browser resolves it as an absolute off-site URL.
 */
function safeInternalLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  // Backslashes are normalized to "/" by some browsers, so "/\evil.example"
  // is another way to write a protocol-relative URL.
  if (value.startsWith("/\\")) return null;
  return value;
}
