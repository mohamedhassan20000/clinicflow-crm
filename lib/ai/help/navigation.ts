import "server-only";

import { getEntitlements, hasFeature } from "@/lib/entitlements";
import {
  getRolePageSlugs,
  PAGE_DEFINITIONS,
  type PageSlug,
} from "@/lib/page-permissions";
import {
  getPageVisibilityState,
  type PageVisibilityState,
} from "@/lib/server-page-permissions";
import type { AuthedUser, UserRole } from "@/lib/rbac";
import type { PromptLocale } from "@/lib/ai/prompts/doctor";
import { LEGACY_AI_ASSISTANT_FEATURE } from "@/lib/ai/commercial-policy";
import { isPrimaryClinicAdmin } from "@/lib/primary-admin";
import {
  getReportVisibilityState,
  type ReportVisibilityState,
} from "@/lib/server-report-permissions";
import type { ClinicReportId } from "@/lib/ai/clinic-reports";

/**
 * The navigation registry (P4.7A).
 *
 * One declaration per user-reachable destination in the tenant app. It exists so
 * the assistant can answer "where do I do X?" with a route the caller can
 * actually open — and, when they cannot, with the honest reason instead of a
 * link that 404s, redirects, or reveals a surface their administrator turned
 * off.
 *
 * **This registry is not an authorization source.** It is a map of destinations
 * plus the *declared* preconditions for each one; every decision is re-derived
 * at resolution time from the same machinery the shell and the middleware use —
 * `ROLE_PAGE_SLUGS` for the page a target lives on, the target's own narrower
 * role list (mirroring that route's `requireRole`), primary-admin authority
 * where the real surface requires it, the clinic's entitlements, and
 * `user_page_permissions` via `getPageVisibilityState`. Nothing here grants
 * access; it reports the result of those server-side preconditions for guidance.
 *
 * ## Authoring convention
 *
 * - `pageSlug` is the `PageSlug` the route belongs to, exactly as
 *   `getPageSlugFromPath` would classify `href`. It is what ties a target to the
 *   per-user page-visibility toggle. **Exception:** a handful of always-available
 *   routes (`/notifications`, `/profile`, `/preferences`) are not in the
 *   page-visibility system at all — `getPageSlugFromPath` returns `null` for
 *   them. They are mapped to `dashboard` deliberately, because `dashboard` is
 *   `alwaysVisible` and belongs to every role, so the visibility gate resolves
 *   them to `available` for everyone — which is exactly their real access. The
 *   slug is a stand-in for "always visible", not a claim that the route lives
 *   under Dashboard; each such entry says so inline.
 * - `roles` mirrors the route's own `requireRole` / role redirect **verbatim**.
 *   When both are present the stricter one wins at resolution, so an over-broad
 *   entry here is corrected by `ROLE_PAGE_SLUGS`, not by luck.
 * - `requiredFeatures` lists plan features without which the destination is not
 *   a real destination for this clinic (a disabled module or a premium-only
 *   surface). Such a target is never linked and never named as available.
 * - `requiresPrimaryClinicAdmin` mirrors the separate oldest-active-admin gate
 *   used by the AI and Customize settings surfaces. A secondary admin is still
 *   an admin, but must not be told that these destinations are available.
 * - `labels` / `breadcrumb` are the section names a human sees, in both
 *   languages. They are safe to state on a denial — telling someone the feature
 *   lives under Settings → Messaging is the honest answer the phase is for.
 *   `href` is not: it is returned only on `available`.
 * - `keywords` feed `search_help` retrieval and are matched after Arabic/English
 *   normalization, so they carry the words users actually type, not the words
 *   the UI displays.
 *
 * When a phase adds, moves, or role-gates a page, updating its entry here is
 * part of that phase's acceptance — the same maintenance rule the help corpus
 * carries.
 */
