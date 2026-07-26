"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  isToolUIPart,
} from "ai";
import {
  ArrowUpRight,
  Bot,
  CircleStop,
  FileSearch,
  HelpCircle,
  ListChecks,
  LoaderCircle,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  UserRound,
  Wallet,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { StaffAssistantUIMessage } from "@/lib/ai/staff-agent";
import type { AssistantCapabilities } from "@/lib/ai/capabilities";
import type { AssistantErrorCode } from "@/lib/ai/errors";
import {
  presentationFor,
  summarizeToolResult,
  type AssistantResultNotice,
} from "@/lib/ai/tool-presentation";
import type { PermissionUserRole } from "@/lib/page-permissions";
import { CapabilityPanel } from "@/components/assistant/capability-panel";
import type { AssistantPageContext } from "@/lib/ai/page-context";
import type {
  ActiveContext,
  ActiveContextEntityType,
} from "@/lib/ai/conversation-context";
import {
  chooseAssistantConversationContext,
  clearAssistantConversationContext,
} from "@/actions/assistant-context";

type AssistantChatProps = {
  initialConversationId: string;
  initialMessages: StaffAssistantUIMessage[];
  initialActiveContext?: ActiveContext;
  pageContext?: AssistantPageContext | null;
  contextLabel?: string | null;
  remaining: number;
  historyTruncated?: boolean;
  mode?: "page" | "sheet";
  role: PermissionUserRole;
  /**
   * Server-resolved tool mount (P4.6B). Display only: it decides which
   * suggestions and notices are offered, never what the assistant may do. Null
   * on surfaces that do not resolve it (the doctor patient sheet), which falls
   * back to the role-based suggestions.
   */
  capabilities?: AssistantCapabilities | null;
};

type SessionState = {
  id: string;
  messages: StaffAssistantUIMessage[];
  historyTruncated: boolean;
  activeContext: ActiveContext;
};

type PatientChatContext = { id: string; name: string } | null;

type StaffAssistantPart = StaffAssistantUIMessage["parts"][number];
type StaffAssistantToolPart = Extract<
  StaffAssistantPart,
  { type: `tool-${string}` } | { type: "dynamic-tool" }
>;

type ContextChoice = {
  entityType: ActiveContextEntityType;
  entityId: string;
  label: string;
};

const CONTEXT_TYPE_ORDER: readonly ActiveContextEntityType[] = [
  "patient",
  "appointment",
  "invoice",
  "staff",
  "department",
  "report",
];
const EMPTY_ACTIVE_CONTEXT: ActiveContext = {};

const CONTEXT_TYPE_COPY_KEYS: Record<ActiveContextEntityType, string> = {
  patient: "activeContextPatient",
  appointment: "activeContextAppointment",
  invoice: "activeContextInvoice",
  staff: "activeContextStaff",
  department: "activeContextDepartment",
  report: "activeContextReport",
};

/**
 * Extracts only explicit clarification candidates from structured tool output.
 * A click still supplies no trusted label/id: the server action re-reads the
 * candidate through the authenticated RLS client and derives the canonical
 * UI-only label before persisting it.
 */
export function contextChoicesForToolResult(
  output: unknown,
  toolName: string,
): ContextChoice[] {
  if (!output || typeof output !== "object") return [];
  const value = output as Record<string, unknown>;
  const patientCandidates = Array.isArray(value.patients)
    ? value.patients
    : null;

  if (
    toolName === "search_authorized_patients" &&
    value.confidence !== "high" &&
    patientCandidates
  ) {
    return patientCandidates.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const row = candidate as Record<string, unknown>;
      if (typeof row.id !== "string" || typeof row.full_name !== "string") return [];
      const detail = [row.file_number, row.phone]
        .filter((item): item is string => typeof item === "string" && item.length > 0)
        .join(" · ");
      return [{
        entityType: "patient" as const,
        entityId: row.id,
        label: detail ? `${row.full_name} · ${detail}` : row.full_name,
      }];
    });
  }

  if (value.needs_clarification !== true || !Array.isArray(value.candidates)) {
    return [];
  }
  const entityType =
    value.field === "doctor"
      ? "staff"
      : value.field === "department"
        ? "department"
        : value.field === "report"
          ? "report"
          : null;
  if (!entityType) return [];

  return value.candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const row = candidate as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.name !== "string") return [];
    return [{ entityType, entityId: row.id, label: row.name }];
  });
}

