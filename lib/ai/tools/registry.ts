import "server-only";

import type { Tool } from "ai";
import type { UserRole } from "@/lib/rbac";
import type { AiTaskClass } from "@/lib/ai/platform/types";
import type { AiUserPermissionKey } from "@/lib/ai/permissions";
import type { AiCommercialFeature } from "@/lib/ai/commercial-policy";
import type { DoctorToolContext } from "@/lib/ai/tools/context";
import { queryResourceTool } from "@/lib/ai/tools/query-resource";
import { getRecordTool } from "@/lib/ai/tools/get-record";
import { aggregateResourceTool } from "@/lib/ai/tools/aggregate-resource";
import { describeCapabilitiesTool } from "@/lib/ai/tools/describe-capabilities";
import { executeActionTool } from "@/lib/ai/tools/execute-action";
import { describeActionTool } from "@/lib/ai/tools/describe-action";

// Phase 6 document capability (read half; issuing is an action).
import { describeDocumentsTool } from "@/lib/ai/tools/describe-documents";
import { previewDocumentTool } from "@/lib/ai/tools/preview-document";

// Existing P4 tools, migrated onto the registry with behavior unchanged.
import { searchAuthorizedPatientsTool } from "@/lib/ai/tools/search-authorized-patients";
import { checkAvailabilityTool } from "@/lib/ai/tools/check-availability";

// P4.6A analytics, operational, financial, and reporting tools.
import { getClinicSummaryTool } from "@/lib/ai/tools/get-clinic-summary";
import { getPatientStatsTool } from "@/lib/ai/tools/get-patient-stats";
import { getAppointmentStatsTool } from "@/lib/ai/tools/get-appointment-stats";
import { countNewPatientsTool } from "@/lib/ai/tools/count-new-patients";
import { listPendingFollowupsTool } from "@/lib/ai/tools/list-pending-followups";
import { getRevenueSummaryTool } from "@/lib/ai/tools/get-revenue-summary";
import { compareRevenuePeriodsTool } from "@/lib/ai/tools/compare-revenue-periods";
import { listOutstandingInvoicesTool } from "@/lib/ai/tools/list-outstanding-invoices";
import { runClinicReportTool } from "@/lib/ai/tools/run-clinic-report";

// P4.7A system-knowledge tools.
import { searchHelpTool } from "@/lib/ai/tools/search-help";
import { getNavigationTargetTool } from "@/lib/ai/tools/get-navigation-target";

// P4.7B capability transparency.
import { listMyCapabilitiesTool } from "@/lib/ai/tools/list-my-capabilities";

import {
  AI_FINANCIAL_INSIGHTS_FEATURE,
  AI_STAFF_ANALYTICS_FEATURE,
  AI_ASSISTANT_FEATURE,
} from "@/lib/ai/authorization";
import { AI_DOCUMENTS_FEATURE } from "@/lib/ai/documents/capability";
import { AI_ACTION_REGISTRY } from "@/lib/ai/actions/registry";

/**
 * The declarative AI tool registry (P4.6A keystone refactor).
 *
 * One definition per tool, in one place, mirroring the proven
 * `lib/operator-reports/registry.ts` pattern. `buildStaffTools` is now a generic
 * deny-by-default filter over this list rather than hand-assembled per-role
 * objects, so adding a tool is one module plus one entry plus its authorization
 * test — and it is structurally impossible to add a tool without declaring who
 * may use it.
 *
 * The same metadata is the single source of truth for the P4.7 capability
 * panel, which is why `capabilityDescription` lives here: the panel's
 * cross-task authorized union and every narrower active-turn mount are derived
 * from this resolution and cannot acquire an independently maintained tool.
 *
 * Registration is necessary but never sufficient. Every tool independently
 * re-asserts role, subscription, entitlement, page visibility, and (for
 * financial tools) the per-user permission inside `execute`, so a wiring
 * mistake here cannot become a data leak.
 */