export type NavigationTargetId =
  | "dashboard"
  | "patients_list"
  | "patient_new"
  | "patients_archive"
  | "patients_trash"
  | "appointments_calendar"
  | "appointment_new"
  | "assistant"
  | "inbox"
  | "followups"
  | "revenue"
  | "reports_index"
  | "reports_cancellations"
  | "reports_no_shows"
  | "reports_revenue"
  | "reports_my_revenue"
  | "reports_my_performance"
  | "reports_doctors"
  | "reports_receptionists"
  | "reports_followups"
  | "settings_staff"
  | "settings_departments"
  | "settings_services"
  | "settings_packages"
  | "settings_insurance"
  | "settings_clinic"
  | "settings_customize"
  | "settings_messaging"
  | "settings_templates"
  | "settings_ai"
  | "settings_assistant"
  | "notifications"
  | "profile"
  | "preferences";

export type NavigationTarget = {
  id: NavigationTargetId;
  href: string;
  pageSlug: PageSlug;
  /** Mirrors the route's own role guard. */
  roles: readonly UserRole[];
  /** Plan features without which this destination does not exist for a clinic. */
  requiredFeatures?: readonly string[];
  /** Whether the route/action is reserved for the clinic's primary admin. */
  requiresPrimaryClinicAdmin?: boolean;
  /** Per-user report visibility gate for report detail destinations. */
  reportId?: ClinicReportId;
  labels: { en: string; ar: string };
  /** Human path, e.g. "Settings → Messaging". */
  breadcrumb: { en: string; ar: string };
  keywords: { en: readonly string[]; ar: readonly string[] };
};

const ALL_STAFF: readonly UserRole[] = [
  "admin",
  "manager",
  "receptionist",
  "doctor",
  "assistant",
];
const ADMIN_MANAGER: readonly UserRole[] = ["admin", "manager"];
const DOCTOR_ASSISTANT: readonly UserRole[] = ["doctor", "assistant"];
const ADMIN_MANAGER_RECEPTIONIST: readonly UserRole[] = [
  "admin",
  "manager",
  "receptionist",
];

/** WhatsApp/messaging module feature key, as read by the messaging surfaces. */
export const WHATSAPP_FEATURE = "whatsapp" as const;

