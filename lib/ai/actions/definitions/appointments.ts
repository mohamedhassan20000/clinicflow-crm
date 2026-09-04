import "server-only";

import {
  registerActionDefinition,
  type ActionDefinition,
  type RegisteredActionDefinition,
} from "@/lib/ai/actions/types";
import {
  domainAudit,
  requireDomainMutationSuccess,
  scalarChanges,
} from "@/lib/ai/actions/definitions/domain-shared";
import {
  APPOINTMENT_CREATE_ROLES,
  APPOINTMENT_DELETE_ROLES,
  APPOINTMENT_REPLACE_ROLES,
  APPOINTMENT_UNDO_ROLES,
  appointmentConflictSchema,
  appointmentIdSchema,
  appointmentStatusSchema,
  appointmentUndoSchema,
  arriveAppointmentMutation,
  confirmAndDisplaceAppointmentsMutation,
  createAppointmentMutation,
  dismissDisplacedAppointmentMutation,
  permanentDeleteAppointmentMutation,
  replaceAppointmentMutation,
  restoreAppointmentMutation,
  softDeleteAppointmentMutation,
  startAppointmentSessionMutation,
  undoAppointmentStatusMutation,
  updateAppointmentStatusMutation,
} from "@/lib/appointments/mutations";
import {
  appointmentSchema,
  replaceAppointmentSchema,
} from "@/lib/validations/appointment";

function changesFromAudit(
  result: ReturnType<typeof requireDomainMutationSuccess>,
  fields: readonly string[],
) {
  return scalarChanges(
    result.audit.before as Record<string, unknown> | undefined,
    result.audit.after as Record<string, unknown> | undefined,
    fields,
  );
}

function relationName(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Unknown";
  const name = (value as { full_name?: unknown }).full_name;
  return typeof name === "string" && name.trim() ? name : "Unknown";
}

export function appointmentIdentifier(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "Unknown appointment";
  }
  const row = value as Record<string, unknown>;
  const patient = relationName(row.patients);
  const doctor = relationName(row.profiles);
  const scheduledAt =
    typeof row.scheduled_at === "string" ? row.scheduled_at : "unscheduled";
  const id = typeof row.id === "string" ? row.id : "unknown id";
  return `${patient} with ${doctor} at ${scheduledAt} (${id})`;
}

const createAppointment: ActionDefinition = {
  id: "appointments.create",
  roles: APPOINTMENT_CREATE_ROLES,
  requiredFeatures: ["ai.write_scheduling"],
  risk: "normal",
  pageSlug: "appointments",
  inputSchema: appointmentSchema,
  labels: { en: "Create appointment", ar: "إنشاء موعد" },
  description: {
    en: "Create an appointment using the same availability and reference checks as the booking form.",
    ar: "إنشاء موعد باستخدام فحوص التوفر والمراجع نفسها المستخدمة في نموذج الحجز.",
  },
  inputDescription: {
    en: "Patient, doctor, department, time, duration, insurance, package, and notes.",
    ar: "المريض والطبيب والقسم والوقت والمدة والتأمين والباقة والملاحظات.",
  },
  async preview(user, input) {
    const result = requireDomainMutationSuccess(
      await createAppointmentMutation(user, input, "preview"),
    );
    return {
      title: "Create appointment",
      summary: "Create this appointment and notify the patient.",
      changes: changesFromAudit(result, [
        "patient_id",
        "doctor_id",
        "department_id",
        "scheduled_at",
        "duration_minutes",
        "insurance_provider_id",
        "package_id",
        "notes",
        "status",
      ]),
      audit: domainAudit(result),
    };
  },
  async execute(user, input) {
    const result = requireDomainMutationSuccess(
      await createAppointmentMutation(user, input, "execute"),
    );
    return {
      summary: "Appointment created and patient notification queued where configured.",
      data: { appointment_id: result.data.appointment_id },
      audit: domainAudit(result),
    };
  },
};

const replaceAppointment: ActionDefinition = {
  ...createAppointment,
  id: "appointments.replace",
  roles: APPOINTMENT_REPLACE_ROLES,
  inputSchema: replaceAppointmentSchema,
  labels: { en: "Replace appointment", ar: "استبدال الموعد" },
  description: {
    en: "Replace one future open appointment with a linked appointment at a new slot.",
    ar: "استبدال موعد مستقبلي مفتوح بموعد مرتبط في وقت جديد.",
  },
  async preview(user, input) {
    const result = requireDomainMutationSuccess(
      await replaceAppointmentMutation(user, input, "preview"),
    );
    return {
      title: "Replace appointment",
      summary: "Mark the original as replaced and create the linked appointment.",
      changes: changesFromAudit(result, [
        "doctor_id",
        "department_id",
        "scheduled_at",
        "duration_minutes",
        "notes",
        "status",
      ]),
      audit: domainAudit(result),
    };
  },
  async execute(user, input) {
    const result = requireDomainMutationSuccess(
      await replaceAppointmentMutation(user, input, "execute"),
    );
    return {
      summary: "Appointment replaced.",
      data: { appointment_id: result.data.appointment_id },
      audit: domainAudit(result),
    };
  },
};