export type AiToolDefinition = {
  name: string;
  build: (ctx: DoctorToolContext) => Tool;
  /** Deny-by-default: a role absent from this list never sees the tool. */
  roles: readonly UserRole[];
  /** Every listed plan feature must resolve true. */
  requiredFeatures: readonly AiCommercialFeature[];
  /** Additionally requires an admin-granted per-user permission. */
  requiredUserPermission?: AiUserPermissionKey;
  /**
   * Permissions this tool does **not** require to mount, but whose state
   * changes what its description advertises.
   *
   * `run_clinic_report` is the only such tool and the reason this field exists:
   * it mounts for any administrative role because four of its six reports are
   * non-financial, yet its description enumerates the reports the caller may
   * run — so listing `revenue` to a manager without the financial grant put a
   * promise into the model's context that `execute()` would then refuse
   * (P4.6 phase review H1).
   *
   * Declared rather than resolving every key for every caller, so a doctor's
   * mount does not issue a financial-permission read it can never use.
   * Presentation only; never an authorization input.
   */
  describedByUserPermissions?: readonly AiUserPermissionKey[];
  /**
   * Which certified task classes may mount this tool. Enforced by
   * `resolveToolMount`, not decorative — see the task-class gate there.
  */
  taskClasses: readonly AiTaskClass[];
  capabilityDescription: { en: string; ar: string };
};

const ALL_STAFF: readonly UserRole[] = [
  "admin",
  "manager",
  "receptionist",
  "doctor",
  "assistant",
];
const ADMINISTRATIVE: readonly UserRole[] = ["admin", "manager", "receptionist"];
const ANALYTICS: readonly UserRole[] = ["admin", "manager"];
const FINANCIAL: readonly UserRole[] = ["admin", "manager"];

/**
 * Final review B-2 — the roles that may mount the generic action tools.
 *
 * This is **derived**, never listed. `execute_action` and `describe_action` are
 * infrastructure: they carry every registered write, and the authorization that
 * decides whether a particular write may happen lives on the action itself
 * (`roles`, `requiredFeatures`, `requiredUserPermission`, `pageSlug`) and is
 * re-asserted from scratch by `assertActionAccess` at both preview and execute.
 *
 * A hand-maintained role list on the tool was therefore not defense — it was a
 * fourth, silently drifting copy of an authorization fact the action registry
 * already owns. It shipped as `ADMINISTRATIVE` in Phase 3, when no action
 * authorized a doctor or an assistant, and was never widened when Phases 5c and
 * 6 registered 21 doctor-authorized and 22 assistant-authorized actions — so
 * the entire clinical-authoring write surface became unreachable for exactly
 * the two roles that own it, in contradiction with plan §5.
 *
 * Deriving it from `AI_ACTION_REGISTRY` makes that class of drift impossible:
 * a role mounts the action tools iff at least one registered action authorizes
 * that role, and registering the first action for a role mounts it by
 * construction. Mounting grants nothing — a role with one authorized action
 * still gets exactly one, because the per-action gates run underneath.
 */
export const ACTION_CAPABLE_ROLES: readonly UserRole[] = ALL_STAFF.filter(
  (role) => AI_ACTION_REGISTRY.some((action) => action.roles.includes(role)),
);

/** Whether the generic action tools mount at all for this role (metadata only). */
export function roleMountsActionTools(role: UserRole): boolean {
  return ACTION_CAPABLE_ROLES.includes(role);
}

/**
 * **The task-class gate became load-bearing in P4.7A.**
 *
 * The P4.6A note here recorded that `resolveToolMount` really did filter on
 * `taskClasses`, but that nothing was excluded by it in practice: every P4.6
 * tool declared both administrative classes, and `staffTaskForRole` returned one
 * of exactly those two for every non-doctor role, so no reachable turn resolved
 * to a class that excluded a tool. It predicted that P4.7's `staff_help` class
 * would be the first genuinely narrower one.
 *
 * It is. Only the three data-free guidance tools include `staff_help`, so a help
 * turn mounts `search_help`, `get_navigation_target`, and
 * `list_my_capabilities`, and no tool that reads clinic data exists in it at
 * all. That is now a real, testable
 * containment property on real data rather than a synthetic mount, and it is
 * what makes the class safe to route to a cheaper model: the budget is small
 * because the reachable work is small, not merely because help *ought* to be
 * cheap.
 *
 * The converse matters as much: the help tools declare *every* class, so a user
 * whose turn routed to the administrative or clinical class can still ask "where
 * is this?" without a misrouted intent costing them the answer. Help is additive
 * everywhere and exclusive only in its own class.
 */