export const NAVIGATION_TARGETS: readonly NavigationTarget[] = [
  {
    id: "dashboard",
    href: "/dashboard",
    pageSlug: "dashboard",
    roles: ALL_STAFF,
    labels: { en: "Dashboard", ar: "لوحة التحكم" },
    breadcrumb: { en: "Dashboard", ar: "لوحة التحكم" },
    keywords: {
      en: ["dashboard", "home", "overview", "today", "start page"],
      ar: ["لوحة التحكم", "الرئيسية", "نظرة عامة", "اليوم"],
    },
  },
  {
    id: "patients_list",
    href: "/patients",
    pageSlug: "patients",
    // Managers do not have the patients page in ROLE_PAGE_SLUGS.
    roles: ["admin", "receptionist", "doctor", "assistant"],
    labels: { en: "Patients", ar: "المرضى" },
    breadcrumb: { en: "Patients", ar: "المرضى" },
    keywords: {
      en: ["patients", "patient list", "patient file", "records", "search patient"],
      ar: ["المرضى", "قائمة المرضى", "ملف المريض", "السجلات", "البحث عن مريض"],
    },
  },
  {
    id: "patient_new",
    href: "/patients/new",
    pageSlug: "patients",
    // The patients page hides creation from doctors and managers
    // (`canCreate={!isDoctor && user.role !== "manager"}`).
    roles: ["admin", "receptionist"],
    labels: { en: "New patient", ar: "مريض جديد" },
    breadcrumb: { en: "Patients → New patient", ar: "المرضى ← مريض جديد" },
    keywords: {
      en: ["add patient", "new patient", "register patient", "create patient"],
      ar: ["إضافة مريض", "مريض جديد", "تسجيل مريض", "إنشاء مريض"],
    },
  },
  {
    id: "patients_archive",
    href: "/patients/archive",
    pageSlug: "patients",
    roles: ["admin"],
    labels: { en: "Patient archive", ar: "أرشيف المرضى" },
    breadcrumb: { en: "Patients → Archive", ar: "المرضى ← الأرشيف" },
    keywords: {
      en: ["archive", "archived patients", "old patients"],
      ar: ["الأرشيف", "المرضى المؤرشفون"],
    },
  },
  {
    id: "patients_trash",
    href: "/patients/trash",
    pageSlug: "patients",
    roles: ["admin"],
    labels: { en: "Patient recycle bin", ar: "سلة محذوفات المرضى" },
    breadcrumb: { en: "Patients → Recycle bin", ar: "المرضى ← سلة المحذوفات" },
    keywords: {
      en: ["trash", "recycle bin", "deleted patients", "restore patient"],
      ar: ["المحذوفات", "سلة المحذوفات", "استعادة مريض"],
    },
  },
  {
    id: "appointments_calendar",
    href: "/appointments",
    pageSlug: "appointments",
    roles: ["admin", "manager", "receptionist", "doctor", "assistant"],
    labels: { en: "Appointments", ar: "المواعيد" },
    breadcrumb: { en: "Appointments", ar: "المواعيد" },
    keywords: {
      en: ["appointments", "calendar", "schedule", "bookings", "agenda"],
      ar: ["المواعيد", "التقويم", "الجدول", "الحجوزات"],
    },
  },
  {
    id: "appointment_new",
    href: "/appointments/new",
    pageSlug: "appointments",
    roles: ["admin", "manager", "receptionist", "assistant"],
    labels: { en: "Book appointment", ar: "حجز موعد" },
    breadcrumb: { en: "Appointments → New appointment", ar: "المواعيد ← موعد جديد" },
    keywords: {
      en: ["book", "booking", "new appointment", "schedule appointment", "reserve"],
      ar: ["حجز", "موعد جديد", "جدولة موعد", "حجز موعد"],
    },
  },
  {
    id: "assistant",
    href: "/assistant",
    pageSlug: "assistant",
    roles: ALL_STAFF,
    labels: { en: "Assistant", ar: "المساعد" },
    breadcrumb: { en: "Assistant", ar: "المساعد" },
    keywords: {
      en: ["assistant", "ai", "chat", "ask"],
      ar: ["المساعد", "الذكاء الاصطناعي", "محادثة"],
    },
  },
  {
    id: "inbox",
    href: "/inbox",
    pageSlug: "inbox",
    roles: ["admin", "receptionist"],
    requiredFeatures: [WHATSAPP_FEATURE],
    labels: { en: "Inbox", ar: "صندوق الوارد" },
    breadcrumb: { en: "Inbox", ar: "صندوق الوارد" },
    keywords: {
      en: ["inbox", "whatsapp", "messages", "conversation", "reply", "chat with patient"],
      ar: ["صندوق الوارد", "واتساب", "الرسائل", "محادثة", "الرد على مريض"],
    },
  },
  {
    id: "followups",
    href: "/followups",
    pageSlug: "followups",
    roles: ["admin", "manager", "receptionist", "doctor", "assistant"],
    labels: { en: "Follow-ups", ar: "المتابعات" },
    breadcrumb: { en: "Follow-ups", ar: "المتابعات" },
    keywords: {
      en: ["follow up", "follow-ups", "call patient", "aftercare", "check on patient"],
      ar: ["المتابعة", "المتابعات", "الاتصال بالمريض", "متابعة ما بعد الجلسة"],
    },
  },
  {
    id: "revenue",
    href: "/revenue",
    pageSlug: "revenue",
    // The page redirects receptionists to the dashboard.
    roles: ADMIN_MANAGER,
    labels: { en: "Revenue", ar: "الإيرادات" },
    breadcrumb: { en: "Revenue", ar: "الإيرادات" },
    keywords: {
      en: ["revenue", "income", "payments", "collected", "statement", "money"],
      ar: ["الإيرادات", "الدخل", "المدفوعات", "المحصل", "كشف الحساب"],
    },
  },
  {
    id: "reports_index",
    href: "/reports",
    pageSlug: "reports",
    roles: ALL_STAFF,
    labels: { en: "Reports", ar: "التقارير" },
    breadcrumb: { en: "Reports", ar: "التقارير" },
    keywords: {
      en: ["reports", "report", "analytics", "statistics"],
      ar: ["التقارير", "تقرير", "التحليلات", "الإحصائيات"],
    },
  },
  {
    id: "reports_cancellations",
    href: "/reports/cancellations",
    pageSlug: "reports",
    roles: ALL_STAFF,
    reportId: "cancellations",
    labels: { en: "Cancellation report", ar: "تقرير الإلغاءات" },
    breadcrumb: { en: "Reports → Cancellations", ar: "التقارير ← الإلغاءات" },
    keywords: {
      en: ["cancellation", "cancellations", "cancelled appointments"],
      ar: ["الإلغاء", "الإلغاءات", "المواعيد الملغاة"],
    },
  },
  {
    id: "reports_no_shows",
    href: "/reports/no-shows",
    pageSlug: "reports",
    roles: ALL_STAFF,
    reportId: "no_shows",
    labels: { en: "No-show report", ar: "تقرير عدم الحضور" },
    breadcrumb: { en: "Reports → No-shows", ar: "التقارير ← عدم الحضور" },
    keywords: {
      en: ["no show", "no-shows", "missed appointments", "absent"],
      ar: ["عدم الحضور", "المواعيد الفائتة", "تغيب"],
    },
  },
  {
    id: "reports_revenue",
    href: "/reports/revenue",
    pageSlug: "reports",
    roles: ADMIN_MANAGER_RECEPTIONIST,
    reportId: "revenue",
    labels: { en: "Revenue report", ar: "تقرير الإيرادات" },
    breadcrumb: { en: "Reports → Revenue", ar: "التقارير ← الإيرادات" },
    keywords: {
      en: ["revenue report", "income report", "financial report"],
      ar: ["تقرير الإيرادات", "تقرير الدخل", "التقرير المالي"],
    },
  },
  {
    id: "reports_my_revenue",
    href: "/reports/my-revenue",
    pageSlug: "reports",
    roles: DOCTOR_ASSISTANT,
    reportId: "my_revenue",
    labels: { en: "My revenue report", ar: "تقرير إيراداتي" },
    breadcrumb: { en: "Reports → My revenue", ar: "التقارير ← إيراداتي" },
    keywords: {
      en: ["my revenue", "my income", "my earnings", "personal revenue"],
      ar: ["إيراداتي", "دخلي", "أرباحي", "الإيرادات الشخصية"],
    },
  },
  {
    id: "reports_my_performance",
    href: "/reports/my-performance",
    pageSlug: "reports",
    // Doctor-only self-scoped operational performance.
    roles: ["doctor"],
    reportId: "my_performance",
    labels: { en: "My performance report", ar: "تقرير أدائي" },
    breadcrumb: { en: "Reports → My performance", ar: "التقارير ← أدائي" },
    keywords: {
      en: ["my performance", "my stats", "my appointments", "my no-shows", "personal performance"],
      ar: ["أدائي", "إحصائياتي", "مواعيدي", "أدائي الشخصي", "عدم الحضور لدي"],
    },
  },
  {
    id: "reports_doctors",
    href: "/reports/doctors",
    pageSlug: "reports",
    roles: ADMIN_MANAGER,
    reportId: "doctor_performance",
    labels: { en: "Doctor performance", ar: "أداء الأطباء" },
    breadcrumb: { en: "Reports → Doctors", ar: "التقارير ← الأطباء" },
    keywords: {
      en: ["doctor performance", "doctor report", "per doctor"],
      ar: ["أداء الأطباء", "تقرير الأطباء"],
    },
  },
  {
    id: "reports_receptionists",
    href: "/reports/receptionists",
    pageSlug: "reports",
    roles: ADMIN_MANAGER,
    reportId: "receptionist_performance",
    labels: { en: "Receptionist performance", ar: "أداء موظفي الاستقبال" },
    breadcrumb: { en: "Reports → Receptionists", ar: "التقارير ← موظفو الاستقبال" },
    keywords: {
      en: ["receptionist performance", "front desk report", "bookings by staff"],
      ar: ["أداء موظفي الاستقبال", "تقرير الاستقبال"],
    },
  },
  {
    id: "reports_followups",
    href: "/reports/follow-ups",
    pageSlug: "reports",
    roles: ALL_STAFF,
    reportId: "followups",
    labels: { en: "Follow-ups report", ar: "تقرير المتابعات" },
    breadcrumb: { en: "Reports → Follow-ups", ar: "التقارير ← المتابعات" },
    keywords: {
      en: ["follow-up report", "follow up outcomes"],
      ar: ["تقرير المتابعات", "نتائج المتابعة"],
    },
  },
  {
    id: "settings_staff",
    href: "/settings/staff",
    pageSlug: "settings",
    roles: ADMIN_MANAGER,
    labels: { en: "Staff", ar: "الموظفون" },
    breadcrumb: { en: "Settings → Staff", ar: "الإعدادات ← الموظفون" },
    keywords: {
      en: ["staff", "team", "employee", "add user", "invite", "doctor account", "permissions"],
      ar: ["الموظفون", "الفريق", "إضافة مستخدم", "دعوة", "حساب طبيب", "الصلاحيات"],
    },
  },
  {
    id: "settings_departments",
    href: "/settings/departments",
    pageSlug: "settings",
    roles: ADMIN_MANAGER,
    labels: { en: "Departments", ar: "الأقسام" },
    breadcrumb: { en: "Settings → Departments", ar: "الإعدادات ← الأقسام" },
    keywords: {
      en: ["department", "departments", "clinic sections", "specialty"],
      ar: ["القسم", "الأقسام", "التخصص"],
    },
  },
  {
    id: "settings_services",
    href: "/settings/services",
    pageSlug: "settings",
    roles: ADMIN_MANAGER,
    labels: { en: "Services", ar: "الخدمات" },
    breadcrumb: { en: "Settings → Services", ar: "الإعدادات ← الخدمات" },
    keywords: {
      en: ["service", "services", "price", "pricing", "fees", "treatment price"],
      ar: ["خدمة", "الخدمات", "السعر", "التسعير", "الرسوم"],
    },
  },
  {
    id: "settings_packages",
    href: "/settings/packages",
    pageSlug: "settings",
    roles: ADMIN_MANAGER,
    labels: { en: "Packages", ar: "الباقات" },
    breadcrumb: { en: "Settings → Packages", ar: "الإعدادات ← الباقات" },
    keywords: {
      en: ["package", "packages", "sessions bundle", "package template"],
      ar: ["باقة", "الباقات", "حزمة جلسات", "قالب باقة"],
    },
  },
  {
    id: "settings_insurance",
    href: "/settings/insurance",
    pageSlug: "settings",
    roles: ADMIN_MANAGER,
    labels: { en: "Insurance", ar: "التأمين" },
    breadcrumb: { en: "Settings → Insurance", ar: "الإعدادات ← التأمين" },
    keywords: {
      en: ["insurance", "insurance provider", "coverage", "payer"],
      ar: ["التأمين", "شركة التأمين", "التغطية"],
    },
  },
  {
    id: "settings_clinic",
    href: "/settings/clinic",
    pageSlug: "settings",
    roles: ADMIN_MANAGER,
    labels: { en: "Clinic", ar: "العيادة" },
    breadcrumb: { en: "Settings → Clinic", ar: "الإعدادات ← العيادة" },
    keywords: {
      en: ["clinic settings", "working hours", "logo", "currency", "opening hours", "timezone"],
      ar: ["إعدادات العيادة", "ساعات العمل", "الشعار", "العملة", "أوقات الدوام"],
    },
  },
  {
    id: "settings_customize",
    href: "/settings/customize",
    pageSlug: "settings",
    roles: ["admin"],
    requiresPrimaryClinicAdmin: true,
    labels: { en: "Customize", ar: "التخصيص" },
    breadcrumb: { en: "Settings → Customize", ar: "الإعدادات ← التخصيص" },
    keywords: {
      en: ["customize", "page visibility", "hide page", "show page", "per user access"],
      ar: ["التخصيص", "إظهار الصفحات", "إخفاء صفحة", "صلاحيات الصفحات"],
    },
  },
  {
    id: "settings_messaging",
    href: "/settings/messaging",
    pageSlug: "settings",
    roles: ADMIN_MANAGER,
    labels: { en: "Messaging", ar: "المراسلة" },
    breadcrumb: { en: "Settings → Messaging", ar: "الإعدادات ← المراسلة" },
    keywords: {
      en: ["messaging", "whatsapp", "reminders", "reminder", "notifications to patients"],
      ar: ["المراسلة", "واتساب", "التذكيرات", "تذكير", "إشعارات المرضى"],
    },
  },
  {
    id: "settings_templates",
    href: "/settings/templates",
    pageSlug: "settings",
    roles: ADMIN_MANAGER,
    labels: { en: "Templates", ar: "القوالب" },
    breadcrumb: { en: "Settings → Templates", ar: "الإعدادات ← القوالب" },
    keywords: {
      en: ["template", "templates", "message template", "medical note template"],
      ar: ["قالب", "القوالب", "قالب رسالة", "قالب ملاحظة"],
    },
  },
  {
    id: "settings_ai",
    href: "/settings/ai",
    pageSlug: "settings",
    roles: ["admin"],
    requiredFeatures: [LEGACY_AI_ASSISTANT_FEATURE],
    requiresPrimaryClinicAdmin: true,
    labels: { en: "AI", ar: "الذكاء الاصطناعي" },
    breadcrumb: { en: "Settings → AI", ar: "الإعدادات ← الذكاء الاصطناعي" },
    keywords: {
      en: ["ai settings", "assistant settings", "api key", "financial insights permission", "ai usage"],
      ar: ["إعدادات الذكاء الاصطناعي", "إعدادات المساعد", "مفتاح", "صلاحية المؤشرات المالية", "استهلاك"],
    },
  },
  {
    id: "settings_assistant",
    href: "/settings/assistant",
    pageSlug: "settings",
    roles: ["admin"],
    requiresPrimaryClinicAdmin: true,
    labels: { en: "Assistant placement", ar: "مواضع المساعد" },
    breadcrumb: {
      en: "Settings → Assistant placement",
      ar: "الإعدادات ← مواضع المساعد",
    },
    keywords: {
      en: [
        "assistant placement",
        "assistant launcher",
        "ask assistant button",
        "assistant role defaults",
        "assistant per user",
      ],
      ar: [
        "مواضع المساعد",
        "زر اسأل المساعد",
        "إعدادات المساعد حسب الدور",
        "تخصيص المساعد للموظف",
      ],
    },
  },
  {
    id: "notifications",
    href: "/notifications",
    // Not in the page-visibility system (getPageSlugFromPath → null); mapped to
    // the alwaysVisible `dashboard` slug so it resolves available for everyone.
    pageSlug: "dashboard",
    roles: ALL_STAFF,
    labels: { en: "Notifications", ar: "الإشعارات" },
    breadcrumb: { en: "Notifications", ar: "الإشعارات" },
    keywords: {
      en: ["notifications", "alerts", "bell"],
      ar: ["الإشعارات", "التنبيهات"],
    },
  },
  {
    id: "profile",
    href: "/profile",
    // Not in the page-visibility system (getPageSlugFromPath → null); mapped to
    // the alwaysVisible `dashboard` slug so it resolves available for everyone.
    pageSlug: "dashboard",
    roles: ALL_STAFF,
    labels: { en: "My profile", ar: "ملفي الشخصي" },
    breadcrumb: { en: "Profile", ar: "الملف الشخصي" },
    keywords: {
      en: ["profile", "my account", "change password", "my photo"],
      ar: ["الملف الشخصي", "حسابي", "تغيير كلمة المرور", "صورتي"],
    },
  },
  {
    id: "preferences",
    href: "/preferences",
    // Not in the page-visibility system (getPageSlugFromPath → null); mapped to
    // the alwaysVisible `dashboard` slug so it resolves available for everyone.
    pageSlug: "dashboard",
    roles: ALL_STAFF,
    labels: { en: "Preferences", ar: "التفضيلات" },
    breadcrumb: { en: "Preferences", ar: "التفضيلات" },
    keywords: {
      en: ["preferences", "language", "theme", "dark mode", "settings for me"],
      ar: ["التفضيلات", "اللغة", "المظهر", "الوضع الداكن"],
    },
  },
];