const updateStatus: ActionDefinition = {
  id: "appointments.update_status",
  roles: APPOINTMENT_CREATE_ROLES,
  requiredFeatures: ["ai.write_scheduling"],
  risk: "sensitive",
  pageSlug: "appointments",
  inputSchema: appointmentStatusSchema,
  labels: { en: "Update appointment status", ar: "تحديث حالة الموعد" },
  description: {
    en: "Confirm, cancel, or mark one appointment as no-show.",
    ar: "تأكيد موعد واحد أو إلغاؤه أو اعتباره متغيباً.",
  },
  inputDescription: {
    en: "Appointment id, target status, and required reason for cancellation/no-show.",
    ar: "معرف الموعد والحالة المستهدفة والسبب المطلوب للإلغاء أو التغيب.",
  },
  async preview(user, input) {
    const result = requireDomainMutationSuccess(
      await updateAppointmentStatusMutation(user, input, "preview"),
    );
    return {
      title: "Update appointment status",
      summary: "Apply this appointment status transition.",
      changes: changesFromAudit(result, [
        "status",
        "cancellation_reason",
        "no_show_reason",
      ]),
      audit: domainAudit(result),
    };
  },
  async execute(user, input) {
    const result = requireDomainMutationSuccess(
      await updateAppointmentStatusMutation(user, input, "execute"),
    );
    return {
      summary: `Appointment marked ${result.data.status}.`,
      data: {
        appointment_id: result.data.appointment_id,
        status: result.data.status,
      },
      audit: domainAudit(result),
    };
  },
};

function idAction(options: {
  id: string;
  roles: readonly (typeof APPOINTMENT_REPLACE_ROLES)[number][];
  risk: "normal" | "sensitive" | "destructive";
  label: { en: string; ar: string };
  description: { en: string; ar: string };
  previewSummary: string;
  executeSummary: string;
  core: typeof softDeleteAppointmentMutation;
}): ActionDefinition {
  return {
    id: options.id,
    roles: options.roles,
    requiredFeatures: ["ai.write_scheduling"],
    risk: options.risk,
    pageSlug: "appointments",
    inputSchema: appointmentIdSchema,
    labels: options.label,
    description: options.description,
    inputDescription: { en: "Appointment id.", ar: "معرف الموعد." },
    async preview(user, input) {
      const result = requireDomainMutationSuccess(
        await options.core(user, input, "preview"),
      );
      return {
        title: options.label.en,
        summary: options.previewSummary,
        changes: [
          {
            label: "appointment",
            before: appointmentIdentifier(result.audit.before),
            after:
              result.audit.after === null
                ? "Permanently removed"
                : appointmentIdentifier(result.audit.after),
            identifiesRecord: true,
          },
          ...changesFromAudit(result, [
            "status",
            "deleted_at",
            "displaced_at",
          ]),
        ],
        audit: domainAudit(result),
      };
    },
    async execute(user, input) {
      const result = requireDomainMutationSuccess(
        await options.core(user, input, "execute"),
      );
      return {
        summary: options.executeSummary,
        data: { appointment_id: result.data.appointment_id },
        audit: domainAudit(result),
      };
    },
  };
}

const softDelete = idAction({
  id: "appointments.soft_delete",
  roles: APPOINTMENT_DELETE_ROLES,
  risk: "destructive",
  label: { en: "Move appointment to trash", ar: "نقل الموعد إلى المهملات" },
  description: {
    en: "Soft-delete one uncharged appointment that has not arrived.",
    ar: "حذف موعد واحد غير محصل ولم يصل صاحبه حذفاً مؤقتاً.",
  },
  previewSummary: "Move this appointment to trash.",
  executeSummary: "Appointment moved to trash.",
  core: softDeleteAppointmentMutation,
});

const restore = idAction({
  id: "appointments.restore",
  roles: APPOINTMENT_DELETE_ROLES,
  risk: "normal",
  label: { en: "Restore appointment", ar: "استعادة الموعد" },
  description: {
    en: "Restore one appointment from trash.",
    ar: "استعادة موعد واحد من المهملات.",
  },
  previewSummary: "Restore this appointment from trash.",
  executeSummary: "Appointment restored.",
  core: restoreAppointmentMutation,
});

const arrive = idAction({
  id: "appointments.arrive",
  roles: APPOINTMENT_CREATE_ROLES,
  risk: "normal",
  label: { en: "Mark appointment arrived", ar: "تسجيل وصول الموعد" },
  description: {
    en: "Move one confirmed appointment to arrived.",
    ar: "نقل موعد مؤكد واحد إلى حالة الوصول.",
  },
  previewSummary: "Mark this confirmed appointment as arrived.",
  executeSummary: "Appointment marked arrived.",
  core: arriveAppointmentMutation,
});

