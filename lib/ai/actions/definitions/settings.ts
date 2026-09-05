import "server-only";

import type { z } from "zod";
import {
  domainAudit,
  requireDomainMutationSuccess,
  scalarChanges,
} from "@/lib/ai/actions/definitions/domain-shared";
import {
  registerActionDefinition,
  type ActionDefinition,
  type RegisteredActionDefinition,
} from "@/lib/ai/actions/types";
import type {
  DomainMutationMode,
  DomainMutationResult,
} from "@/lib/domain-mutations";
import type { AuthedUser, UserRole } from "@/lib/rbac";
import {
  clinicUpdateActionSchema,
  clinicWorkingHoursActionSchema,
  createDirectoryMutation,
  createStaffMutation,
  departmentCreateActionSchema,
  departmentUpdateActionSchema,
  directoryLifecycleMutation,
  insuranceCreateActionSchema,
  insuranceUpdateActionSchema,
  invoiceFollowupSettingsSchema,
  reminderSettingsSchema,
  serviceCreateActionSchema,
  serviceUpdateActionSchema,
  settingsLifecycleSchema,
  settingsToggleSchema,
  SETTINGS_ADMIN_ROLES,
  SETTINGS_WRITE_ROLES,
  staffCreateNonPrivilegedActionSchema,
  staffProfileActionSchema,
  staffScheduleActionSchema,
  updateClinicMutation,
  updateDirectoryMutation,
  updateInvoiceFollowupSettingsMutation,
  updateReminderSettingsMutation,
  updateStaffProfileMutation,
  upsertClinicWorkingHoursMutation,
  upsertStaffScheduleMutation,
} from "@/lib/settings/mutations";

type SettingsCore = (
  user: AuthedUser,
  input: unknown,
  mode?: DomainMutationMode,
) => Promise<DomainMutationResult<Record<string, unknown>>>;

function changes(result: ReturnType<typeof requireDomainMutationSuccess>) {
  const before = result.audit.before as Record<string, unknown> | undefined;
  const after = result.audit.after as Record<string, unknown> | undefined;
  return scalarChanges(
    before,
    after,
    Array.from(
      new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
    ).filter(
      (field) =>
        ![
          "clinic_id",
          "temporary_password",
          "created_at",
          "updated_at",
        ].includes(field),
    ),
  );
}

function recordIdentifyingChanges(
  result: ReturnType<typeof requireDomainMutationSuccess>,
  risk: "normal" | "sensitive" | "destructive",
) {
  const resultChanges = changes(result);
  if (risk !== "destructive") return resultChanges;
  return resultChanges.map((change) =>
    change.label === "name"
      ? {
          ...change,
          before:
            typeof change.before === "string"
              ? `Record ${change.before}`
              : change.before,
          after:
            typeof change.after === "string"
              ? `Record ${change.after}`
              : change.after,
          identifiesRecord: true as const,
        }
      : change,
  );
}

function mutationAction<T>(options: {
  id: string;
  roles: readonly UserRole[];
  risk: "normal" | "sensitive" | "destructive";
  schema: z.ZodType<T>;
  labels: { en: string; ar: string };
  description: { en: string; ar: string };
  previewSummary: string;
  completedSummary: string;
  core: SettingsCore;
}): RegisteredActionDefinition {
  const definition: ActionDefinition<T> = {
    id: options.id,
    roles: options.roles,
    requiredFeatures: ["ai.write_administration"],
    risk: options.risk,
    pageSlug: "settings",
    inputSchema: options.schema,
    labels: options.labels,
    description: options.description,
    inputDescription: {
      en: "The complete validated administrative mutation input.",
      ar: "بيانات التعديل الإداري الكاملة بعد التحقق.",
    },
    async preview(user, input) {
      const result = requireDomainMutationSuccess(
        await options.core(user, input, "preview"),
      );
      return {
        title: options.labels.en,
        summary: options.previewSummary,
        changes: recordIdentifyingChanges(result, options.risk),
        audit: domainAudit(result),
      };
    },
    async execute(user, input) {
      const result = requireDomainMutationSuccess(
        await options.core(user, input, "execute"),
      );
      return {
        summary: options.completedSummary,
        data: result.data,
        audit: domainAudit(result),
      };
    },
  };
  return registerActionDefinition(definition);
}