export const NAVIGATION_TARGETS_BY_ID = new Map(
  NAVIGATION_TARGETS.map((target) => [target.id, target]),
);

export const NAVIGATION_TARGET_IDS = NAVIGATION_TARGETS.map((target) => target.id);

/**
 * Why a destination is not reachable, or that it is.
 *
 * The reasons are kept distinct rather than collapsed into "no", because they
 * send the user to different people: a hidden page is their administrator's
 * toggle, an unentitled module is the clinic's plan, and a role boundary is
 * neither. That distinction is the entire point of the tool — see the
 * `permission_denied` reasons in `lib/ai/errors.ts`, which make the same split
 * for tool execution.
 */
export type NavigationAccessStatus =
  | "available"
  | "role_forbidden"
  | "primary_admin_required"
  | "hidden_by_admin"
  | "not_entitled"
  | "lookup_failed";

export type NavigationResolution = {
  id: NavigationTargetId;
  status: NavigationAccessStatus;
  label: string;
  breadcrumb: string;
  /**
   * Present **only** when `status === "available"`.
   *
   * A route the caller cannot open must never appear in model context: an
   * assistant that names it will offer it, and a user who follows it lands on a
   * redirect or a 404 while believing the assistant told them the truth. The
   * section name is still returned so the answer can be honest and specific
   * about *what* is unavailable and *who* can change it.
   */
  href?: string;
};