const startSession = idAction({
  id: "appointments.start_session",
  roles: ["doctor"],
  risk: "normal",
  label: { en: "Start appointment session", ar: "بدء جلسة الموعد" },
  description: {
    en: "Start an arrived appointment assigned to the current doctor.",
    ar: "بدء موعد وصل ومُسند إلى الطبيب الحالي.",
  },
  previewSummary: "Start this clinical session.",
  executeSummary: "Appointment session started.",
  core: startAppointmentSessionMutation,
});

const permanentDelete = idAction({
  id: "appointments.permanent_delete",
  roles: APPOINTMENT_DELETE_ROLES,
  risk: "destructive",
  label: { en: "Permanently delete appointment", ar: "حذف الموعد نهائياً" },
  description: {
    en: "Permanently delete one appointment already in trash.",
    ar: "حذف موعد واحد موجود في المهملات نهائياً.",
  },
  previewSummary: "Permanently delete this exact appointment.",
  executeSummary: "Appointment permanently deleted.",
  core: permanentDeleteAppointmentMutation,
});

const dismissDisplaced = idAction({
  id: "appointments.dismiss_displaced",
  roles: APPOINTMENT_DELETE_ROLES,
  risk: "destructive",
  label: { en: "Dismiss displaced appointment", ar: "إزالة الموعد المزاح" },
  description: {
    en: "Permanently dismiss one appointment from the rebook queue.",
    ar: "إزالة موعد واحد نهائياً من قائمة إعادة الحجز.",
  },
  previewSummary: "Permanently dismiss this displaced appointment.",
  executeSummary: "Displaced appointment dismissed.",
  core: dismissDisplacedAppointmentMutation,
});

const undoStatus: ActionDefinition = {
  ...updateStatus,
  id: "appointments.undo_status",
  roles: APPOINTMENT_UNDO_ROLES,
  risk: "normal",
  inputSchema: appointmentUndoSchema,
  labels: { en: "Undo appointment status", ar: "التراجع عن حالة الموعد" },
  description: {
    en: "Undo an appointment to an allowed earlier status.",
    ar: "إرجاع الموعد إلى حالة سابقة مسموح بها.",
  },
  async preview(user, input) {
    const result = requireDomainMutationSuccess(
      await undoAppointmentStatusMutation(user, input, "preview"),
    );
    return {
      title: "Undo appointment status",
      summary: "Return this appointment to the selected earlier status.",
      changes: changesFromAudit(result, ["status"]),
      audit: domainAudit(result),
    };
  },
  async execute(user, input) {
    const result = requireDomainMutationSuccess(
      await undoAppointmentStatusMutation(user, input, "execute"),
    );
    return {
      summary: "Appointment status restored.",
      data: {
        appointment_id: result.data.appointment_id,
        status: result.data.status,
      },
      audit: domainAudit(result),
    };
  },
};

const confirmAndDisplace: ActionDefinition = {
  ...updateStatus,
  id: "appointments.confirm_and_displace",
  risk: "bulk",
  inputSchema: appointmentConflictSchema,
  labels: {
    en: "Confirm and displace conflicts",
    ar: "تأكيد الموعد وإزاحة التعارضات",
  },
  description: {
    en: "Confirm one pending appointment and move up to 25 exact conflicting pending appointments to the rebook queue.",
    ar: "تأكيد موعد معلق واحد ونقل حتى 25 موعداً متعارضاً محدداً إلى قائمة إعادة الحجز.",
  },
  async preview(user, input) {
    const result = requireDomainMutationSuccess(
      await confirmAndDisplaceAppointmentsMutation(user, input, "preview"),
    );
    const before = result.audit.before as {
      target?: unknown;
      conflicts?: unknown[];
    } | undefined;
    const after = result.audit.after as {
      target?: unknown;
      conflicts?: unknown[];
    } | undefined;
    const conflictChanges = (before?.conflicts ?? []).map((conflict, index) => ({
      label: `conflicting appointment ${index + 1}`,
      before: appointmentIdentifier(conflict),
      after: appointmentIdentifier(after?.conflicts?.[index]),
      identifiesRecord: true as const,
    }));
    return {
      title: "Confirm and displace conflicts",
      summary: `Confirm this appointment and displace ${(input as { conflicting_ids: string[] }).conflicting_ids.length} exact conflict(s).`,
      changes: [
        {
          label: "target appointment",
          before: appointmentIdentifier(before?.target),
          after: appointmentIdentifier(after?.target),
          identifiesRecord: true,
        },
        ...conflictChanges,
      ],
      audit: domainAudit(result),
    };
  },
  async execute(user, input) {
    const result = requireDomainMutationSuccess(
      await confirmAndDisplaceAppointmentsMutation(user, input, "execute"),
    );
    return {
      summary: "Appointment confirmed and listed conflicts displaced.",
      data: { appointment_id: result.data.appointment_id },
      audit: domainAudit(result),
    };
  },
};

export const APPOINTMENT_ACTION_DEFINITIONS: readonly RegisteredActionDefinition[] =
  [
    createAppointment,
    replaceAppointment,
    updateStatus,
    softDelete,
    restore,
    undoStatus,
    arrive,
    startSession,
    permanentDelete,
    confirmAndDisplace,
    dismissDisplaced,
  ].map(registerActionDefinition);