function directoryCore(
  kind: "department" | "insurance" | "service",
  operation: "create" | "update" | "toggle" | "soft_delete" | "restore" | "permanent_delete",
): SettingsCore {
  return ((user, input, mode) =>
    operation === "create"
      ? createDirectoryMutation(user, kind, input, mode)
      : operation === "update"
        ? updateDirectoryMutation(user, kind, input, mode)
        : directoryLifecycleMutation(user, kind, operation, input, mode)) as SettingsCore;
}

const directoryDefinitions = (
  kind: "department" | "insurance" | "service",
  actionPrefix: "departments" | "insurance_providers" | "services",
  label: string,
  labelAr: string,
  createSchema: z.ZodType,
  updateSchema: z.ZodType,
): RegisteredActionDefinition[] => [
  mutationAction({
    id: `${actionPrefix}.create`, roles: SETTINGS_WRITE_ROLES, risk: "normal",
    schema: createSchema, labels: { en: `Create ${label}`, ar: `إنشاء ${labelAr}` },
    description: { en: `Create one clinic ${label}.`, ar: `إنشاء ${labelAr} واحد للعيادة.` },
    previewSummary: `Create this ${label}.`, completedSummary: `${label} created.`,
    core: directoryCore(kind, "create"),
  }),
  mutationAction({
    id: `${actionPrefix}.update`, roles: SETTINGS_WRITE_ROLES, risk: "normal",
    schema: updateSchema, labels: { en: `Update ${label}`, ar: `تحديث ${labelAr}` },
    description: { en: `Update one clinic ${label}.`, ar: `تحديث ${labelAr} واحد للعيادة.` },
    previewSummary: `Apply these ${label} changes.`, completedSummary: `${label} updated.`,
    core: directoryCore(kind, "update"),
  }),
  mutationAction({
    id: `${actionPrefix}.set_active`, roles: SETTINGS_WRITE_ROLES, risk: "normal",
    schema: settingsToggleSchema, labels: { en: `Set ${label} active state`, ar: `تعيين حالة ${labelAr}` },
    description: { en: `Activate or deactivate one clinic ${label}.`, ar: `تفعيل أو تعطيل ${labelAr} واحد.` },
    previewSummary: `Change this ${label}'s active state.`, completedSummary: `${label} active state updated.`,
    core: directoryCore(kind, "toggle"),
  }),
  mutationAction({
    id: `${actionPrefix}.soft_delete`, roles: SETTINGS_WRITE_ROLES, risk: "destructive",
    schema: settingsLifecycleSchema, labels: { en: `Move ${label} to trash`, ar: `نقل ${labelAr} إلى المهملات` },
    description: { en: `Soft-delete one clinic ${label}.`, ar: `حذف ${labelAr} واحد حذفاً مبدئياً.` },
    previewSummary: `Move this ${label} to trash.`, completedSummary: `${label} moved to trash.`,
    core: directoryCore(kind, "soft_delete"),
  }),
  mutationAction({
    id: `${actionPrefix}.restore`, roles: SETTINGS_WRITE_ROLES, risk: "normal",
    schema: settingsLifecycleSchema, labels: { en: `Restore ${label}`, ar: `استعادة ${labelAr}` },
    description: { en: `Restore one trashed clinic ${label}.`, ar: `استعادة ${labelAr} واحد من المهملات.` },
    previewSummary: `Restore this ${label}.`, completedSummary: `${label} restored.`,
    core: directoryCore(kind, "restore"),
  }),
  mutationAction({
    id: `${actionPrefix}.permanent_delete`, roles: SETTINGS_WRITE_ROLES, risk: "destructive",
    schema: settingsLifecycleSchema, labels: { en: `Permanently delete ${label}`, ar: `حذف ${labelAr} نهائياً` },
    description: { en: `Permanently delete one already-trashed clinic ${label}.`, ar: `حذف ${labelAr} موجود في المهملات نهائياً.` },
    previewSummary: `Permanently delete this ${label}.`, completedSummary: `${label} permanently deleted.`,
    core: directoryCore(kind, "permanent_delete"),
  }),
];