const UNKNOWN_TARGET = {
  status: "role_forbidden" as const,
};

/**
 * Resolves one navigation target for one user, re-deriving every gate.
 *
 * Order matters only for which reason is reported, never for whether access is
 * granted — every applicable gate must pass. Role is checked first because it is free
 * and is the coarsest boundary; entitlement next because a module the clinic
 * does not have is not a per-user problem; page visibility last because it is
 * the only one that costs a database read.
 */
export async function resolveNavigationTarget(
  user: Pick<AuthedUser, "id" | "clinicId" | "role">,
  id: NavigationTargetId,
  locale: PromptLocale,
): Promise<NavigationResolution> {
  return resolveOne(
    user,
    id,
    locale,
    (slug) => getPageVisibilityState(user, slug),
    (reportId) => getReportVisibilityState(user, reportId),
    () => isPrimaryClinicAdmin(user.id, user.clinicId),
  );
}

/**
 * Batch resolution used by `search_help`, which needs a verdict for every
 * article's destination at once.
 *
 * It is the *same* function as the single-target path with a shared visibility
 * reader injected — deliberately, because the alternative is two copies of an
 * authorization decision that must agree forever. Page visibility is resolved
 * once per distinct `PageSlug` rather than once per target; a help search
 * touching eight Settings articles would otherwise issue eight identical reads.
 */