function createConversationId() {
  return crypto.randomUUID();
}

export function buildAssistantChatRequestBody(input: {
  id: string;
  pageContext: AssistantPageContext | null;
  message: StaffAssistantUIMessage | undefined;
}) {
  return {
    id: input.id,
    context: input.pageContext,
    message: input.message,
  };
}

/**
 * Maps a server error code to its localized copy.
 *
 * The codes are the route's own `ErrorCode` union, and they arrive over three
 * transports, not two — the correction review #2's H2 made. A pre-stream denial
 * comes back as a JSON body; a stream-level failure comes back as an `error`
 * chunk that sets `useChat`'s `error`; and a tool that throws mid-turn comes
 * back as a `tool-output-error` **part**, which never touches `useChat`'s
 * `error` and is classified by `ToolActivity` instead. All three are keyed off
 * this one table so the three cannot describe the same denial differently.
 *
 * Typing the table by that union rather than comparing loose strings in a
 * ternary chain is the point: a renamed or newly added reason is a compile
 * error here instead of a silent fall-through to "something went wrong", which
 * is exactly how `permission_not_granted` became unreachable in the first
 * place.
 */
const ERROR_COPY_KEYS: Record<AssistantErrorCode, string> = {
  usage_limit_reached: "errorCapReached",
  feature_not_entitled: "errorUpgrade",
  // Deliberately distinct from feature_not_entitled so the UI can say "ask your
  // admin" rather than "upgrade your plan" — different problem, different
  // person to go to.
  permission_not_granted: "errorPermissionNotGranted",
  rate_limited: "errorRateLimited",
  subscription_inactive: "errorSubscriptionInactive",
  // These four used to share `errorGeneric` ("try again"), which was harmless
  // while they could only arrive before the stream — the pre-stream cases are
  // mostly wiring bugs a user cannot act on. They now also arrive as *tool*
  // denials mid-turn (review #2, M3), where each is a distinct, actionable
  // state and "try again" is actively wrong for three of them.
  unauthenticated: "errorUnauthenticated",
  role_forbidden: "errorRoleForbidden",
  page_hidden: "errorPageHidden",
  lookup_failed: "errorLookupFailed",
  invalid_request: "errorGeneric",
  temporarily_unavailable: "errorGeneric",
};

function errorCopyKey(message: string): string {
  return ERROR_COPY_KEYS[message as AssistantErrorCode] ?? "errorGeneric";
}

/**
 * Whether a tool part's `errorText` is one of our codes rather than free text.
 *
 * The route's `onError` returns only `AssistantErrorCode` values, but this runs
 * on stream input and an SDK-internal error (an aborted fetch, a malformed
 * chunk) can produce arbitrary text. Rendering an unrecognized string would put
 * an untranslated internal message in front of the user, so anything unknown
 * falls back to the generic sentence.
 */
function isAssistantErrorCode(value: unknown): value is AssistantErrorCode {
  return typeof value === "string" && value in ERROR_COPY_KEYS;
}

function noticeText(
  notice: AssistantResultNotice,
  t: ReturnType<typeof useTranslations<"assistant">>,
): string {
  switch (notice.kind) {
    case "range_clamped":
      return t("noticeRangeClamped", { from: notice.from, to: notice.to });
    case "truncated":
      return t("noticeTruncated", { count: notice.rowCap });
    case "suppressed":
      // One fact, stated exactly: N groups were combined into "Other", covering
      // M patients. No claim is made about any individual group, because the
      // payload no longer contains one — which is what review #3's H1 fix
      // replaced the old two-sentence below-floor/complementary split with.
      return t("noticeSuppressed", {
        count: notice.groupedBuckets,
        patients: notice.groupedPatients,
        floor: notice.floor,
      });
    case "distribution_withheld":
      return t("noticeDistributionWithheld");
    case "all_time_scope":
      return t("noticeAllTimeScope");
    case "needs_clarification":
      return t("noticeNeedsClarification");
    case "permission_denied":
      // Same table the two error transports use, so a denial reads identically
      // whether it arrived before the stream, as a stream error, or as a
      // structured tool result.
      return t(errorCopyKey(notice.reason));
    case "text_truncated":
      return t("noticeTextTruncated", { count: notice.fields });
  }
}

