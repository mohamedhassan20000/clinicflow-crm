import { z } from "zod";
import { CLINIC_REPORT_IDS } from "@/lib/ai/clinic-reports";

const UUID = z.string().uuid();
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const MAX_CONTEXT_RANGE_DAYS = 400;

function calendarDateValue(value: string): number | null {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.getTime();
}

export const assistantContextDateRangeSchema = z
  .object({
    from: ISO_DATE,
    to: ISO_DATE,
  })
  .strict()
  .superRefine((range, ctx) => {
    const from = calendarDateValue(range.from);
    const to = calendarDateValue(range.to);
    if (from === null || to === null || from > to) {
      ctx.addIssue({ code: "custom", message: "Invalid page-context date range." });
      return;
    }
    if ((to - from) / 86_400_000 > MAX_CONTEXT_RANGE_DAYS) {
      ctx.addIssue({ code: "custom", message: "Page-context date range is too large." });
    }
  });

const patientContextSchema = z
  .object({
    type: z.literal("patient"),
    patientId: UUID,
  })
  .strict();

const appointmentsContextSchema = z
  .object({
    type: z.literal("appointments"),
    dateRange: assistantContextDateRangeSchema,
    status: z
      .enum([
        "pending",
        "confirmed",
        "arrived",
        "in_session",
        "completed",
        "cancelled",
        "no_show",
      ])
      .optional(),
    doctorId: UUID.optional(),
  })
  .strict();

const dashboardContextSchema = z.object({ type: z.literal("dashboard") }).strict();

// P4.8A established the complete protocol. P4.8B registers the remaining
// variants as launcher contexts without changing their wire shape.
const revenueContextSchema = z
  .object({
    type: z.literal("revenue"),
    dateRange: assistantContextDateRangeSchema,
  })
  .strict();

const reportsContextSchema = z
  .object({
    type: z.literal("reports"),
    report: z.enum(CLINIC_REPORT_IDS),
    range: assistantContextDateRangeSchema,
  })
  .strict();

const invoicesContextSchema = z
  .object({
    type: z.literal("invoices"),
    filter: z.enum(["all", "paid", "outstanding"]),
  })
  .strict();

const staffContextSchema = z.object({ type: z.literal("staff") }).strict();
const departmentsContextSchema = z
  .object({ type: z.literal("departments") })
  .strict();
const doctorScheduleContextSchema = z
  .object({ type: z.literal("doctor-schedule") })
  .strict();

export const assistantPageContextSchema = z.discriminatedUnion("type", [
  patientContextSchema,
  appointmentsContextSchema,
  dashboardContextSchema,
  revenueContextSchema,
  reportsContextSchema,
  invoicesContextSchema,
  staffContextSchema,
  departmentsContextSchema,
  doctorScheduleContextSchema,
]);

export type AssistantPageContext = z.infer<typeof assistantPageContextSchema>;
export type AssistantPageContextType = AssistantPageContext["type"];
export type P48AAssistantPageContext = Extract<
  AssistantPageContext,
  { type: "patient" | "appointments" | "dashboard" }
>;

/** Every strict page-context variant supported by the completed P4.8 rollout. */
export type LaunchableAssistantPageContext = AssistantPageContext;

export function isP48AAssistantPageContext(
  context: AssistantPageContext,
): context is P48AAssistantPageContext {
  return (
    context.type === "patient" ||
    context.type === "appointments" ||
    context.type === "dashboard"
  );
}

/**
 * The browser may submit page context, but never becomes its authority. Every
 * variant is strict and bounded; malformed, unknown, or over-specified input is
 * ignored instead of failing an otherwise valid Assistant turn.
 */