export async function resolveNavigationTargets(
  user: Pick<AuthedUser, "id" | "clinicId" | "role">,
  ids: readonly NavigationTargetId[],
  locale: PromptLocale,
): Promise<Map<NavigationTargetId, NavigationResolution>> {
  const visibilityCache = new Map<PageSlug, Promise<PageVisibilityState>>();
  const readVisibility = (slug: PageSlug) => {
    let pending = visibilityCache.get(slug);
    if (!pending) {
      pending = getPageVisibilityState(user, slug);
      visibilityCache.set(slug, pending);
    }
    return pending;
  };
  const reportVisibilityCache = new Map<
    ClinicReportId,
    Promise<ReportVisibilityState>
  >();
  const readReportVisibility = (reportId: ClinicReportId) => {
    let pending = reportVisibilityCache.get(reportId);
    if (!pending) {
      pending = getReportVisibilityState(user, reportId);
      reportVisibilityCache.set(reportId, pending);
    }
    return pending;
  };
  let primaryAdminCheck: Promise<boolean> | undefined;
  const readPrimaryAdmin = () => {
    primaryAdminCheck ??= isPrimaryClinicAdmin(user.id, user.clinicId);
    return primaryAdminCheck;
  };

  const resolutions = await Promise.all(
    [...new Set(ids)].map((id) =>
      resolveOne(
        user,
        id,
        locale,
        readVisibility,
        readReportVisibility,
        readPrimaryAdmin,
      ),
    ),
  );
  return new Map(resolutions.map((resolution) => [resolution.id, resolution]));
}

