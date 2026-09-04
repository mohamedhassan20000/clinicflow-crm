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
  deleteFollowupMutation,
  FOLLOWUP_DELETE_ROLES,
  FOLLOWUP_WRITE_ROLES,
  followupDeleteSchema,
  followupRecordSchema,
  followupRestoreSchema,
  followupUpdateSchema,
  recordFollowupMutation,
  restoreFollowupMutation,
  updateFollowupMutation,
} from "@/lib/followups/mutations";

const recordFollowup: ActionDefinition = {
  id: "followups.record",
  roles: FOLLOWUP_WRITE_ROLES,
  requiredFeatures: ["ai.write_scheduling"],
  risk: "normal",
  pageSlug: "followups",
  inputSchema: followupRecordSchema,
  labels: { en: "Record follow-up", ar: "تسجيل متابعة" },
  description: {
    en: "Record the outcome of a completed appointment follow-up.",
    ar: "تسجيل نتيجة متابعة موعد مكتمل.",
  },
  inputDescription: {
    en: "Appointment, patient, outcome, and optional notes.",
    ar: "الموعد والمريض والنتيجة وملاحظات اختيارية.",
  },
  async preview(user, input) {
    const result = requireDomainMutationSuccess(
      await recordFollowupMutation(user, input, "preview"),
    );
    return {
      title: "Record follow-up",
      summary: "Record this follow-up outcome.",
      changes: scalarChanges(null, result.data as never, [
        "patient_id",
        "appointment_id",
        "outcome",
        "notes",
      ]),
      audit: domainAudit(result),
    };
  },
  async execute(user, input) {
    const result = requireDomainMutationSuccess(
      await recordFollowupMutation(user, input, "execute"),
    );
    return {
      summary: "Follow-up recorded.",
      data: { followup_id: result.data.id },
      audit: domainAudit(result),
    };
  },
};

const updateFollowup: ActionDefinition = {
  ...recordFollowup,
  id: "followups.update",
  inputSchema: followupUpdateSchema,
  labels: { en: "Update follow-up", ar: "تحديث المتابعة" },
  description: {
    en: "Update an existing follow-up outcome and notes.",
    ar: "تحديث نتيجة وملاحظات متابعة موجودة.",
  },
  async preview(user, input) {
    const result = requireDomainMutationSuccess(
      await updateFollowupMutation(user, input, "preview"),
    );
    return {
      title: "Update follow-up",
      summary: "Apply these changes to the follow-up.",
      changes: scalarChanges(
        result.audit.before as Record<string, unknown>,
        result.audit.after as Record<string, unknown>,
        ["outcome", "notes"],
      ),
      audit: domainAudit(result),
    };
  },
  async execute(user, input) {
    const result = requireDomainMutationSuccess(
      await updateFollowupMutation(user, input, "execute"),
    );
    return {
      summary: "Follow-up updated.",
      data: { followup_id: result.data.id },
      audit: domainAudit(result),
    };
  },
};

const deleteFollowup: ActionDefinition = {
  id: "followups.delete",
  roles: FOLLOWUP_DELETE_ROLES,
  requiredFeatures: ["ai.write_scheduling"],
  risk: "destructive",
  pageSlug: "followups",
  inputSchema: followupDeleteSchema,
  labels: { en: "Delete follow-up", ar: "حذف المتابعة" },
  description: {
    en: "Delete one follow-up record.",
    ar: "حذف سجل متابعة واحد.",
  },
  inputDescription: { en: "Follow-up id.", ar: "معرف المتابعة." },
  async preview(user, input) {
    const result = requireDomainMutationSuccess(
      await deleteFollowupMutation(user, input, "preview"),
    );
    return {
      title: "Delete follow-up",
      summary: "Permanently delete this follow-up record.",
      changes: [
        {
          label: "follow-up",
          before: `${result.data.outcome} follow-up (record ${result.data.id})`,
          after: "Permanently removed",
          identifiesRecord: true,
        },
        ...scalarChanges(result.data as never, null, [
          "patient_id",
          "appointment_id",
          "outcome",
          "notes",
        ]).map((change) =>
          change.label === "notes" && typeof change.before === "string"
            ? { ...change, before: `Note: ${change.before}` }
            : change,
        ),
      ],
      audit: domainAudit(result),
    };
  },
  async execute(user, input) {
    const result = requireDomainMutationSuccess(
      await deleteFollowupMutation(user, input, "execute"),
    );
    return {
      summary: "Follow-up deleted.",
      data: { followup_id: result.data.id },
      audit: domainAudit(result),
    };
  },
};

const restoreFollowup: ActionDefinition = {
  ...deleteFollowup,
  id: "followups.restore",
  risk: "normal",
  inputSchema: followupRestoreSchema,
  labels: { en: "Restore follow-up", ar: "استعادة المتابعة" },
  description: {
    en: "Restore one previously deleted follow-up record.",
    ar: "استعادة سجل متابعة محذوف سابقاً.",
  },
  inputDescription: {
    en: "The exact deleted follow-up snapshot.",
    ar: "النسخة الدقيقة لسجل المتابعة المحذوف.",
  },
  async preview(user, input) {
    const result = requireDomainMutationSuccess(
      await restoreFollowupMutation(user, input, "preview"),
    );
    return {
      title: "Restore follow-up",
      summary: "Restore this follow-up record.",
      changes: scalarChanges(null, result.data as never, [
        "patient_id",
        "appointment_id",
        "outcome",
        "notes",
      ]),
      audit: domainAudit(result),
    };
  },
  async execute(user, input) {
    const result = requireDomainMutationSuccess(
      await restoreFollowupMutation(user, input, "execute"),
    );
    return {
      summary: "Follow-up restored.",
      data: { followup_id: result.data.id },
      audit: domainAudit(result),
    };
  },
};

export const FOLLOWUP_ACTION_DEFINITIONS: readonly RegisteredActionDefinition[] =
  [recordFollowup, updateFollowup, deleteFollowup, restoreFollowup].map(
    registerActionDefinition,
  );