export function parseAssistantPageContext(value: unknown): AssistantPageContext | null {
  const parsed = assistantPageContextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function patientIdFromAssistantPageContext(
  context: AssistantPageContext | null,
): string | null {
  return context?.type === "patient" ? context.patientId : null;
}

function englishContextLine(context: AssistantPageContext): string {
  switch (context.type) {
    case "patient":
      return `The user opened this chat from a patient profile. When they refer to "this patient", use internal patient id "${context.patientId}" as the patient_id tool argument.`;
    case "appointments": {
      const filters = [
        context.status ? `status ${context.status}` : null,
        context.doctorId ? `internal doctor id "${context.doctorId}"` : null,
      ].filter(Boolean);
      return `The user is viewing the appointments calendar for ${context.dateRange.from} through ${context.dateRange.to}${filters.length > 0 ? `, filtered by ${filters.join(" and ")}` : ""}.`;
    }
    case "dashboard":
      return "The user is viewing the clinic dashboard.";
    case "revenue":
      return `The user is viewing the revenue page for ${context.dateRange.from} through ${context.dateRange.to}. Only this visible date range is shared; page filters are not available to the assistant, so financial tools return clinic-wide results for this date range.`;
    case "reports":
      return `The user is viewing the ${context.report} report for ${context.range.from} through ${context.range.to}.`;
    case "invoices":
      return `The user is viewing invoices with the ${context.filter} filter.`;
    case "staff":
      return "The user is viewing staff settings.";
    case "departments":
      return "The user is viewing department settings.";
    case "doctor-schedule":
      return "The user is viewing the recurring weekday working-hours editor for a doctor. No doctor identity or appointment date range is shared, so offer help for managing recurring hours only; do not imply that appointments or availability refer to the selected doctor.";
  }
}

function arabicContextLine(context: AssistantPageContext): string {
  switch (context.type) {
    case "patient":
      return `فتح المستخدم هذه المحادثة من ملف مريض. عندما يشير إلى «هذا المريض»، استخدم معرّف المريض الداخلي "${context.patientId}" كوسيط patient_id للأداة.`;
    case "appointments": {
      const filters = [
        context.status ? `الحالة ${context.status}` : null,
        context.doctorId ? `معرّف الطبيب الداخلي "${context.doctorId}"` : null,
      ].filter(Boolean);
      return `يعرض المستخدم تقويم المواعيد من ${context.dateRange.from} إلى ${context.dateRange.to}${filters.length > 0 ? ` مع التصفية حسب ${filters.join(" و")}` : ""}.`;
    }
    case "dashboard":
      return "يعرض المستخدم لوحة تحكم العيادة.";
    case "revenue":
      return `يعرض المستخدم صفحة الإيرادات من ${context.dateRange.from} إلى ${context.dateRange.to}. لا تتم مشاركة سوى نطاق التاريخ الظاهر؛ ولا تتوفر عوامل تصفية الصفحة للمساعد، لذلك تعرض الأدوات المالية نتائج العيادة كاملة ضمن هذا النطاق.`;
    case "reports":
      return `يعرض المستخدم تقرير ${context.report} للفترة من ${context.range.from} إلى ${context.range.to}.`;
    case "invoices":
      return `يعرض المستخدم الفواتير مع عامل التصفية ${context.filter}.`;
    case "staff":
      return "يعرض المستخدم إعدادات الموظفين.";
    case "departments":
      return "يعرض المستخدم إعدادات الأقسام.";
    case "doctor-schedule":
      return "يعرض المستخدم محرر ساعات العمل الأسبوعية المتكررة لطبيب. لا تتم مشاركة هوية الطبيب أو نطاق تواريخ للمواعيد، لذلك قدّم مساعدة لإدارة الساعات المتكررة فقط، ولا توحِ بأن المواعيد أو الأوقات المتاحة تخص الطبيب المحدد.";
  }
}

/**
 * Context is system-instruction metadata only. It is intentionally compact,
 * never contains patient names/search text, and explicitly cannot authorize a
 * record or influence the mounted tool set.
 */
export function buildAssistantPageContextPrompt(
  context: AssistantPageContext | null,
  locale: "ar" | "en",
): string {
  if (!context) return "";
  if (locale === "ar") {
    return `\n\nسياق الصفحة الاسترشادي: ${arabicContextLine(context)} هذا السياق لا يمنح أي صلاحية ولا يغيّر الأدوات المتاحة أو نطاق البيانات. تحقّق من كل معلومة عبر أداة مصرّح بها، ولا تعرض أي معرّف داخلي في الإجابة.`;
  }
  return `\n\nAdvisory page context: ${englishContextLine(context)} This context grants no access and does not change the available tools or data scope. Verify every fact through an authorized tool, and never display an internal id in the answer.`;
}