/**
 * The one place a navigation verdict is decided.
 *
 * Order matters only for which reason is reported, never for whether access is
 * granted — every applicable gate must pass. Role is checked first because it is free and is
 * the coarsest boundary; entitlement next because a module the clinic does not
 * have is not a per-user problem; page visibility last because it is the only
 * one that costs a database read.
 */
async function resolveOne(
  user: Pick<AuthedUser, "id" | "clinicId" | "role">,
  id: NavigationTargetId,
  locale: PromptLocale,
  readVisibility: (slug: PageSlug) => Promise<PageVisibilityState>,
  readReportVisibility: (
    reportId: ClinicReportId,
  ) => Promise<ReportVisibilityState>,
  readPrimaryAdmin: () => Promise<boolean>,
): Promise<NavigationResolution> {
  const target = NAVIGATION_TARGETS_BY_ID.get(id);
  if (!target) {
    // An unknown id cannot be described at all — there is no label to report and
    // nothing honest to say beyond "not something you can open".
    return { id, ...UNKNOWN_TARGET, label: id, breadcrumb: id };
  }

  const base = {
    id,
    label: target.labels[locale],
    breadcrumb: target.breadcrumb[locale],
  };

  // Two independent role sources: the page-level matrix the shell and middleware
  // use, and the route's own guard. Both must admit the caller. Neither is
  // trusted to be a superset of the other.
  const rolePages = new Set(getRolePageSlugs(user.role));
  if (!target.roles.includes(user.role) || !rolePages.has(target.pageSlug)) {
    return { ...base, status: "role_forbidden" };
  }

  if (target.requiresPrimaryClinicAdmin) {
    try {
      if (!(await readPrimaryAdmin())) {
        return { ...base, status: "primary_admin_required" };
      }
    } catch {
      // A failed authority lookup is not evidence that this user is the clinic's
      // primary administrator. Withhold the route exactly as visibility lookup
      // failures do.
      return { ...base, status: "lookup_failed" };
    }
  }

  if (target.requiredFeatures?.length) {
    const entitlements = await getEntitlements(user.clinicId);
    if (
      !entitlements.subscriptionAllowed ||
      !target.requiredFeatures.every((feature) => hasFeature(entitlements, feature))
    ) {
      return { ...base, status: "not_entitled" };
    }
  }

  const visibility = await readVisibility(target.pageSlug);
  if (visibility === "hidden") return { ...base, status: "hidden_by_admin" };
  // Fail closed. A permission lookup that could not complete is not evidence of
  // access, and handing out a link on an unverified check is exactly the
  // "guidance contradicts server-side authorization" failure this phase exists
  // to prevent.
  if (visibility === "lookup_failed") return { ...base, status: "lookup_failed" };

  if (target.reportId) {
    const reportVisibility = await readReportVisibility(target.reportId);
    if (reportVisibility === "hidden") {
      return { ...base, status: "hidden_by_admin" };
    }
    if (reportVisibility === "lookup_failed") {
      return { ...base, status: "lookup_failed" };
    }
  }

  return { ...base, status: "available", href: target.href };
}

/** Every target id that exists, for the tool's input enum. */
export function isNavigationTargetId(value: string): value is NavigationTargetId {
  return NAVIGATION_TARGETS_BY_ID.has(value as NavigationTargetId);
}

/** Page definitions this registry must stay aligned with (asserted by tests). */
export const REGISTERED_PAGE_SLUGS = new Set(PAGE_DEFINITIONS.map((page) => page.slug));