/**
 * Phase 7 note. `CLINICAL_TASKS` — the clinical-only task list — was removed
 * with its last user. The two tools that declared it (`list_doctor_appointments`
 * and the clinical reads it fronted) are superseded by the resource layer, whose
 * generic tools declare `SHARED_TASKS`; see `lib/ai/tools/superseded.ts`.
 */
const OPERATIONAL_TASKS: readonly AiTaskClass[] = [
  "staff_administrative",
  "staff_operational_query",
];
const SHARED_TASKS: readonly AiTaskClass[] = [
  "staff_clinical_summary",
  "staff_administrative",
  "staff_operational_query",
];
/** Every staff class: help is answerable in any turn, whatever its intent. */
const HELP_TASKS: readonly AiTaskClass[] = [
  "staff_clinical_summary",
  "staff_administrative",
  "staff_operational_query",
  "staff_help",
];
/**
 * `SHARED_TASKS` plus the help class — the mount backstop for the action-routing
 * regression (review §7.2a).
 *
 * `describe_action` is permission-filtered *metadata*: it enumerates registered
 * actions this exact user is authorized and entitled to preview, and reads no
 * clinic table at all. Adding `staff_help` therefore leaves the containment
 * property intact — a help turn still mounts nothing that touches patient,
 * appointment, or financial data — while making the class recoverable instead of
 * a dead end. A turn that slips past the router's write-intent guard can now at
 * least name the action truthfully and invite the user to restate the request,
 * rather than silently degrading to a page link.
 *
 * `execute_action` deliberately does **not** get this treatment: mounting the
 * write carrier would make `staff_help` no longer the narrow class its cheaper
 * model and 4-step budget are certified against. The router (guard 3 in
 * `lib/ai/platform/execution.ts`) is the fix; this is only the backstop.
 */
const DESCRIBE_ACTION_TASKS: readonly AiTaskClass[] = [
  ...SHARED_TASKS,
  "staff_help",
];

