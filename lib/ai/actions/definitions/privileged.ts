import "server-only";

import type { z } from "zod";
import { sameCanonicalValue } from "@/lib/ai/actions/canonical";
import {
  domainAudit,
  requireDomainMutationSuccess,
} from "@/lib/ai/actions/definitions/domain-shared";
import { ActionBusinessRuleError } from "@/lib/ai/actions/errors";
import { isPrimaryClinicAdmin } from "@/lib/primary-admin";
import {
  registerActionDefinition,
  type ActionDefinition,
  type ActionPreviewChange,
  type RegisteredActionDefinition,
} from "@/lib/ai/actions/types";
import type {
  DomainMutationMode,
  DomainMutationResult,
} from "@/lib/domain-mutations";
import type { AuthedUser, UserRole } from "@/lib/rbac";
import {
  aiPermissionActionSchema,
  changeStaffRoleMutation,
  pagePermissionActionSchema,
  PRIVILEGED_ADMIN_ONLY_ROLES,
  PRIVILEGED_STAFF_MANAGEMENT_ROLES,
  reportPermissionActionSchema,
  resetStaffPasswordMutation,
  setAiPermissionMutation,
  setPagePermissionMutation,
  setReportPermissionMutation,
  setStaffActiveMutation,
  staffActiveActionSchema,
  staffLifecycleActionSchema,
  staffLifecycleMutation,
  staffPasswordResetActionSchema,
  staffRoleChangeActionSchema,
} from "@/lib/settings/mutations";

type PrivilegedCore = (
  user: AuthedUser,
  input: unknown,
  mode?: DomainMutationMode,
) => Promise<DomainMutationResult<Record<string, unknown>>>;

function display(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(String).join(", ") || "None";
  return "Changed";
}

const LABELS: Record<string, string> = {
  role: "Role",
  department_id: "Department",
  supervising_doctor_ids: "Supervising doctors",
  is_active: "Active account",
  is_deleted: "Deleted account",
  deleted_at: "Deleted state",
  must_change_password: "Must change password",
  password: "Temporary password",
  page_slug: "Page",
  report_id: "Report",
  permission_key: "AI permission",
  is_visible: "Visible",
  granted: "Granted",
};

function explicitChanges(
  result: ReturnType<typeof requireDomainMutationSuccess>,
): ActionPreviewChange[] {
  const before =
    result.audit.before && typeof result.audit.before === "object"
      ? (result.audit.before as Record<string, unknown>)
      : {};
  const after =
    result.audit.after && typeof result.audit.after === "object"
      ? (result.audit.after as Record<string, unknown>)
      : {};
  const data = result.data as Record<string, unknown>;
  const id = String(before.id ?? after.id ?? data.staff_id ?? "unknown");
  const name = String(before.full_name ?? after.full_name ?? "Unknown staff member");
  // F2: structural, not reference, comparison. `supervising_doctor_ids` is read
  // as a fresh array on both sides, so `!==` classified an unchanged list as a
  // change and rendered a phantom row in the attestation the admin
  // re-authenticates against. The canonicaliser used here is the same one the
  // confirm token's before/after digests are built from.
  const fields = Array.from(
    new Set([...Object.keys(before), ...Object.keys(after)]),
  ).filter(
    (field) =>
      field !== "id" &&
      field !== "full_name" &&
      !sameCanonicalValue(before[field], after[field]),
  );
  return [
    {
      label: "Staff member",
      before: `${name} (user ${id})`,
      after: `${name} (user ${id})`,
      identifiesRecord: true,
    },
    ...fields.map((field) => ({
      label: LABELS[field] ?? field,
      before: display(before[field]),
      after: display(after[field]),
    })),
  ];
}

/**
 * F3: the primary-admin protection is enforced **here**, at the Assistant
 * boundary, and nowhere else. The shared settings cores stay byte-identical to
 * `actions/settings-legacy.ts` so Settings → Staff keeps every capability it
 * had; only the Assistant refuses to touch the founding administrator, which is
 * the anti-escalation posture §11.1(4) asks for without narrowing the UI.
 */
type PrimaryAdminBoundaryGuard<T> = {
  /** Whether this specific requested change is the protected kind. */
  blocks: (input: T) => boolean;
  /** Operation-specific message key — never the "cannot be customized" copy. */
  code: string;
};

async function assertPrimaryAdminBoundary<T>(
  user: AuthedUser,
  input: T,
  targetUserId: string,
  guard: PrimaryAdminBoundaryGuard<T> | undefined,
): Promise<void> {
  if (!guard || !guard.blocks(input)) return;
  if (await isPrimaryClinicAdmin(targetUserId, user.clinicId)) {
    throw new ActionBusinessRuleError(guard.code);
  }
}

