import "server-only";

import type { Tool } from "ai";
import type { UserRole } from "@/lib/rbac";
import type { AiTaskClass } from "@/lib/ai/platform/types";
import type { AiUserPermissionKey } from "@/lib/ai/permissions";
import type { DoctorToolContext } from "@/lib/ai/tools/context";

// Existing P4 tools, migrated onto the registry with behavior unchanged.
import { searchAuthorizedPatientsTool } from "@/lib/ai/tools/search-authorized-patients";
import { getPatientSummaryTool } from "@/lib/ai/tools/get-patient-summary";
import { searchPatientVisitsTool } from "@/lib/ai/tools/search-patient-visits";
import { listDoctorAppointmentsTool } from "@/lib/ai/tools/list-doctor-appointments";
import { checkAvailabilityTool } from "@/lib/ai/tools/check-availability";

// P4.6A analytics, operational, financial, and reporting tools.
import { getClinicSummaryTool } from "@/lib/ai/tools/get-clinic-summary";
import { getPatientStatsTool } from "@/lib/ai/tools/get-patient-stats";
import { getAppointmentStatsTool } from "@/lib/ai/tools/get-appointment-stats";
import { listAppointmentsTool } from "@/lib/ai/tools/list-appointments";
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
  requiredFeatures: readonly string[];
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

const ALL_STAFF: readonly UserRole[] = ["admin", "manager", "receptionist", "doctor"];
const ADMINISTRATIVE: readonly UserRole[] = ["admin", "manager", "receptionist"];
const ANALYTICS: readonly UserRole[] = ["admin", "manager"];
const FINANCIAL: readonly UserRole[] = ["admin", "manager"];

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
const CLINICAL_TASKS: readonly AiTaskClass[] = ["staff_clinical_summary"];
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

export const AI_TOOL_REGISTRY: readonly AiToolDefinition[] = [
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
    name: "get_patient_summary",
    build: getPatientSummaryTool,
    roles: ["doctor"],
    requiredFeatures: [AI_ASSISTANT_FEATURE],
    taskClasses: CLINICAL_TASKS,
    capabilityDescription: {
      en: "Summarize a patient's clinical record.",
      ar: "تلخيص السجل السريري للمريض.",
    },
  },
  {
    name: "search_patient_visits",
    build: searchPatientVisitsTool,
    roles: ["doctor"],
    requiredFeatures: [AI_ASSISTANT_FEATURE],
    taskClasses: CLINICAL_TASKS,
    capabilityDescription: {
      en: "Search a patient's previous visits and notes.",
      ar: "البحث في زيارات المريض السابقة وملاحظاتها.",
    },
  },
  {
    name: "list_doctor_appointments",
    build: listDoctorAppointmentsTool,
    roles: ["doctor"],
    requiredFeatures: [AI_ASSISTANT_FEATURE],
    taskClasses: CLINICAL_TASKS,
    capabilityDescription: {
      en: "List your own upcoming appointments.",
      ar: "عرض مواعيدك القادمة.",
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
    name: "list_appointments",
    build: listAppointmentsTool,
    roles: ADMINISTRATIVE,
    requiredFeatures: [AI_ASSISTANT_FEATURE, AI_STAFF_ANALYTICS_FEATURE],
    taskClasses: OPERATIONAL_TASKS,
    capabilityDescription: {
      en: "List appointments for a date range, filtered by status, doctor, or department.",
      ar: "عرض المواعيد ضمن فترة زمنية مع تصفية حسب الحالة أو الطبيب أو القسم.",
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
    // Managers are excluded because get_followups_dashboard denies them; the
    // assistant must not reach data the same user is refused in the UI.
    build: listPendingFollowupsTool,
    roles: ["admin", "receptionist"],
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