export const AI_TOOL_REGISTRY: readonly AiToolDefinition[] = [
  // ---- Phase 1 generic resource reads ------------------------------------
  // The generic tools are infrastructure; every concrete resource independently
  // re-asserts its own role, feature, optional user permission, and RLS scope.
  {
    name: "query_resource",
    build: queryResourceTool,
    roles: ALL_STAFF,
    // Infrastructure mount: the selected resource re-asserts its own feature
    // (`ai.read_operational` or `ai.read_clinical`) inside execution.
    requiredFeatures: [AI_ASSISTANT_FEATURE],
    taskClasses: SHARED_TASKS,
    capabilityDescription: {
      en: "Query authorized ClinicFlow resources with registered filters, fields, relations, sorting, and truthful pagination.",
      ar: "الاستعلام عن موارد ClinicFlow المصرح بها باستخدام حقول وفلاتر وعلاقات وفرز وصفحات محددة.",
    },
  },
  {
    name: "get_record",
    build: getRecordTool,
    roles: ALL_STAFF,
    requiredFeatures: [AI_ASSISTANT_FEATURE],
    taskClasses: SHARED_TASKS,
    capabilityDescription: {
      en: "Read one authorized record by id without revealing whether an inaccessible id exists.",
      ar: "قراءة سجل واحد مصرح به دون كشف ما إذا كان المعرف غير المتاح موجوداً.",
    },
  },
  {
    name: "aggregate_resource",
    build: aggregateResourceTool,
    roles: ALL_STAFF,
    requiredFeatures: [AI_ASSISTANT_FEATURE],
    taskClasses: SHARED_TASKS,
    capabilityDescription: {
      en: "Count authorized records through the generic resource layer.",
      ar: "حساب السجلات المصرح بها عبر طبقة الموارد العامة.",
    },
  },
  {
    name: "describe_capabilities",
    build: describeCapabilitiesTool,
    roles: ALL_STAFF,
    requiredFeatures: [AI_ASSISTANT_FEATURE],
    taskClasses: HELP_TASKS,
    capabilityDescription: {
      en: "Describe the registered read resources, fields, filters, relations, and limits available to your account.",
      ar: "وصف موارد القراءة والحقول والفلاتر والعلاقات والحدود المتاحة لحسابك.",
    },
  },
  // ---- Phase 3 generic action foundation ---------------------------------
  // The selected action independently asserts its own role, feature, user
  // permission, page visibility, and domain rules.
  {
    name: "execute_action",
    build: executeActionTool,
    roles: ACTION_CAPABLE_ROLES,
    requiredFeatures: [AI_ASSISTANT_FEATURE],
    taskClasses: SHARED_TASKS,
    capabilityDescription: {
      en: "Preview a registered action and execute it only after your on-screen confirmation.",
      ar: "معاينة إجراء مسجل وتنفيذه فقط بعد تأكيدك على الشاشة.",
    },
  },
  {
    name: "describe_action",
    build: describeActionTool,
    roles: ACTION_CAPABLE_ROLES,
    requiredFeatures: [AI_ASSISTANT_FEATURE],
    taskClasses: DESCRIBE_ACTION_TASKS,
    capabilityDescription: {
      en: "Describe the registered actions available to your account.",
      ar: "وصف الإجراءات المسجلة المتاحة لحسابك.",
    },
  },

  // ---- Phase 6 document capability (§10) ----------------------------------
  //
  // Both are reads: §11 classes a document preview as `read`, so neither takes
  // a confirmation. Issuing and reprinting are registered *actions*
  // (`documents.issue`, `documents.reprint`) and go through the preview→confirm
  // pipeline like every other write. Listing already-issued documents is served
  // by the `documents` resource through `query_resource`, whose catalog base
  // filter makes an unauthorized type invisible rather than denied.
  //
  // Mounted for every staff role: the catalog's own `pageRoles` and the report
  // visibility gate decide which types each role actually sees, so a doctor and
  // an admin share one mount and get different, correct answers.
  {
    name: "describe_documents",
    build: describeDocumentsTool,
    roles: ALL_STAFF,
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_DOCUMENTS_FEATURE],
    taskClasses: SHARED_TASKS,
    capabilityDescription: {
      en: "List the documents you may issue and exactly what each one needs.",
      ar: "عرض المستندات التي يمكنك إصدارها والمدخلات التي يحتاجها كل منها.",
    },
  },
  {
    name: "preview_document",
    build: previewDocumentTool,
    roles: ALL_STAFF,
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_DOCUMENTS_FEATURE],
    taskClasses: SHARED_TASKS,
    capabilityDescription: {
      en: "Prepare a document: fill what can be derived, ask only for what is genuinely missing, and show what would be issued.",
      ar: "تجهيز مستند: تعبئة ما يمكن اشتقاقه، وطلب الناقص فعلياً فقط، وعرض ما سيتم إصداره.",
    },
  },

  // ---- P4 tools (unchanged behavior, now declared) ------------------------
  {
    name: "search_authorized_patients",
    build: searchAuthorizedPatientsTool,
    roles: ALL_STAFF,
    requiredFeatures: [AI_ASSISTANT_FEATURE],
    taskClasses: SHARED_TASKS,
    capabilityDescription: {
      en: "Find a patient by name, file number, or phone — including partial, misspelled, Arabic or English spellings.",
      ar: "البحث عن مريض بالاسم أو رقم الملف أو الهاتف — بما في ذلك الكتابة الجزئية أو الخاطئة بالعربية أو الإنجليزية.",
    },
  },
  {
    name: "check_availability",
    build: checkAvailabilityTool,
    roles: ALL_STAFF,
    requiredFeatures: [AI_ASSISTANT_FEATURE],
    taskClasses: SHARED_TASKS,
    capabilityDescription: {
      en: "Check open appointment slots on a given date.",
      ar: "التحقق من المواعيد المتاحة في تاريخ محدد.",
    },
  },

  // ---- P4.6A operational analytics ---------------------------------------
  {
    name: "get_clinic_summary",
    build: getClinicSummaryTool,
    roles: ANALYTICS,
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_STAFF_ANALYTICS_FEATURE],
    taskClasses: OPERATIONAL_TASKS,
    capabilityDescription: {
      en: "Give an operational overview of the clinic: departments, staff, patient and appointment counts, and trends.",
      ar: "تقديم نظرة تشغيلية عامة على العيادة: الأقسام والموظفون وأعداد المرضى والمواعيد والاتجاهات.",
    },
  },
  {
    name: "get_patient_stats",
    build: getPatientStatsTool,
    roles: ANALYTICS,
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_STAFF_ANALYTICS_FEATURE],
    taskClasses: OPERATIONAL_TASKS,
    capabilityDescription: {
      en: "Break patient totals down by department, blood type, or assigned doctor (small groups are hidden).",
      ar: "توزيع أعداد المرضى حسب القسم أو فصيلة الدم أو الطبيب المعالج (تُخفى المجموعات الصغيرة).",
    },
  },
  {
    name: "get_appointment_stats",
    build: getAppointmentStatsTool,
    roles: ANALYTICS,
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_STAFF_ANALYTICS_FEATURE],
    taskClasses: OPERATIONAL_TASKS,
    capabilityDescription: {
      en: "Report appointment totals, no-show and cancellation rates, by status, doctor, or department.",
      ar: "عرض إجماليات المواعيد ونسب عدم الحضور والإلغاء حسب الحالة أو الطبيب أو القسم.",
    },
  },
  {
    name: "count_new_patients",
    build: countNewPatientsTool,
    roles: ADMINISTRATIVE,
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_STAFF_ANALYTICS_FEATURE],
    taskClasses: OPERATIONAL_TASKS,
    capabilityDescription: {
      en: "Count new patient registrations in a period and compare with the previous one.",
      ar: "حساب عدد المرضى الجدد خلال فترة ومقارنتها بالفترة السابقة.",
    },
  },
  {
    name: "list_pending_followups",
    build: listPendingFollowupsTool,
    roles: ["admin", "manager", "receptionist"],
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_STAFF_ANALYTICS_FEATURE],
    taskClasses: OPERATIONAL_TASKS,
    capabilityDescription: {
      en: "Show follow-ups still awaiting a call, or those already recorded with a given outcome.",
      ar: "عرض المتابعات التي تنتظر الاتصال أو المتابعات المسجلة بنتيجة محددة.",
    },
  },
  {
    name: "run_clinic_report",
    build: runClinicReportTool,
    roles: ADMINISTRATIVE,
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_STAFF_ANALYTICS_FEATURE],
    // Mounts without the financial grant (most of its reports are not
    // financial), but its advertised report list depends on it.
    describedByUserPermissions: ["ai.financial_insights"],
    taskClasses: OPERATIONAL_TASKS,
    capabilityDescription: {
      en: "Run a standard clinic report (cancellations, no-shows, follow-ups, performance, revenue) and link to it.",
      ar: "تشغيل أحد تقارير العيادة القياسية (الإلغاءات، عدم الحضور، المتابعات، الأداء، الإيرادات) مع رابط التقرير.",
    },
  },

  // ---- P4.7A help, guidance & navigation ----------------------------------
  //
  // Both ride on `ai.staff_assistant` alone: help is part of the assistant, not
  // a separately sellable unit, so no new entitlement key exists to check. They
  // are the only tools mounted for every staff role without an analytics
  // feature, which is deliberate — a receptionist who cannot see a single
  // aggregate can still be told how to issue an invoice.
  {
    name: "search_help",
    build: searchHelpTool,
    roles: ALL_STAFF,
    requiredFeatures: [AI_ASSISTANT_FEATURE],
    taskClasses: HELP_TASKS,
    capabilityDescription: {
      en: "Explain how to use ClinicFlow — step-by-step instructions for a feature, from the product's official help articles.",
      ar: "شرح كيفية استخدام كلينيك فلو — خطوات تفصيلية لأي ميزة، من مقالات المساعدة الرسمية للمنتج.",
    },
  },
  {
    name: "get_navigation_target",
    build: getNavigationTargetTool,
    roles: ALL_STAFF,
    requiredFeatures: [AI_ASSISTANT_FEATURE],
    taskClasses: HELP_TASKS,
    capabilityDescription: {
      en: "Tell you where a feature lives in ClinicFlow and whether your account can open it.",
      ar: "تحديد مكان أي ميزة داخل كلينيك فلو وما إذا كان حسابك يستطيع فتحها.",
    },
  },

  // ---- P4.7B capability transparency --------------------------------------
  //
  // Rides on `ai.staff_assistant` alone, in every task class (HELP_TASKS), like
  // the help tools: "what can I ask you?" is a fair question in any turn, and the
  // tool reads no clinic data — its answer is this same registry resolved against
  // the caller's entitlements and permissions. It is the model-facing twin of the
  // capability panel. It reports the authorized union across supported task
  // classes; each active turn remains a narrower authorized subset.
  {
    name: "list_my_capabilities",
    build: listMyCapabilitiesTool,
    roles: ALL_STAFF,
    requiredFeatures: [AI_ASSISTANT_FEATURE],
    taskClasses: HELP_TASKS,
    capabilityDescription: {
      en: "List everything your account is authorized to ask across the assistant's supported task types.",
      ar: "عرض كل ما يُصرّح لحسابك بطلبه عبر أنواع المهام التي يدعمها المساعد.",
    },
  },

  // ---- P4.6A financial tools (entitlement + per-user permission) ----------
  {
    name: "get_revenue_summary",
    build: getRevenueSummaryTool,
    roles: FINANCIAL,
    requiredFeatures: [
      AI_ASSISTANT_FEATURE,
      AI_STAFF_ANALYTICS_FEATURE,
      AI_FINANCIAL_INSIGHTS_FEATURE,
    ],
    requiredUserPermission: "ai.financial_insights",
    taskClasses: OPERATIONAL_TASKS,
    capabilityDescription: {
      en: "Report revenue, deposits, and outstanding balances for a period.",
      ar: "عرض الإيرادات والدفعات المقدمة والمبالغ المستحقة خلال فترة.",
    },
  },
  {
    name: "compare_revenue_periods",
    build: compareRevenuePeriodsTool,
    roles: FINANCIAL,
    requiredFeatures: [
      AI_ASSISTANT_FEATURE,
      AI_STAFF_ANALYTICS_FEATURE,
      AI_FINANCIAL_INSIGHTS_FEATURE,
    ],
    requiredUserPermission: "ai.financial_insights",
    taskClasses: OPERATIONAL_TASKS,
    capabilityDescription: {
      en: "Compare two periods' revenue and explain the change from measured figures.",
      ar: "مقارنة إيرادات فترتين وتفسير الفرق استنادًا إلى أرقام فعلية.",
    },
  },
  {
    name: "list_outstanding_invoices",
    build: listOutstandingInvoicesTool,
    roles: FINANCIAL,
    requiredFeatures: [
      AI_ASSISTANT_FEATURE,
      AI_STAFF_ANALYTICS_FEATURE,
      AI_FINANCIAL_INSIGHTS_FEATURE,
    ],
    requiredUserPermission: "ai.financial_insights",
    taskClasses: OPERATIONAL_TASKS,
    capabilityDescription: {
      en: "List the largest outstanding patient balances and how old they are.",
      ar: "عرض أكبر المبالغ المستحقة على المرضى ومدة تأخرها.",
    },
  },
];

export const AI_TOOL_REGISTRY_BY_NAME = new Map(
  AI_TOOL_REGISTRY.map((definition) => [definition.name, definition]),
);