/**
 * One tool call, rendered with its group and the caveats its result carries.
 *
 * Financial results are visually distinct from operational ones on purpose:
 * they are the group behind the entitlement plus the per-user grant, and a
 * revenue figure should not read like an appointment count.
 *
 * The notices are rendered from the structured result rather than trusting the
 * model to have relayed them. `truncated`, `clamped`, and the suppression
 * fields exist so an answer stays honest about what it did *not* see; a model
 * that summarizes loosely would silently drop exactly those caveats.
 */
function ToolActivity({
  part,
  onChooseContext,
  contextMutationBusy,
}: {
  part: StaffAssistantToolPart;
  onChooseContext: (choice: ContextChoice) => void;
  contextMutationBusy: boolean;
}) {
  const t = useTranslations("assistant");
  const complete = part.state === "output-available";
  const failed = part.state === "output-error";
  const name = part.type === "dynamic-tool" ? part.toolName : part.type.slice(5);
  const { labelKey, group } = presentationFor(name);
  const isFinancial = group === "financial";
  const { notices, link, linkKind, linkLabel, citations } = complete
    ? summarizeToolResult((part as { output?: unknown }).output, name)
    : {
        notices: [],
        link: null,
        linkKind: null,
        linkLabel: null,
        citations: [],
      };

  // H2 (review #2). A tool that throws mid-stream arrives here and *only* here:
  // the SDK converts it to a `tool-output-error` part, so `useChat`'s `error`
  // stays undefined and the page-level error banner never renders. This branch
  // used to show a bare "could not complete" chip and discard `errorText`
  // entirely — including the reason code the route had gone to the trouble of
  // emitting — so a revoked grant, a hidden page, or a lapsed subscription all
  // looked like the same anonymous glitch.
  const errorText = failed ? (part as { errorText?: unknown }).errorText : undefined;
  const failureCopy = failed
    ? t(isAssistantErrorCode(errorText) ? errorCopyKey(errorText) : "errorGeneric")
    : null;
  const contextChoices = complete
    ? contextChoicesForToolResult(
        (part as { output?: unknown }).output,
        name,
      )
    : [];

  return (
    <div
      className={cn(
        "my-2 rounded-xl border px-3 py-2 text-xs",
        isFinancial
          ? "border-amber-500/30 bg-amber-500/8 text-amber-900 dark:text-amber-200"
          : "border-border/60 bg-muted/35 text-muted-foreground",
      )}
    >
      <div className="flex items-center gap-2">
        {complete ? (
          isFinancial ? (
            <Wallet className="size-3.5" aria-hidden="true" />
          ) : (
            <ShieldCheck
              className="size-3.5 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
          )
        ) : failed ? (
          <FileSearch className="size-3.5 text-destructive" aria-hidden="true" />
        ) : (
          <LoaderCircle className="size-3.5 animate-spin text-primary" aria-hidden="true" />
        )}
        <span className={cn("font-medium", !isFinancial && "text-foreground/80")}>
          {t(labelKey)}
        </span>
        {isFinancial ? (
          <span className="rounded-full border border-amber-500/30 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
            {t("groupFinancial")}
          </span>
        ) : null}
        <span className="ms-auto">
          {complete ? t("toolComplete") : failed ? t("toolFailed") : t("toolWorking")}
        </span>
      </div>

      {failureCopy ? (
        <p className="mt-2 flex items-start gap-1.5 border-t border-current/15 pt-2">
          <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span>{failureCopy}</span>
        </p>
      ) : null}

      {notices.length > 0 ? (
        <ul className="mt-2 space-y-1 border-t border-current/15 pt-2">
          {notices.map((notice) => (
            <li key={notice.kind} className="flex items-start gap-1.5">
              {notice.kind === "needs_clarification" ? (
                <HelpCircle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              ) : (
                <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              )}
              <span>{noticeText(notice, t)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {contextChoices.length > 0 ? (
        <div className="mt-2 border-t border-current/15 pt-2">
          <p className="font-medium text-foreground/80">
            {t("chooseActiveContext")}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {contextChoices.map((choice) => (
              <button
                key={`${choice.entityType}:${choice.entityId}`}
                type="button"
                disabled={contextMutationBusy}
                onClick={() => onChooseContext(choice)}
                className="min-h-9 rounded-full border border-border/80 bg-background px-3 py-1 text-start font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
              >
                {choice.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {citations.length > 0 ? (
        <div className="mt-2 border-t border-current/15 pt-2">
          <p className="font-medium text-foreground/80">{t("helpSources")}</p>
          <ul className="mt-1.5 space-y-1.5">
            {citations.map((citation) => (
              <li key={citation.articleId}>
                <span>{t("helpArticleCitation", { title: citation.title })}</span>
                {citation.link ? (
                  <Link
                    href={citation.link}
                    className="ms-2 inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {t("openDestination", { destination: citation.section })}
                    <ArrowUpRight
                      className="size-3 rtl:-scale-x-100"
                      aria-hidden="true"
                    />
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {link ? (
        <Link
          href={link}
          className="mt-2 inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {linkKind === "report"
            ? t("openFullReport")
            : t("openDestination", {
                destination: linkLabel ?? t("destinationFallback"),
              })}
          <ArrowUpRight className="size-3 rtl:-scale-x-100" aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}

function MessageBubble({
  message,
  onChooseContext,
  contextMutationBusy,
}: {
  message: StaffAssistantUIMessage;
  onChooseContext: (choice: ContextChoice) => void;
  contextMutationBusy: boolean;
}) {
  const t = useTranslations("assistant");
  const isUser = message.role === "user";
  return (
    <article
      className={cn("flex gap-3", isUser ? "justify-end" : "justify-start")}
      aria-label={isUser ? t("yourMessage") : t("assistantMessage")}
    >
      {!isUser ? (
        <div className="mt-1 grid size-8 shrink-0 place-items-center rounded-xl border border-primary/15 bg-primary/8 text-primary">
          <Bot className="size-4" aria-hidden="true" />
        </div>
      ) : null}
      <div
        className={cn(
          "max-w-[86%] rounded-2xl px-4 py-3 text-sm leading-6 shadow-xs",
          isUser
            ? "rounded-ee-md bg-primary text-primary-foreground"
            : "rounded-es-md border border-border/70 bg-card text-card-foreground",
        )}
      >
        {message.parts.map((part, index) => {
          if (part.type === "text") {
            return (
              <p key={`${message.id}-text-${index}`} className="whitespace-pre-wrap break-words">
                {part.text}
              </p>
            );
          }
          if (isToolUIPart(part)) {
            return (
              <ToolActivity
                key={part.toolCallId}
                part={part}
                onChooseContext={onChooseContext}
                contextMutationBusy={contextMutationBusy}
              />
            );
          }
          return null;
        })}
      </div>
      {isUser ? (
        <div className="mt-1 grid size-8 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
          <UserRound className="size-4" aria-hidden="true" />
        </div>
      ) : null}
    </article>
  );
}

/**
 * Suggestion chips, built from the server-resolved mount rather than from role
 * alone (P4.6B). A chip that opens a capability the user does not have is worse
 * than no chip: it produces a denial the user cannot act on. Because the source
 * is `resolveToolMount` — the same resolution the model gets — a chip can only
 * appear when the tool behind it is genuinely mounted.
 */
function suggestionsFor({
  t,
  patient,
  pageContext,
  role,
  capabilities,
}: {
  t: ReturnType<typeof useTranslations<"assistant">>;
  patient: PatientChatContext;
  pageContext: AssistantPageContext | null;
  role: PermissionUserRole;
  capabilities: AssistantCapabilities | null;
}): string[] {
  if (patient) {
    return [t("suggestSummary"), t("suggestRecentVisits"), t("suggestFollowups")];
  }

  // This host edits recurring hours but intentionally carries no doctor id or
  // appointment range. Keep its chips limited to safe product help.
  if (pageContext?.type === "doctor-schedule") {
    return capabilities?.toolNames.includes("search_help")
      ? [t("suggestScheduleHelp")]
      : [];
  }

  const mounted = new Set(capabilities?.toolNames ?? []);
  const contextual: string[] = [];
  if (pageContext && capabilities) {
    switch (pageContext.type) {
      case "patient":
      case "dashboard":
        break;
      case "appointments":
        if (mounted.has("list_appointments") || mounted.has("list_doctor_appointments")) {
          contextual.push(t("suggestVisibleAppointments", pageContext.dateRange));
        }
        if (mounted.has("get_appointment_stats")) {
          contextual.push(t("suggestVisibleAppointmentStats", pageContext.dateRange));
        }
        if (mounted.has("check_availability")) {
          contextual.push(t("suggestVisibleAvailability", pageContext.dateRange));
        }
        break;
      case "revenue":
        if (mounted.has("get_revenue_summary")) {
          contextual.push(t("suggestVisibleRevenue", pageContext.dateRange));
        }
        if (mounted.has("compare_revenue_periods")) {
          contextual.push(t("suggestCompareVisibleRevenue"));
        }
        if (mounted.has("list_outstanding_invoices")) {
          contextual.push(t("suggestVisibleOutstanding"));
        }
        break;
      case "reports":
        if (
          mounted.has("run_clinic_report") &&
          capabilities.allowedReportIds.includes(pageContext.report)
        ) {
          contextual.push(
            t("suggestCurrentReport", pageContext.range),
            t("suggestExplainCurrentReport"),
          );
        }
        break;
      case "invoices":
        if (mounted.has("list_outstanding_invoices")) {
          contextual.push(t("suggestInvoiceOutstanding"));
        }
        if (mounted.has("search_help")) {
          contextual.push(t("suggestInvoiceHelp"));
        }
        break;
      case "staff":
        if (mounted.has("get_clinic_summary")) {
          contextual.push(t("suggestStaffOverview"));
        }
        if (mounted.has("search_help")) {
          contextual.push(t("suggestStaffHelp"));
        }
        break;
      case "departments":
        if (mounted.has("get_clinic_summary")) {
          contextual.push(t("suggestDepartmentOverview"));
        }
        if (mounted.has("search_help")) {
          contextual.push(t("suggestDepartmentHelp"));
        }
        break;
    }
  }

  let general: string[];
  if (role === "doctor") {
    general = [t("suggestPatientLookup"), t("suggestSchedule"), t("suggestAvailability")];
  } else if (!capabilities) {
    general = [
      t("suggestPatientLookup"),
      t("suggestAvailabilityStaff"),
      t("suggestHowToUseStaff"),
    ];
  } else {
    general = [];
    if (mounted.has("get_clinic_summary")) general.push(t("suggestClinicSummary"));
    if (mounted.has("list_appointments")) general.push(t("suggestTodaysAppointments"));
    if (mounted.has("count_new_patients")) general.push(t("suggestNewPatients"));
    if (mounted.has("get_appointment_stats")) general.push(t("suggestNoShowRate"));
    if (mounted.has("list_pending_followups")) general.push(t("suggestPendingFollowups"));
    if (capabilities.financial === "available") {
      general.push(t("suggestRevenue"), t("suggestOutstanding"));
    }
    if (mounted.has("run_clinic_report")) general.push(t("suggestRunReport"));
    general.push(t("suggestPatientLookup"), t("suggestAvailabilityStaff"));
  }

  return [...new Set([...contextual, ...general])].slice(0, 6);
}

/**
 * The two reasons a manager has no financial tools, told apart.
 *
 * "Your plan does not include this" and "your admin has not enabled this for
 * you" need different actions from different people, so collapsing them into
 * one message reliably sends the user to the wrong place. Receptionists and
 * doctors see nothing at all — the financial group does not exist for them, and
 * advertising a capability they can never be granted would be a worse lie than
 * silence.
 */
function FinancialNotice({
  state,
}: {
  state: AssistantCapabilities["financial"];
}) {
  const t = useTranslations("assistant");
  if (state === "available" || state === "not_applicable") return null;

  return (
    <p className="flex items-start gap-2 rounded-xl border border-border/70 bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground">
      <Wallet className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>
        {state === "not_entitled"
          ? t("financialNotEntitled")
          : state === "unavailable"
            ? t("financialUnavailable")
            : t("financialNotGranted")}
      </span>
    </p>
  );
}

function ChatSession({
  session,
  patient,
  pageContext,
  remaining,
  mode,
  role,
  capabilities,
  onNewConversation,
}: {
  session: SessionState;
  patient: PatientChatContext;
  pageContext: AssistantPageContext | null;
  remaining: number;
  mode: NonNullable<AssistantChatProps["mode"]>;
  role: PermissionUserRole;
  capabilities: AssistantCapabilities | null;
  onNewConversation: () => void;
}) {
  const t = useTranslations("assistant");
  const router = useRouter();
  const [input, setInput] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [activeContext, setActiveContext] = useState<ActiveContext>(
    session.activeContext,
  );
  const [contextMutationBusy, setContextMutationBusy] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const capabilityPanelId = useId();
  const capabilityToggleRef = useRef<HTMLButtonElement>(null);
  const restoreCapabilityFocusRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  // The panel is offered only where there is a server-resolved capability set to
  // show — the assistant page, not the doctor patient sheet (capabilities null).
  const showCapabilityToggle = (capabilities?.items.length ?? 0) > 0;
  const transport = useMemo(
    () =>
      new DefaultChatTransport<StaffAssistantUIMessage>({
        api: "/api/agent/chat",
        credentials: "same-origin",
        prepareSendMessagesRequest({ id, messages }) {
          return {
            body: buildAssistantChatRequestBody({
              id,
              pageContext,
              message: messages.at(-1),
            }),
          };
        },
        async fetch(input, init) {
          const response = await globalThis.fetch(input, init);
          if (!response.ok) {
            const payload = (await response.clone().json().catch(() => null)) as
              | { error?: string }
              | null;
            throw new Error(payload?.error ?? "temporarily_unavailable");
          }
          return response;
        },
      }),
    [pageContext],
  );
  const {
    messages,
    sendMessage,
    status,
    error,
    stop,
    clearError,
  } = useChat<StaffAssistantUIMessage>({
    id: session.id,
    messages: session.messages,
    transport,
    experimental_throttle: 40,
    onFinish({ isAbort, isError }) {
      if (!isAbort && !isError) {
        setAnnouncement(t("responseReady"));
        router.refresh();
      } else {
        setAnnouncement("");
      }
    },
  });
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    endRef.current?.scrollIntoView({
      block: "end",
      behavior: status === "streaming" ? "auto" : "smooth",
    });
  }, [messages, status]);

  useEffect(() => {
    if (!capabilitiesOpen && restoreCapabilityFocusRef.current) {
      restoreCapabilityFocusRef.current = false;
      capabilityToggleRef.current?.focus();
    }
  }, [capabilitiesOpen]);

  const errorCopy = error ? t(errorCopyKey(error.message)) : null;

  function submitMessage() {
    const text = input.trim();
    if (!text || busy) return;
    clearError();
    setInput("");
    void sendMessage({ text });
  }

  async function chooseContext(choice: ContextChoice) {
    if (busy || contextMutationBusy) return;
    setContextMutationBusy(true);
    try {
      const result = await chooseAssistantConversationContext({
        conversationId: session.id,
        entityType: choice.entityType,
        entityId: choice.entityId,
      });
      if (result.success) {
        setActiveContext(result.activeContext);
        setAnnouncement(t("activeContextUpdated"));
        router.refresh();
      } else {
        setAnnouncement(t("activeContextUpdateFailed"));
      }
    } catch {
      setAnnouncement(t("activeContextUpdateFailed"));
    } finally {
      setContextMutationBusy(false);
    }
  }

  async function clearContext(entityType: ActiveContextEntityType) {
    if (busy || contextMutationBusy) return;
    setContextMutationBusy(true);
    try {
      const result = await clearAssistantConversationContext({
        conversationId: session.id,
        entityType,
      });
      if (result.success) {
        setActiveContext(result.activeContext);
        setAnnouncement(t("activeContextCleared"));
        router.refresh();
      } else {
        setAnnouncement(t("activeContextUpdateFailed"));
      }
    } catch {
      setAnnouncement(t("activeContextUpdateFailed"));
    } finally {
      setContextMutationBusy(false);
    }
  }

  const suggestions = suggestionsFor({
    t,
    patient,
    pageContext,
    role,
    capabilities,
  });
  const currentReportUnavailable =
    pageContext?.type === "reports" &&
    capabilities !== null &&
    !capabilities.allowedReportIds.includes(pageContext.report);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {busy ? t("thinking") : announcement}
      </span>
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3 sm:px-5">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/8 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          {t("readOnly")}
        </span>
        {patient ? (
          <span className="truncate rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
            {t("patientContext", { patient: patient.name })}
          </span>
        ) : null}
        {CONTEXT_TYPE_ORDER.flatMap((entityType) => {
          const slot = activeContext[entityType];
          if (!slot) return [];
          return [
            <span
              key={entityType}
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-primary/20 bg-primary/7 ps-2.5 pe-1 py-1 text-xs font-medium text-primary"
            >
              <span className="truncate">
                {t(CONTEXT_TYPE_COPY_KEYS[entityType])}: {slot.display_label}
              </span>
              <button
                type="button"
                disabled={busy || contextMutationBusy}
                onClick={() => void clearContext(entityType)}
                className="grid size-7 shrink-0 place-items-center rounded-full text-primary/75 transition-colors hover:bg-primary/10 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:opacity-50"
                aria-label={t("clearActiveContext", {
                  context: t(CONTEXT_TYPE_COPY_KEYS[entityType]),
                })}
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </span>,
          ];
        })}
        <span className="ms-auto text-xs tabular-nums text-muted-foreground">
          {t("remaining", { count: remaining })}
        </span>
        {showCapabilityToggle ? (
          <Button
            ref={capabilityToggleRef}
            type="button"
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => setCapabilitiesOpen((open) => !open)}
            aria-expanded={capabilitiesOpen}
            aria-controls={capabilityPanelId}
          >
            <ListChecks className="size-3.5" aria-hidden="true" />
            {t("capabilitiesButton")}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={onNewConversation} disabled={busy}>
          <Plus className="size-3.5" aria-hidden="true" />
          {t("newChat")}
        </Button>
      </div>

      {showCapabilityToggle && capabilitiesOpen ? (
        <div id={capabilityPanelId}>
          <CapabilityPanel
            items={capabilities!.items}
            titleId={`${capabilityPanelId}-title`}
            onClose={() => {
              restoreCapabilityFocusRef.current = true;
              setCapabilitiesOpen(false);
            }}
          />
        </div>
      ) : null}

      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6",
          mode === "page" ? "h-[min(62vh,44rem)]" : "h-full",
        )}
      >
        {messages.length === 0 ? (
          <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center py-8 text-center">
            <div className="relative mb-6 grid size-16 place-items-center rounded-3xl border border-primary/15 bg-primary/8 text-primary">
              <Sparkles className="size-7" aria-hidden="true" />
              <span className="absolute -end-1 -top-1 size-3 rounded-full border-2 border-background bg-emerald-500" />
            </div>
            <h2 className="font-heading text-xl font-semibold tracking-tight">
              {patient
                ? t("patientEmptyTitle", { patient: patient.name })
                : role === "doctor"
                  ? t("emptyTitle")
                  : t("administrativeEmptyTitle")}
            </h2>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              {patient
                ? t("patientEmptyDescription")
                : role === "doctor"
                  ? t("emptyDescription")
                  : t("administrativeEmptyDescription")}
            </p>
            {currentReportUnavailable ? (
              <p className="mt-4 w-full rounded-xl border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-start text-xs leading-5 text-amber-800 dark:text-amber-200">
                {t("currentReportUnavailable")}
              </p>
            ) : null}
            <div className="mt-6 grid w-full gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setInput(suggestion)}
                  className="min-h-11 rounded-xl border border-border/70 bg-card px-3 py-2 text-start text-xs font-medium leading-5 text-foreground/80 transition-colors hover:border-primary/30 hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {suggestion}
                </button>
              ))}
            </div>
            {capabilities && !patient ? (
              <div className="mt-4 w-full text-start">
                <FinancialNotice state={capabilities.financial} />
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-5">
            {session.historyTruncated ? (
              <p className="rounded-xl border border-border/70 bg-muted/40 px-3 py-2 text-center text-xs text-muted-foreground">
                {t("historyTrimmed")}
              </p>
            ) : null}
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                onChooseContext={(choice) => void chooseContext(choice)}
                contextMutationBusy={contextMutationBusy || busy}
              />
            ))}
            {status === "submitted" ? (
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <div className="grid size-8 place-items-center rounded-xl border border-primary/15 bg-primary/8 text-primary">
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                </div>
                {t("thinking")}
              </div>
            ) : null}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <div className="border-t border-border/60 bg-background/95 p-3 sm:p-4">
        {errorCopy ? (
          <p role="alert" className="mb-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {errorCopy}
          </p>
        ) : null}
        <div className="mx-auto max-w-3xl">
          <div className="flex items-end gap-2 rounded-2xl border border-input bg-card p-2 shadow-sm focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20">
            <Textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submitMessage();
                }
              }}
              aria-label={role === "doctor" ? t("messageLabel") : t("administrativeMessageLabel")}
              placeholder={patient
                ? t("patientPlaceholder")
                : role === "doctor"
                  ? t("placeholder")
                  : t("administrativePlaceholder")}
              maxLength={4_000}
              rows={1}
              className="max-h-36 min-h-11 resize-none border-0 bg-transparent px-2 py-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
              disabled={busy}
            />
            {busy ? (
              <Button type="button" size="icon" variant="outline" onClick={stop} aria-label={t("stop") }>
                <CircleStop className="size-4" aria-hidden="true" />
              </Button>
            ) : (
              <Button type="button" size="icon" onClick={submitMessage} disabled={!input.trim()} aria-label={t("send") }>
                <Send className="size-4 rtl:-scale-x-100" aria-hidden="true" />
              </Button>
            )}
          </div>
          <p className="mt-2 px-1 text-center text-[11px] leading-4 text-muted-foreground">
            {role === "doctor" ? t("clinicalDisclaimer") : t("administrativeDisclaimer")}
          </p>
        </div>
      </div>
    </div>
  );
}

export function AssistantChat({
  initialConversationId,
  initialMessages,
  initialActiveContext = EMPTY_ACTIVE_CONTEXT,
  pageContext = null,
  contextLabel = null,
  remaining,
  historyTruncated = false,
  mode = "page",
  role,
  capabilities = null,
}: AssistantChatProps) {
  const patient = pageContext?.type === "patient"
    ? { id: pageContext.patientId, name: contextLabel ?? "" }
    : null;
  const [session, setSession] = useState<SessionState>({
    id: initialConversationId,
    messages: initialMessages,
    historyTruncated,
    activeContext: initialActiveContext,
  });
  const renderedSession =
    session.id === initialConversationId
      ? { ...session, activeContext: initialActiveContext }
      : session;
  // Server refreshes after a completed turn can add/switch context. Keying the
  // session by the validated slot metadata resets only the chat shell's local
  // context state when that server snapshot changes, without an effect-driven
  // state mirror or any client trust in the labels.
  const activeContextVersion = CONTEXT_TYPE_ORDER.map((entityType) => {
    const slot = renderedSession.activeContext[entityType];
    return slot ? `${entityType}:${slot.entity_id}:${slot.set_at}` : "";
  }).join("|");

  return (
    <ChatSession
      key={`${renderedSession.id}:${activeContextVersion}`}
      session={renderedSession}
      patient={patient}
      pageContext={pageContext}
      remaining={remaining}
      mode={mode}
      role={role}
      capabilities={capabilities}
      onNewConversation={() => setSession({
        id: createConversationId(),
        messages: [],
        historyTruncated: false,
        activeContext: {},
      })}
    />
  );
}