export const SETTINGS_ACTION_DEFINITIONS: readonly RegisteredActionDefinition[] = [
  mutationAction({
    id: "staff.create", roles: SETTINGS_WRITE_ROLES, risk: "sensitive",
    schema: staffCreateNonPrivilegedActionSchema, labels: { en: "Create staff member", ar: "إنشاء موظف" },
    description: { en: "Create a receptionist, doctor, or assistant account without changing an existing user's role or permissions.", ar: "إنشاء حساب موظف استقبال أو طبيب أو مساعد دون تغيير دور أو صلاحيات مستخدم حالي." },
    previewSummary: "Create this non-privileged staff account. A server-generated password will be shown once after confirmation and never stored in the transcript or audit.",
    completedSummary: "Staff account created.", core: createStaffMutation as SettingsCore,
  }),
  mutationAction({
    id: "staff.update_profile", roles: SETTINGS_WRITE_ROLES, risk: "normal",
    schema: staffProfileActionSchema, labels: { en: "Update staff profile", ar: "تحديث ملف الموظف" },
    description: { en: "Update a staff member's name and phone only.", ar: "تحديث اسم الموظف وهاتفه فقط." },
    previewSummary: "Apply these non-privileged staff profile changes.", completedSummary: "Staff profile updated.",
    core: updateStaffProfileMutation as SettingsCore,
  }),
  ...directoryDefinitions("department", "departments", "department", "قسم", departmentCreateActionSchema, departmentUpdateActionSchema),
  ...directoryDefinitions("insurance", "insurance_providers", "insurance provider", "جهة تأمين", insuranceCreateActionSchema, insuranceUpdateActionSchema),
  ...directoryDefinitions("service", "services", "service", "خدمة", serviceCreateActionSchema, serviceUpdateActionSchema),
  mutationAction({
    id: "clinic.update_profile", roles: SETTINGS_WRITE_ROLES, risk: "normal",
    schema: clinicUpdateActionSchema, labels: { en: "Update clinic profile", ar: "تحديث ملف العيادة" },
    description: { en: "Update non-security clinic identity, contact, and branding fields.", ar: "تحديث هوية العيادة وبيانات الاتصال والعلامة التجارية غير الأمنية." },
    previewSummary: "Apply these clinic profile changes.", completedSummary: "Clinic profile updated.", core: updateClinicMutation as SettingsCore,
  }),
  mutationAction({
    id: "clinic.update_reminders", roles: SETTINGS_WRITE_ROLES, risk: "normal",
    schema: reminderSettingsSchema, labels: { en: "Update appointment reminders", ar: "تحديث تذكيرات المواعيد" },
    description: { en: "Enable or disable clinic appointment reminders.", ar: "تفعيل أو تعطيل تذكيرات مواعيد العيادة." },
    previewSummary: "Change the clinic reminder setting.", completedSummary: "Appointment reminder setting updated.", core: updateReminderSettingsMutation as SettingsCore,
  }),
  mutationAction({
    id: "clinic.update_invoice_followups", roles: SETTINGS_WRITE_ROLES, risk: "normal",
    schema: invoiceFollowupSettingsSchema, labels: { en: "Update invoice follow-ups", ar: "تحديث متابعات الفواتير" },
    description: { en: "Configure overdue-invoice follow-up timing and email text.", ar: "إعداد توقيت متابعة الفواتير المتأخرة ونص البريد." },
    previewSummary: "Apply these invoice follow-up settings.", completedSummary: "Invoice follow-up settings updated.", core: updateInvoiceFollowupSettingsMutation as SettingsCore,
  }),
  mutationAction({
    id: "clinic_working_hours.upsert", roles: SETTINGS_ADMIN_ROLES, risk: "normal",
    schema: clinicWorkingHoursActionSchema, labels: { en: "Update clinic working hours", ar: "تحديث ساعات عمل العيادة" },
    description: { en: "Replace the clinic's weekly working-hour shifts.", ar: "استبدال ورديات ساعات عمل العيادة الأسبوعية." },
    previewSummary: "Replace clinic working hours with these shifts.", completedSummary: "Clinic working hours updated.", core: upsertClinicWorkingHoursMutation as SettingsCore,
  }),
  mutationAction({
    id: "staff_schedules.upsert", roles: SETTINGS_ADMIN_ROLES, risk: "normal",
    schema: staffScheduleActionSchema, labels: { en: "Update staff schedule", ar: "تحديث جدول الموظف" },
    description: { en: "Replace one staff member's weekly schedule within clinic working hours.", ar: "استبدال جدول موظف أسبوعي ضمن ساعات عمل العيادة." },
    previewSummary: "Replace this staff schedule.", completedSummary: "Staff schedule updated.", core: upsertStaffScheduleMutation as SettingsCore,
  }),
];