function privilegedAction<T>(options: {
  id: string;
  roles: readonly UserRole[];
  schema: z.ZodType<T>;
  labels: { en: string; ar: string };
  description: { en: string; ar: string };
  previewSummary: string;
  completedSummary: string;
  core: PrivilegedCore;
  targetUserId: (input: T) => string;
  primaryAdminGuard?: PrimaryAdminBoundaryGuard<T>;
}): RegisteredActionDefinition {
  const definition: ActionDefinition<T> = {
    id: options.id,
    roles: options.roles,
    requiredFeatures: ["ai.write_privileged"],
    risk: "privileged",
    pageSlug: "settings",
    inputSchema: options.schema,
    labels: options.labels,
    description: options.description,
    inputDescription: {
      en: "The exact target user and requested privileged before-to-after change.",
      ar: "المستخدم المستهدف بدقة والتغيير المطلوب من الحالة السابقة إلى اللاحقة.",
    },
    privilegedTargetUserId: options.targetUserId,
    async preview(user, input) {
      await assertPrimaryAdminBoundary(
        user,
        input,
        options.targetUserId(input),
        options.primaryAdminGuard,
      );
      const result = requireDomainMutationSuccess(
        await options.core(user, input, "preview"),
      );
      return {
        title: options.labels.en,
        summary: options.previewSummary,
        changes: explicitChanges(result),
        audit: domainAudit(result),
      };
    },
    async execute(user, input) {
      await assertPrimaryAdminBoundary(
        user,
        input,
        options.targetUserId(input),
        options.primaryAdminGuard,
      );
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

const staffId = (input: { staff_id: string }) => input.staff_id;
const targetUserId = (input: { target_user_id: string }) =>
  input.target_user_id;

export const PRIVILEGED_ACTION_DEFINITIONS: readonly RegisteredActionDefinition[] = [
  privilegedAction({
    id: "staff.change_role",
    roles: PRIVILEGED_ADMIN_ONLY_ROLES,
    schema: staffRoleChangeActionSchema,
    labels: { en: "Change staff role", ar: "تغيير دور الموظف" },
    description: {
      en: "Change one staff member's ClinicFlow role and synchronize role-dependent assignments and page defaults.",
      ar: "تغيير دور موظف واحد ومزامنة الإشراف وصفحات الدور الافتراضية.",
    },
    previewSummary: "Review the exact staff role change. Credential re-entry is required.",
    completedSummary: "Staff role changed and role-dependent settings synchronized.",
    core: changeStaffRoleMutation as PrivilegedCore,
    targetUserId: staffId,
    primaryAdminGuard: {
      blocks: (input) => input.role !== "admin",
      code: "settings.thePrimaryClinicAdminRoleCannotBeChanged",
    },
  }),
  privilegedAction({
    id: "staff.set_active",
    roles: PRIVILEGED_STAFF_MANAGEMENT_ROLES,
    schema: staffActiveActionSchema,
    labels: { en: "Change staff account status", ar: "تغيير حالة حساب الموظف" },
    description: {
      en: "Activate or deactivate one staff account within the UI's manager restrictions.",
      ar: "تفعيل أو تعطيل حساب موظف واحد ضمن قيود المدير في الواجهة.",
    },
    previewSummary: "Review the exact staff account status change. Credential re-entry is required.",
    completedSummary: "Staff account status changed.",
    core: setStaffActiveMutation as PrivilegedCore,
    targetUserId: staffId,
    primaryAdminGuard: {
      blocks: (input) => input.is_active === false,
      code: "settings.thePrimaryClinicAdminCannotBeDeactivated",
    },
  }),
  privilegedAction({
    id: "staff.soft_delete",
    roles: PRIVILEGED_STAFF_MANAGEMENT_ROLES,
    schema: staffLifecycleActionSchema,
    labels: { en: "Move staff account to trash", ar: "نقل حساب الموظف إلى المهملات" },
    description: {
      en: "Deactivate and soft-delete one staff account.",
      ar: "تعطيل حساب موظف واحد وحذفه مبدئياً.",
    },
    previewSummary: "Review the exact staff account deletion. Credential re-entry is required.",
    completedSummary: "Staff account moved to trash.",
    core: ((user, input, mode) =>
      staffLifecycleMutation(user, "soft_delete", input, mode)) as PrivilegedCore,
    targetUserId: staffId,
    primaryAdminGuard: {
      blocks: () => true,
      code: "settings.thePrimaryClinicAdminCannotBeDeleted",
    },
  }),
  privilegedAction({
    id: "staff.restore",
    roles: PRIVILEGED_STAFF_MANAGEMENT_ROLES,
    schema: staffLifecycleActionSchema,
    labels: { en: "Restore staff account", ar: "استعادة حساب الموظف" },
    description: {
      en: "Restore and reactivate one trashed staff account.",
      ar: "استعادة حساب موظف من المهملات وإعادة تفعيله.",
    },
    previewSummary: "Review the exact staff account restoration. Credential re-entry is required.",
    completedSummary: "Staff account restored.",
    core: ((user, input, mode) =>
      staffLifecycleMutation(user, "restore", input, mode)) as PrivilegedCore,
    targetUserId: staffId,
  }),
  privilegedAction({
    id: "staff.permanent_delete",
    roles: PRIVILEGED_STAFF_MANAGEMENT_ROLES,
    schema: staffLifecycleActionSchema,
    labels: { en: "Permanently delete staff account", ar: "حذف حساب الموظف نهائياً" },
    description: {
      en: "Permanently delete one already-trashed staff account; bulk deletion is not available.",
      ar: "حذف حساب موظف موجود في المهملات نهائياً؛ الحذف الجماعي غير متاح.",
    },
    previewSummary: "Review the exact permanent staff deletion. Credential re-entry is required.",
    completedSummary: "Staff account permanently deleted.",
    core: ((user, input, mode) =>
      staffLifecycleMutation(user, "permanent_delete", input, mode)) as PrivilegedCore,
    targetUserId: staffId,
    primaryAdminGuard: {
      blocks: () => true,
      code: "settings.thePrimaryClinicAdminCannotBeDeleted",
    },
  }),
  privilegedAction({
    id: "staff.reset_password",
    roles: PRIVILEGED_STAFF_MANAGEMENT_ROLES,
    schema: staffPasswordResetActionSchema,
    labels: { en: "Reset staff password", ar: "إعادة تعيين كلمة مرور الموظف" },
    description: {
      en: "Generate a one-time staff password and require a password change at next sign-in.",
      ar: "إنشاء كلمة مرور مؤقتة للموظف وإلزامه بتغييرها عند تسجيل الدخول التالي.",
    },
    previewSummary: "Review the exact password-security change. Credential re-entry is required.",
    completedSummary: "A one-time staff password was generated and a password change is required at next sign-in.",
    core: resetStaffPasswordMutation as PrivilegedCore,
    targetUserId: staffId,
  }),
  privilegedAction({
    id: "page_permissions.set_visibility",
    roles: PRIVILEGED_ADMIN_ONLY_ROLES,
    schema: pagePermissionActionSchema,
    labels: { en: "Change page permission", ar: "تغيير صلاحية الصفحة" },
    description: {
      en: "Grant or revoke one role-valid page visibility permission for one staff member.",
      ar: "منح أو سحب ظهور صفحة صالحة للدور لموظف واحد.",
    },
    previewSummary: "Review the exact page visibility change. Credential re-entry is required.",
    completedSummary: "Page permission changed.",
    core: setPagePermissionMutation as PrivilegedCore,
    targetUserId,
  }),
  privilegedAction({
    id: "report_permissions.set_visibility",
    roles: PRIVILEGED_ADMIN_ONLY_ROLES,
    schema: reportPermissionActionSchema,
    labels: { en: "Change report permission", ar: "تغيير صلاحية التقرير" },
    description: {
      en: "Grant or revoke one role-authorized report visibility permission for one staff member.",
      ar: "منح أو سحب ظهور تقرير مصرح به للدور لموظف واحد.",
    },
    previewSummary: "Review the exact report visibility change. Credential re-entry is required.",
    completedSummary: "Report permission changed.",
    core: setReportPermissionMutation as PrivilegedCore,
    targetUserId,
  }),
  privilegedAction({
    id: "ai_permissions.set",
    roles: PRIVILEGED_ADMIN_ONLY_ROLES,
    schema: aiPermissionActionSchema,
    labels: { en: "Change AI permission", ar: "تغيير صلاحية الذكاء الاصطناعي" },
    description: {
      en: "Grant or revoke one applicable per-user AI permission without changing role or plan entitlement.",
      ar: "منح أو سحب صلاحية ذكاء اصطناعي فردية قابلة للتطبيق دون تغيير الدور أو اشتراك الخطة.",
    },
    previewSummary: "Review the exact AI permission change. Credential re-entry is required.",
    completedSummary: "AI permission changed.",
    core: setAiPermissionMutation as PrivilegedCore,
    targetUserId,
  }),
];
