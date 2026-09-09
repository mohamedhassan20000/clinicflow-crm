import "server-only";

import { randomBytes } from "node:crypto";
import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import {
  assertDomainMutationRole,
  domainFailure,
  domainSuccess,
  type DomainMutationMode,
  type DomainMutationResult,
} from "@/lib/domain-mutations";
import {
  auditShiftSummary,
  auditTemplateSummary,
  recordAdminAuditEvent,
} from "@/lib/audit/record";
import { getRolePageSlugs } from "@/lib/page-permissions";
import {
  PAGE_DEFINITIONS,
  type PageSlug,
} from "@/lib/page-permissions";
import { getPrimaryClinicAdminId, isPrimaryClinicAdmin } from "@/lib/primary-admin";
import {
  isReportId,
  reportDefaultVisibleForRole,
  reportsOpenableByRole,
} from "@/lib/reports/catalog";
import type { ClinicReportId } from "@/lib/ai/clinic-reports";
import {
  AI_USER_PERMISSION_KEYS,
  type AiUserPermissionKey,
} from "@/lib/ai/permission-keys";
import { AI_FINANCIAL_INSIGHTS_FEATURE } from "@/lib/ai/authorization";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { ensureClinicLogoCleaned } from "@/lib/images/clinic-logo-cleanup";
import { normalizePhone } from "@/lib/phone/registry";
import { canonicalClock, validateStaffInterval } from "@/lib/scheduling/clock";
import type { AuthedUser } from "@/lib/rbac";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { stripBlankDisplayNames } from "@/lib/settings/display-names";
import {
  clinicSchema,
  clinicWorkingHoursSchema,
  staffShiftTemplatesSchema,
  createStaffSchema,
  departmentSchema,
  doctorScheduleSchema,
  insuranceSchema,
  serviceSchema,
  staffProfileSectionSchema,
  updateStaffSchema,
} from "@/lib/validations/settings";

export const SETTINGS_WRITE_ROLES = ["admin", "manager"] as const;
export const SETTINGS_ADMIN_ROLES = ["admin"] as const;
export const STAFF_CREATE_NON_PRIVILEGED_ROLES = [
  "receptionist",
  "doctor",
  "assistant",
] as const;

export const staffCreateActionSchema = createStaffSchema;
export const staffCreateNonPrivilegedActionSchema = z
  .object({
    full_name: createStaffSchema.shape.full_name,
    email: createStaffSchema.shape.email,
    role: z.enum(STAFF_CREATE_NON_PRIVILEGED_ROLES),
    department_id: createStaffSchema.shape.department_id,
    supervising_doctor_ids: createStaffSchema.shape.supervising_doctor_ids,
    phone: createStaffSchema.shape.phone,
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.role === "assistant" &&
      (input.supervising_doctor_ids?.length ?? 0) === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["supervising_doctor_ids"],
        message: "validation.required",
      });
    }
  });
export const staffProfileActionSchema = z
  .object({ staff_id: z.string().uuid(), profile: staffProfileSectionSchema })
  .strict();
export const departmentCreateActionSchema = departmentSchema.strict();
export const departmentUpdateActionSchema = departmentSchema
  .extend({ department_id: z.string().uuid() })
  .strict();
export const insuranceCreateActionSchema = insuranceSchema.strict();
export const insuranceUpdateActionSchema = insuranceSchema
  .extend({ insurance_id: z.string().uuid() })
  .strict();
export const serviceCreateActionSchema = serviceSchema.strict();
export const serviceUpdateActionSchema = serviceSchema
  .extend({ service_id: z.string().uuid() })
  .strict();
export const settingsLifecycleSchema = z
  .object({ id: z.string().uuid() })
  .strict();
export const settingsToggleSchema = settingsLifecycleSchema.extend({
  is_active: z.boolean(),
});
export const clinicUpdateActionSchema = clinicSchema.strict();
export const reminderSettingsSchema = z
  .object({ enabled: z.boolean() })
  .strict();
export const invoiceFollowupSettingsSchema = z
  .object({
    enabled: z.boolean(),
    first_days: z.number().int().min(1).max(365),
    second_days: z.number().int().min(1).max(365),
    email_subject: z.string().trim().max(200).nullable().optional(),
    email_body: z.string().trim().max(2000).nullable().optional(),
  })
  .strict()
  .refine((value) => value.second_days > value.first_days, {
    path: ["second_days"],
    message: "validation.invalidFormat",
  });
export const clinicWorkingHoursActionSchema = z
  .object({ days: clinicWorkingHoursSchema })
  .strict();
export const staffScheduleActionSchema = z
  .object({ staff_id: z.string().uuid(), days: doctorScheduleSchema })
  .strict();
export const staffShiftTemplatesActionSchema = z
  .object({ templates: staffShiftTemplatesSchema })
  .strict();

const USER_ROLES = [
  "admin",
  "manager",
  "receptionist",
  "doctor",
  "assistant",
] as const;

export const staffRoleChangeActionSchema = z
  .object({
    staff_id: z.string().uuid(),
    role: z.enum(USER_ROLES),
    department_id: updateStaffSchema.shape.department_id,
    supervising_doctor_ids: updateStaffSchema.shape.supervising_doctor_ids,
  })
  .strict()
  .superRefine((input, context) => {
    if (
      input.role === "assistant" &&
      (input.supervising_doctor_ids?.length ?? 0) === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["supervising_doctor_ids"],
        message: "validation.required",
      });
    }
  });
export const staffUpdateActionSchema = z
  .object({
    staff_id: z.string().uuid(),
    values: updateStaffSchema,
  })
  .strict();
export const staffLifecycleActionSchema = z
  .object({ staff_id: z.string().uuid() })
  .strict();
export const staffActiveActionSchema = staffLifecycleActionSchema.extend({
  is_active: z.boolean(),
});
export const staffPasswordResetActionSchema = staffLifecycleActionSchema;
const staffPasswordResetCoreSchema = staffLifecycleActionSchema.extend({
  temporary_password: z
    .string()
    .min(8)
    .regex(/[A-Z]/)
    .regex(/[0-9]/)
    .optional(),
});
export const pagePermissionActionSchema = z
  .object({
    target_user_id: z.string().uuid(),
    page_slug: z.string().refine(
      (value): value is PageSlug =>
        PAGE_DEFINITIONS.some((page) => page.slug === value),
    ),
    is_visible: z.boolean(),
  })
  .strict();
export const reportPermissionActionSchema = z
  .object({
    target_user_id: z.string().uuid(),
    report_id: z.string().refine(isReportId),
    is_visible: z.boolean(),
  })
  .strict();
export const aiPermissionActionSchema = z
  .object({
    target_user_id: z.string().uuid(),
    permission_key: z.enum(AI_USER_PERMISSION_KEYS),
    granted: z.boolean(),
  })
  .strict();
/**
 * Bulk Customize-screen savers. These exist because the per-item privileged
 * core is the wrong shape for a bulk save: it *refuses* entries the UI is
 * expected to drop silently (dashboard, slugs/reports outside the target's
 * role), so looping it turns a routine save into a partial write reported as a
 * failure. These cores pre-filter exactly as the legacy server actions did and
 * then write once.
 */
export const pagePermissionBatchActionSchema = z
  .object({
    target_user_id: z.string().uuid(),
    changes: z
      .array(
        z.object({
          page_slug: z.string(),
          is_visible: z.boolean(),
        }),
      )
      .max(200),
  })
  .strict();
export const reportPermissionBatchActionSchema = z
  .object({
    target_user_id: z.string().uuid(),
    changes: z
      .array(
        z.object({
          report_id: z.string(),
          is_visible: z.boolean(),
        }),
      )
      .max(200),
  })
  .strict();

export const PRIVILEGED_STAFF_MANAGEMENT_ROLES = ["admin", "manager"] as const;
export const PRIVILEGED_ADMIN_ONLY_ROLES = ["admin"] as const;

export const AI_PERMISSION_GRANTABLE_ROLES: Record<
  AiUserPermissionKey,
  readonly AuthedUser["role"][]
> = {
  "ai.financial_insights": ["manager"],
};

type SettingsMutationData = {
  id?: string;
  staff_id?: string;
  status?: string;
  one_time_temporary_password?: string;
};

function serverGeneratedTemporaryPassword(): string {
  // 144 random bits plus fixed character classes required by the current auth
  // policy. This value exists only for the Auth call and one-time UI response.
  return `A1${randomBytes(18).toString("base64url")}`;
}

async function replaceAssistantAssignments(
  assistantId: string,
  role: string,
  doctorIds: string[],
) {
  const supabase = await createClient();
  const result = await supabase.rpc("replace_assistant_doctor_assignments", {
    p_assistant_id: assistantId,
    p_doctor_ids:
      role === "assistant" ? Array.from(new Set(doctorIds)) : [],
  });
  return !result.error;
}

async function seedDefaultPagePermissions(
  clinicId: string,
  userId: string,
  role: Parameters<typeof getRolePageSlugs>[0],
) {
  const admin = createClinicScopedAdminClient(clinicId);
  const rows = getRolePageSlugs(role).map((pageSlug) => ({
    user_id: userId,
    clinic_id: clinicId,
    page_slug: pageSlug,
    is_visible: true,
  }));
  const saved = await admin
    .from("user_page_permissions")
    .upsert(rows, { onConflict: "user_id,page_slug" });
  const missingPrimaryTable =
    saved.error?.code === "42P01" ||
    saved.error?.message?.toLowerCase().includes("user_page_permissions") ===
      true;
  if (!missingPrimaryTable) return !saved.error;

  for (const pageSlug of getRolePageSlugs(role)) {
    const removed = await admin
      .from("user_customizations")
      .delete()
      .eq("profile_id", userId)
      .eq("clinic_id", clinicId)
      .eq("feature", "_visible")
      .eq("page", pageSlug);
    if (removed.error) return false;
  }
  const fallback = await admin.from("user_customizations").upsert(
    getRolePageSlugs(role).map((pageSlug) => ({
      profile_id: userId,
      clinic_id: clinicId,
      feature: "_visible",
      page: pageSlug,
      access: "read_edit" as const,
    })),
    { onConflict: "profile_id,page,feature" },
  );
  return !fallback.error;
}

async function rollbackCreatedStaff(clinicId: string, staffId: string) {
  const admin = createClinicScopedAdminClient(clinicId);
  const profile = await admin
    .from("profiles")
    .delete()
    .eq("id", staffId)
    .eq("clinic_id", clinicId);
  const auth = await admin.auth.admin.deleteUser(staffId);
  return !profile.error && !auth.error;
}

export async function createStaffMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<SettingsMutationData>> {
  assertDomainMutationRole(user, SETTINGS_WRITE_ROLES);
  const hasUserSuppliedPassword =
    !!input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.hasOwn(input, "temporary_password");
  const parsed = hasUserSuppliedPassword
    ? staffCreateActionSchema.safeParse(input)
    : staffCreateNonPrivilegedActionSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("settings.validationError", {
      validationError: parsed.error,
    });
  if (user.role !== "admin" && parsed.data.role === "admin")
    return domainFailure("settings.onlyAdminsCanCreateAdminUsers");
  const supabase = await createClient();
  if (parsed.data.department_id) {
    const department = await supabase
      .from("departments")
      .select("id")
      .eq("id", parsed.data.department_id)
      .eq("clinic_id", user.clinicId)
      .is("deleted_at", null)
      .maybeSingle();
    if (department.error || !department.data)
      return domainFailure("settings.validationError");
  }
  if (parsed.data.role === "assistant") {
    const doctors = await supabase
      .from("profiles")
      .select("id")
      .eq("clinic_id", user.clinicId)
      .eq("role", "doctor")
      .eq("is_active", true)
      .in("id", parsed.data.supervising_doctor_ids ?? []);
    if (
      doctors.error ||
      doctors.data?.length !== parsed.data.supervising_doctor_ids?.length
    ) {
      return domainFailure("settings.validationError");
    }
  }
  const next = {
    email: parsed.data.email,
    full_name: parsed.data.full_name,
    role: parsed.data.role,
    department_id: parsed.data.department_id ?? null,
    phone: parsed.data.phone ? normalizePhone(parsed.data.phone) : null,
    supervising_doctor_ids: parsed.data.supervising_doctor_ids ?? [],
    must_change_password: true,
    is_active: true,
  };
  if (mode === "preview") {
    return domainSuccess({}, { targetTable: "profiles", after: next });
  }

  const temporaryPassword = hasUserSuppliedPassword
    ? (parsed.data as z.infer<typeof createStaffSchema>).temporary_password
    : serverGeneratedTemporaryPassword();

  // Creating the Supabase Auth principal necessarily uses the application's
  // existing tenant-scoped Admin API path. The core checks the actor and tenant
  // before this call, and every profile/assignment write remains clinic-bound.
  const admin = createClinicScopedAdminClient(user.clinicId);
  const auth = await admin.auth.admin.createUser({
    email: parsed.data.email,
    password: temporaryPassword,
    email_confirm: true,
  });
  if (auth.error || !auth.data.user) {
    return domainFailure(
      auth.error?.message?.includes("already been registered")
        ? "settings.aStaffMemberWithThisEmailAlreadyExists"
        : "settings.failedToCreateAuthUser",
    );
  }
  const staffId = auth.data.user.id;
  const profile = await supabase.from("profiles").insert({
    id: staffId,
    clinic_id: user.clinicId,
    full_name: parsed.data.full_name,
    role: parsed.data.role,
    department_id: parsed.data.department_id ?? null,
    phone: next.phone,
    must_change_password: true,
    is_active: true,
  });
  if (profile.error) {
    await rollbackCreatedStaff(user.clinicId, staffId);
    return domainFailure("settings.weCouldNotCompleteThisRequestPleaseTryAgain");
  }
  if (
    !(await replaceAssistantAssignments(
      staffId,
      parsed.data.role,
      parsed.data.supervising_doctor_ids ?? [],
    )) ||
    !(await seedDefaultPagePermissions(
      user.clinicId,
      staffId,
      parsed.data.role,
    ))
  ) {
    await rollbackCreatedStaff(user.clinicId, staffId);
    return domainFailure("settings.weCouldNotCompleteThisRequestPleaseTryAgain");
  }
  revalidateTag(`staff:${user.clinicId}`, {});
  revalidatePath("/settings/staff");
  return domainSuccess(
    {
      id: staffId,
      staff_id: staffId,
      ...(!hasUserSuppliedPassword
        ? { one_time_temporary_password: temporaryPassword }
        : {}),
    },
    {
      targetTable: "profiles",
      targetRecordIds: [staffId],
      after: { ...next, id: staffId },
    },
  );
}

export async function updateStaffProfileMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<SettingsMutationData>> {
  assertDomainMutationRole(user, SETTINGS_WRITE_ROLES);
  const parsed = staffProfileActionSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("settings.validationError", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  const existing = await supabase
    .from("profiles")
    .select("id, role, full_name, phone")
    .eq("id", parsed.data.staff_id)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (existing.error || !existing.data)
    return domainFailure("settings.staffMemberNotFound");
  if (user.role === "manager" && existing.data.role === "admin")
    return domainFailure("settings.onlyAdminsCanManageAdminUsers");
  const next = stripBlankDisplayNames({
    full_name: parsed.data.profile.full_name,
    phone: parsed.data.profile.phone
      ? normalizePhone(parsed.data.profile.phone)
      : null,
    // The patient-facing names, when the clinic has authored them. `full_name`
    // above is untouched and stays what every staff screen, invoice and export
    // reads.
    display_name_ar: parsed.data.profile.display_name_ar ?? null,
    display_name_en: parsed.data.profile.display_name_en ?? null,
  });
  if (mode === "preview") {
    return domainSuccess(
      { staff_id: existing.data.id },
      {
        targetTable: "profiles",
        targetRecordIds: [existing.data.id],
        before: existing.data,
        after: { ...existing.data, ...next },
      },
    );
  }
  const updated = await supabase
    .from("profiles")
    .update(next, { count: "exact" })
    .eq("id", existing.data.id)
    .eq("clinic_id", user.clinicId);
  if (updated.error)
    return domainFailure("settings.weCouldNotCompleteThisRequestPleaseTryAgain");
  if (!updated.count)
    return domainFailure(
      "settings.couldNotUpdateThisStaffMemberYouMayLackPermission",
    );
  revalidateTag(`staff:${user.clinicId}`, {});
  revalidatePath("/settings/staff");
  return domainSuccess(
    { staff_id: existing.data.id },
    {
      targetTable: "profiles",
      targetRecordIds: [existing.data.id],
      before: existing.data,
      after: { ...existing.data, ...next },
    },
  );
}

type DirectoryKind = "department" | "insurance" | "service";

const directoryConfig = {
  department: {
    table: "departments",
    idField: "department_id",
    createSchema: departmentCreateActionSchema,
    updateSchema: departmentUpdateActionSchema,
    tag: "departments",
    path: "/settings/departments",
  },
  insurance: {
    table: "insurance_providers",
    idField: "insurance_id",
    createSchema: insuranceCreateActionSchema,
    updateSchema: insuranceUpdateActionSchema,
    tag: "insurance",
    path: "/settings/insurance",
  },
  service: {
    table: "services",
    idField: "service_id",
    createSchema: serviceCreateActionSchema,
    updateSchema: serviceUpdateActionSchema,
    tag: "services",
    path: "/settings/services",
  },
} as const;

function refreshDirectory(kind: DirectoryKind, clinicId: string) {
  const config = directoryConfig[kind];
  revalidateTag(`${config.tag}:${clinicId}`, {});
  revalidatePath(config.path);
}

export async function createDirectoryMutation(
  user: AuthedUser,
  kind: DirectoryKind,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<SettingsMutationData>> {
  assertDomainMutationRole(user, SETTINGS_WRITE_ROLES);
  const config = directoryConfig[kind];
  const parsed = config.createSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("settings.validationError", {
      validationError: parsed.error,
    });
  const data = stripBlankDisplayNames(
    kind === "service"
      ? {
          ...parsed.data,
          price: Number((parsed.data as { price: number }).price.toFixed(2)),
          is_active: true,
        }
      : (parsed.data as Record<string, unknown>),
  );
  if (mode === "preview") {
    return domainSuccess({}, { targetTable: config.table, after: data });
  }
  const supabase = await createClient();
  const inserted =
    kind === "department"
      ? await supabase
          .from("departments")
          .insert({ ...(data as z.infer<typeof departmentSchema>), clinic_id: user.clinicId })
          .select("id")
          .single()
      : kind === "insurance"
        ? await supabase
            .from("insurance_providers")
            .insert({ ...(data as z.infer<typeof insuranceSchema>), clinic_id: user.clinicId })
            .select("id")
            .single()
        : await supabase
            .from("services")
            .insert({
              ...(data as z.infer<typeof serviceSchema>),
              clinic_id: user.clinicId,
              is_active: true,
            })
            .select("id")
            .single();
  if (inserted.error) {
    if (inserted.error.code === "23505") {
      return domainFailure(
        kind === "department"
          ? "settings.aDepartmentWithThisNameAlreadyExists"
          : kind === "insurance"
            ? "settings.anInsuranceProviderWithThisNameAlreadyExists"
            : "settings.weCouldNotCompleteThisRequestPleaseTryAgain",
      );
    }
    return domainFailure("settings.weCouldNotCompleteThisRequestPleaseTryAgain");
  }
  refreshDirectory(kind, user.clinicId);
  return domainSuccess(
    { id: inserted.data.id },
    {
      targetTable: config.table,
      targetRecordIds: [inserted.data.id],
      after: { ...data, id: inserted.data.id },
    },
  );
}

export async function updateDirectoryMutation(
  user: AuthedUser,
  kind: DirectoryKind,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<SettingsMutationData>> {
  assertDomainMutationRole(user, SETTINGS_WRITE_ROLES);
  const config = directoryConfig[kind];
  const parsed = config.updateSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("settings.validationError", {
      validationError: parsed.error,
    });
  const record = parsed.data as Record<string, unknown>;
  const id = String(record[config.idField]);
  const next = stripBlankDisplayNames(
    Object.fromEntries(
      Object.entries(record).filter(([key]) => key !== config.idField),
    ),
  );
  if (kind === "service")
    next.price = Number(Number(next.price).toFixed(2));
  const supabase = await createClient();
  const existing =
    kind === "department"
      ? await supabase
          .from("departments")
          .select("*")
          .eq("id", id)
          .eq("clinic_id", user.clinicId)
          .maybeSingle()
      : kind === "insurance"
        ? await supabase
            .from("insurance_providers")
            .select("*")
            .eq("id", id)
            .eq("clinic_id", user.clinicId)
            .maybeSingle()
        : await supabase
            .from("services")
            .select("*")
            .eq("id", id)
            .eq("clinic_id", user.clinicId)
            .maybeSingle();
  if (existing.error || !existing.data)
    return domainFailure("settings.weCouldNotCompleteThisRequestPleaseTryAgain");
  if (mode === "preview") {
    return domainSuccess(
      { id },
      {
        targetTable: config.table,
        targetRecordIds: [id],
        before: existing.data,
        after: { ...existing.data, ...next },
      },
    );
  }
  const updated =
    kind === "department"
      ? await supabase
          .from("departments")
          .update(next as z.infer<typeof departmentSchema>)
          .eq("id", id)
          .eq("clinic_id", user.clinicId)
      : kind === "insurance"
        ? await supabase
            .from("insurance_providers")
            .update(next as z.infer<typeof insuranceSchema>)
            .eq("id", id)
            .eq("clinic_id", user.clinicId)
        : await supabase
            .from("services")
            .update(next as z.infer<typeof serviceSchema>)
            .eq("id", id)
            .eq("clinic_id", user.clinicId);
  if (updated.error)
    return domainFailure("settings.weCouldNotCompleteThisRequestPleaseTryAgain");
  refreshDirectory(kind, user.clinicId);
  return domainSuccess(
    { id },
    {
      targetTable: config.table,
      targetRecordIds: [id],
      before: existing.data,
      after: { ...existing.data, ...next },
    },
  );
}

export async function directoryLifecycleMutation(
  user: AuthedUser,
  kind: DirectoryKind,
  operation: "toggle" | "soft_delete" | "restore" | "permanent_delete",
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<SettingsMutationData>> {
  assertDomainMutationRole(user, SETTINGS_WRITE_ROLES);
  const schema = operation === "toggle" ? settingsToggleSchema : settingsLifecycleSchema;
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    return domainFailure("settings.invalidPayload", {
      validationError: parsed.error,
    });
  const id = parsed.data.id;
  const next =
    operation === "toggle"
      ? {
          is_active: settingsToggleSchema.parse(input).is_active,
        }
      : operation === "soft_delete"
        ? { deleted_at: new Date().toISOString() }
        : operation === "restore"
          ? { deleted_at: null }
          : null;
  const config = directoryConfig[kind];
  const supabase = await createClient();
  const existing =
    kind === "department"
      ? await supabase
          .from("departments")
          .select("*")
          .eq("id", id)
          .eq("clinic_id", user.clinicId)
          .maybeSingle()
      : kind === "insurance"
        ? await supabase
            .from("insurance_providers")
            .select("*")
            .eq("id", id)
            .eq("clinic_id", user.clinicId)
            .maybeSingle()
        : await supabase
            .from("services")
            .select("*")
            .eq("id", id)
            .eq("clinic_id", user.clinicId)
            .maybeSingle();
  if (existing.error || !existing.data)
    return domainFailure("settings.weCouldNotCompleteThisRequestPleaseTryAgain");
  if (operation === "permanent_delete" && !existing.data.deleted_at)
    return domainFailure("settings.weCouldNotCompleteThisRequestPleaseTryAgain");
  if (mode === "preview") {
    return domainSuccess(
      { id },
      {
        targetTable: config.table,
        targetRecordIds: [id],
        before: existing.data,
        after: next ? { ...existing.data, ...next } : null,
      },
    );
  }
  const result =
    kind === "department"
      ? operation === "permanent_delete"
        ? await supabase
            .from("departments")
            .delete()
            .eq("id", id)
            .eq("clinic_id", user.clinicId)
            .not("deleted_at", "is", null)
        : await supabase
            .from("departments")
            .update(next!)
            .eq("id", id)
            .eq("clinic_id", user.clinicId)
      : kind === "insurance"
        ? operation === "permanent_delete"
          ? await supabase
              .from("insurance_providers")
              .delete()
              .eq("id", id)
              .eq("clinic_id", user.clinicId)
              .not("deleted_at", "is", null)
          : await supabase
              .from("insurance_providers")
              .update(next!)
              .eq("id", id)
              .eq("clinic_id", user.clinicId)
        : operation === "permanent_delete"
          ? await supabase
              .from("services")
              .delete()
              .eq("id", id)
              .eq("clinic_id", user.clinicId)
              .not("deleted_at", "is", null)
          : await supabase
              .from("services")
              .update(next!)
              .eq("id", id)
              .eq("clinic_id", user.clinicId);
  if (result.error)
    return domainFailure("settings.weCouldNotCompleteThisRequestPleaseTryAgain");
  refreshDirectory(kind, user.clinicId);
  return domainSuccess(
    { id },
    {
      targetTable: config.table,
      targetRecordIds: [id],
      before: existing.data,
      after: next ? { ...existing.data, ...next } : null,
    },
  );
}

export async function updateClinicMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<SettingsMutationData>> {
  assertDomainMutationRole(user, SETTINGS_WRITE_ROLES);
  const parsed = clinicUpdateActionSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("settings.validationError", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  const existing = await supabase
    .from("clinics")
    .select(
      "id, name, phone, address, email, website, license_no, tax_id, document_footer, branding_metadata, time_format",
    )
    .eq("id", user.clinicId)
    .maybeSingle();
  if (existing.error || !existing.data)
    return domainFailure("settings.weCouldNotCompleteThisRequestPleaseTryAgain");
  const next = {
    name: parsed.data.name,
    phone: parsed.data.phone ? normalizePhone(parsed.data.phone) : null,
    address: parsed.data.address ?? null,
    time_format: parsed.data.time_format,
    ...(user.role === "admin"
      ? {
          email: parsed.data.email,
          website: parsed.data.website,
          license_no: parsed.data.license_no,
          tax_id: parsed.data.tax_id,
          document_footer: parsed.data.document_footer,
          branding_metadata: JSON.parse(parsed.data.branding_metadata),
        }
      : {}),
  };
  if (mode === "preview") {
    return domainSuccess(
      { id: user.clinicId },
      {
        targetTable: "clinics",
        targetRecordIds: [user.clinicId],
        before: existing.data,
        after: { ...existing.data, ...next },
      },
    );
  }
  const updated = await supabase
    .from("clinics")
    .update(next)
    .eq("id", user.clinicId);
  if (updated.error)
    return domainFailure("settings.weCouldNotCompleteThisRequestPleaseTryAgain");
  const currentClinic = await supabase
    .from("clinics")
    .select("logo_url")
    .eq("id", user.clinicId)
    .single();
  if (currentClinic.data?.logo_url) {
    await ensureClinicLogoCleaned({
      supabase,
      clinicId: user.clinicId,
      logoUrl: currentClinic.data.logo_url,
    });
  }
  revalidatePath("/", "layout");
  return domainSuccess(
    { id: user.clinicId },
    {
      targetTable: "clinics",
      targetRecordIds: [user.clinicId],
      before: existing.data,
      after: { ...existing.data, ...next },
    },
  );
}

export async function updateReminderSettingsMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<SettingsMutationData>> {
  assertDomainMutationRole(user, SETTINGS_WRITE_ROLES);
  const parsed = reminderSettingsSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("settings.invalidPayload", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  if (mode === "execute") {
    const updated = await supabase
      .from("clinics")
      .update({ reminders_enabled: parsed.data.enabled })
      .eq("id", user.clinicId);
    if (updated.error)
      return domainFailure("settings.weCouldNotCompleteThisRequestPleaseTryAgain");
    revalidatePath("/settings/messaging");
  }
  return domainSuccess(
    { id: user.clinicId },
    {
      targetTable: "clinics",
      targetRecordIds: [user.clinicId],
      after: { reminders_enabled: parsed.data.enabled },
    },
  );
}

export async function updateInvoiceFollowupSettingsMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<SettingsMutationData>> {
  assertDomainMutationRole(user, SETTINGS_WRITE_ROLES);
  const parsed = invoiceFollowupSettingsSchema.safeParse(input);
  if (!parsed.success) {
    const values =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as { first_days?: unknown; second_days?: unknown })
        : {};
    const sequenceInvalid =
      typeof values.first_days === "number" &&
      typeof values.second_days === "number" &&
      values.first_days >= 1 &&
      values.first_days <= 365 &&
      values.second_days >= 1 &&
      values.second_days <= 365 &&
      values.second_days <= values.first_days;
    return domainFailure(
      sequenceInvalid
        ? "settings.invoiceFollowupSecondAfterFirst"
        : "settings.invoiceFollowupDaysOutOfRange",
      {
        validationError: parsed.error,
        ...(sequenceInvalid
          ? {
              fieldErrorCodes: {
                second_days: ["settings.invoiceFollowupSecondAfterFirst"],
              },
            }
          : {}),
      },
    );
  }
  const next = {
    invoice_followups_enabled: parsed.data.enabled,
    invoice_followup_first_days: parsed.data.first_days,
    invoice_followup_second_days: parsed.data.second_days,
    invoice_followup_email_subject: parsed.data.email_subject?.trim() || null,
    invoice_followup_email_body: parsed.data.email_body?.trim() || null,
  };
  if (mode === "execute") {
    const supabase = await createClient();
    const updated = await supabase
      .from("clinics")
      .update(next)
      .eq("id", user.clinicId);
    if (updated.error)
      return domainFailure("settings.weCouldNotCompleteThisRequestPleaseTryAgain");
    revalidatePath("/settings/messaging");
  }
  return domainSuccess(
    { id: user.clinicId },
    {
      targetTable: "clinics",
      targetRecordIds: [user.clinicId],
      after: next,
    },
  );
}

/**
 * P18 — the one administrative audit event a scheduling save produces.
 *
 * Clinic hours, staff schedules and shift templates are all saved as
 * "delete everything for this scope, insert the new set". Database triggers
 * cover the rest of the administrative surface precisely because they cannot be
 * bypassed, but here they would emit one event per shift row and two events per
 * save, and would still not make the replace atomic — it already is not. So the
 * event is written once, here, at the authoritative boundary, from the before
 * and after these mutations have already computed.
 *
 * A save that changes nothing produces nothing: reopening the editor and
 * pressing Save must not appear in the trail as a schedule change.
 */
async function auditScheduleReplace(input: {
  action: string;
  entityType: string;
  entityId: string;
  entityRef?: string | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  changedField: string;
}): Promise<void> {
  if (JSON.stringify(input.before) === JSON.stringify(input.after)) return;
  await recordAdminAuditEvent({
    module: "scheduling",
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    entityRef: input.entityRef ?? null,
    before: input.before,
    after: input.after,
    changedFields: [input.changedField],
  });
}

async function loadClinicHours(clinicId: string) {
  const supabase = await createClient();
  const result = await supabase
    .from("clinic_working_hours")
    .select("day_of_week, shift_start, shift_end")
    .eq("clinic_id", clinicId)
    .order("day_of_week")
    .order("shift_start");
  return result.data ?? [];
}

export async function upsertClinicWorkingHoursMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<SettingsMutationData>> {
  assertDomainMutationRole(user, SETTINGS_ADMIN_ROLES);
  const parsed = clinicWorkingHoursActionSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("settings.validationError2", {
      validationError: parsed.error,
    });
  const rows = parsed.data.days
    .filter((day) => day.open && day.shifts.length > 0)
    .flatMap((day) =>
      day.shifts.map((shift) => ({
        clinic_id: user.clinicId,
        day_of_week: day.day_of_week,
        shift_start: shift.shift_start,
        shift_end: shift.shift_end,
      })),
    );
  const before = await loadClinicHours(user.clinicId);
  if (mode === "preview") {
    return domainSuccess(
      { id: user.clinicId },
      {
        targetTable: "clinic_working_hours",
        before,
        after: rows,
      },
    );
  }
  const supabase = await createClient();
  const removed = await supabase
    .from("clinic_working_hours")
    .delete()
    .eq("clinic_id", user.clinicId);
  if (removed.error)
    return domainFailure("settings.weCouldNotCompleteThisRequestPleaseTryAgain");
  if (rows.length > 0) {
    const inserted = await supabase.from("clinic_working_hours").insert(rows);
    if (inserted.error)
      return domainFailure("settings.weCouldNotCompleteThisRequestPleaseTryAgain");
  }
  await auditScheduleReplace({
    action: "clinic_hours.updated",
    entityType: "clinic_hours",
    entityId: user.clinicId,
    before: auditShiftSummary(
      before.map((row) => ({
        day: row.day_of_week,
        start: row.shift_start,
        end: row.shift_end,
      })),
    ),
    after: auditShiftSummary(
      rows.map((row) => ({
        day: row.day_of_week,
        start: row.shift_start,
        end: row.shift_end,
      })),
    ),
    changedField: "shifts",
  });
  revalidatePath("/settings/clinic");
  return domainSuccess(
    { id: user.clinicId },
    { targetTable: "clinic_working_hours", before, after: rows },
  );
}

export async function upsertStaffScheduleMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<SettingsMutationData>> {
  assertDomainMutationRole(user, SETTINGS_ADMIN_ROLES);
  const parsed = staffScheduleActionSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("settings.validationError2", {
      validationError: parsed.error,
    });
  const supabase = await createClient();
  const target = await supabase
    .from("profiles")
    // `full_name` is read for the audit event's human reference, so the trail
    // still says whose schedule changed after the account is renamed.
    .select("id, full_name")
    .eq("id", parsed.data.staff_id)
    .eq("clinic_id", user.clinicId)
    .eq("is_deleted", false)
    .maybeSingle();
  if (target.error || !target.data)
    return domainFailure("settings.staffMemberNotFound");
  const clinicRows = await loadClinicHours(user.clinicId);
  if (clinicRows.length > 0) {
    for (const day of parsed.data.days) {
      if (!day.works || day.intervals.length === 0) continue;
      const shifts = clinicRows.filter(
        (row) => row.day_of_week === day.day_of_week,
      );
      if (shifts.length === 0)
        return domainFailure("settings.staffScheduleOnClosedDay", {
          values: { day: day.day_of_week },
        });
      // Each staff interval is checked against the clinic's opening intervals
      // independently; the clinic-hours rule is unchanged by P14.
      for (const entry of day.intervals) {
        const interval = validateStaffInterval(
          entry.start_time,
          entry.end_time,
          shifts,
        );
        if (!interval.ok) {
          return domainFailure("settings.staffHoursOutsideClinicHours", {
            values: {
              day: day.day_of_week,
              start: entry.start_time,
              end: entry.end_time,
              clinicOpen: interval.clinicOpen ?? "—",
              clinicClose: interval.clinicClose ?? "—",
            },
          });
        }
      }
    }
  }
  // The schema already merged each day into disjoint intervals, so overlapping
  // template picks collapse to their union and never duplicate a slot.
  const rows = parsed.data.days
    .filter((day) => day.works)
    .flatMap((day) =>
      day.intervals.map((entry) => ({
        doctor_id: parsed.data.staff_id,
        clinic_id: user.clinicId,
        day_of_week: day.day_of_week,
        start_time: entry.start_time,
        end_time: entry.end_time,
      })),
    );
  const before = await supabase
    .from("doctor_schedules")
    .select("day_of_week, start_time, end_time")
    .eq("doctor_id", parsed.data.staff_id)
    .eq("clinic_id", user.clinicId)
    .order("day_of_week")
    .order("start_time");
  if (mode === "preview") {
    return domainSuccess(
      { staff_id: parsed.data.staff_id },
      {
        targetTable: "doctor_schedules",
        targetRecordIds: [parsed.data.staff_id],
        before: before.data ?? [],
        after: rows,
      },
    );
  }
  const removed = await supabase
    .from("doctor_schedules")
    .delete()
    .eq("doctor_id", parsed.data.staff_id)
    .eq("clinic_id", user.clinicId);
  if (removed.error)
    return domainFailure("settings.weCouldNotCompleteThisRequestPleaseTryAgain");
  if (rows.length > 0) {
    const inserted = await supabase.from("doctor_schedules").insert(rows);
    if (inserted.error)
      return domainFailure("settings.weCouldNotCompleteThisRequestPleaseTryAgain");
  }
  await auditScheduleReplace({
    action: "staff_schedule.updated",
    entityType: "staff",
    entityId: parsed.data.staff_id,
    entityRef: target.data.full_name,
    before: auditShiftSummary(
      (before.data ?? []).map((row) => ({
        day: row.day_of_week,
        start: row.start_time,
        end: row.end_time,
      })),
    ),
    after: auditShiftSummary(
      rows.map((row) => ({
        day: row.day_of_week,
        start: row.start_time,
        end: row.end_time,
      })),
    ),
    changedField: "shifts",
  });
  revalidatePath("/settings/staff");
  return domainSuccess(
    { staff_id: parsed.data.staff_id },
    {
      targetTable: "doctor_schedules",
      targetRecordIds: [parsed.data.staff_id],
      before: before.data ?? [],
      after: rows,
    },
  );
}

// ── P14 staff shift templates ──────────────────────────────────────────────
// Reusable named staff shifts. These are NOT clinic opening intervals, so no
// overlap check is applied: Morning 09:00–17:00 and Evening 15:00–22:00 are
// both valid at the same time. Selecting a template in the staff schedule
// editor copies its concrete hours (model B), so editing a template later never
// silently moves an existing staff schedule or a booked appointment.

async function loadStaffShiftTemplates(clinicId: string) {
  const supabase = await createClient();
  const result = await supabase
    .from("staff_shift_templates")
    .select("id, name, start_time, end_time, is_enabled, sort_order")
    .eq("clinic_id", clinicId)
    .order("sort_order")
    .order("created_at");
  return result.data ?? [];
}

export async function upsertStaffShiftTemplatesMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<SettingsMutationData>> {
  assertDomainMutationRole(user, SETTINGS_ADMIN_ROLES);
  const parsed = staffShiftTemplatesActionSchema.safeParse(input);
  if (!parsed.success)
    return domainFailure("settings.validationError2", {
      validationError: parsed.error,
    });

  const rows = parsed.data.templates.map((template, index) => ({
    clinic_id: user.clinicId,
    name: template.name.trim(),
    start_time: canonicalClock(template.start_time)!,
    end_time: canonicalClock(template.end_time)!,
    is_enabled: template.is_enabled,
    sort_order: index,
  }));

  const before = await loadStaffShiftTemplates(user.clinicId);
  if (mode === "preview") {
    return domainSuccess(
      { id: user.clinicId },
      { targetTable: "staff_shift_templates", before, after: rows },
    );
  }

  const supabase = await createClient();
  const removed = await supabase
    .from("staff_shift_templates")
    .delete()
    .eq("clinic_id", user.clinicId);
  if (removed.error)
    return domainFailure("settings.weCouldNotCompleteThisRequestPleaseTryAgain");
  if (rows.length > 0) {
    const inserted = await supabase.from("staff_shift_templates").insert(rows);
    if (inserted.error)
      return domainFailure("settings.weCouldNotCompleteThisRequestPleaseTryAgain");
  }
  await auditScheduleReplace({
    action: "shift_templates.updated",
    entityType: "shift_templates",
    entityId: user.clinicId,
    before: auditTemplateSummary(before),
    after: auditTemplateSummary(rows),
    changedField: "templates",
  });
  revalidatePath("/settings/clinic");
  revalidatePath("/settings/staff");
  return domainSuccess(
    { id: user.clinicId },
    { targetTable: "staff_shift_templates", before, after: rows },
  );
}

// ── Phase 5f privileged staff and permission mutations ─────────────────────

type PrivilegedSettingsMutationData = {
  staff_id: string;
  one_time_temporary_password?: string;
};

type PrivilegedStaffTarget = {
  id: string;
  clinic_id: string;
  role: AuthedUser["role"];
  full_name: string;
  department_id: string | null;
  phone: string | null;
  is_active: boolean;
  is_deleted: boolean;
  deleted_at: string | null;
  must_change_password: boolean;
};

export function managerCanManageStaffTarget(
  actorRole: AuthedUser["role"],
  targetRole: AuthedUser["role"],
): boolean {
  return actorRole === "admin" || targetRole !== "admin";
}

async function loadPrivilegedStaffTarget(
  user: AuthedUser,
  staffId: string,
): Promise<PrivilegedStaffTarget | null> {
  const admin = createClinicScopedAdminClient(user.clinicId);
  const { data, error } = await admin
    .from("profiles")
    .select(
      "id, clinic_id, role, full_name, department_id, phone, is_active, is_deleted, deleted_at, must_change_password",
    )
    .eq("id", staffId)
    .eq("clinic_id", user.clinicId)
    .maybeSingle();
  if (error || !data) return null;
  return data as PrivilegedStaffTarget;
}

async function primaryAdminMutationBlocked(
  user: AuthedUser,
  targetId: string,
): Promise<boolean> {
  return (await getPrimaryClinicAdminId(user.clinicId)) === targetId;
}

async function currentAssistantAssignments(
  user: AuthedUser,
  staffId: string,
): Promise<string[]> {
  const admin = createClinicScopedAdminClient(user.clinicId);
  const { data, error } = await admin
    .from("assistant_doctor_assignments")
    .select("doctor_id")
    .eq("clinic_id", user.clinicId)
    .eq("assistant_id", staffId)
    .order("doctor_id");
  if (error) return [];
  return (data ?? []).map((row) => row.doctor_id);
}

function refreshPrivilegedStaff(clinicId: string) {
  revalidateTag(`staff:${clinicId}`, {});
  revalidatePath("/settings/staff");
  revalidatePath("/settings/customize");
  revalidatePath("/settings/ai");
}

export async function updateStaffMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<PrivilegedSettingsMutationData>> {
  assertDomainMutationRole(user, PRIVILEGED_STAFF_MANAGEMENT_ROLES);
  const parsed = staffUpdateActionSchema.safeParse(input);
  if (!parsed.success) {
    return domainFailure("settings.validationError", {
      validationError: parsed.error,
    });
  }
  const target = await loadPrivilegedStaffTarget(user, parsed.data.staff_id);
  if (!target || target.is_deleted || target.deleted_at) {
    return domainFailure("settings.staffMemberNotFound");
  }
  const values = parsed.data.values;
  if (!managerCanManageStaffTarget(user.role, target.role)) {
    return domainFailure("settings.onlyAdminsCanManageAdminUsers");
  }
  if (user.role !== "admin" && values.role !== target.role) {
    return domainFailure("settings.onlyAdminsCanChangeStaffRoles");
  }
  if (target.id === user.id && !values.is_active) {
    return domainFailure("settings.youCannotDeactivateYourOwnAccount");
  }
  // No primary-admin guard here on purpose: Settings → Staff never had one, and
  // this core is the Settings UI's only implementation. The Assistant's
  // primary-admin refusal lives at the privileged action boundary
  // (lib/ai/actions/definitions/privileged.ts) so the UI keeps its legacy
  // behaviour byte for byte.
  if (values.department_id) {
    const department = await createClinicScopedAdminClient(user.clinicId)
      .from("departments")
      .select("id")
      .eq("id", values.department_id)
      .eq("clinic_id", user.clinicId)
      .is("deleted_at", null)
      .maybeSingle();
    if (department.error || !department.data) {
      return domainFailure("settings.validationError");
    }
  }
  const requestedDoctorIds = Array.from(
    new Set(values.supervising_doctor_ids ?? []),
  ).sort();
  if (values.role === "assistant") {
    const doctors = await createClinicScopedAdminClient(user.clinicId)
      .from("profiles")
      .select("id")
      .eq("clinic_id", user.clinicId)
      .eq("role", "doctor")
      .eq("is_active", true)
      .eq("is_deleted", false)
      .is("deleted_at", null)
      .in("id", requestedDoctorIds);
    if (
      doctors.error ||
      (doctors.data ?? []).length !== requestedDoctorIds.length
    ) {
      return domainFailure("settings.validationError");
    }
  }
  const beforeAssignments = await currentAssistantAssignments(user, target.id);
  const nextAssignments = values.role === "assistant" ? requestedDoctorIds : [];
  const before = {
    id: target.id,
    full_name: target.full_name,
    role: target.role,
    department_id: target.department_id,
    phone: target.phone,
    is_active: target.is_active,
    supervising_doctor_ids: beforeAssignments,
  };
  const after = {
    ...before,
    full_name: values.full_name,
    role: values.role,
    department_id: values.department_id ?? null,
    phone: values.phone ? normalizePhone(values.phone) : null,
    is_active: values.is_active,
    supervising_doctor_ids: nextAssignments,
  };
  if (mode === "preview") {
    return domainSuccess(
      { staff_id: target.id },
      {
        targetTable: "profiles",
        targetRecordIds: [target.id],
        before,
        after,
      },
    );
  }

  const supabase = await createClient();
  const changed = await supabase
    .from("profiles")
    .update(
      {
        full_name: after.full_name,
        role: after.role,
        department_id: after.department_id,
        phone: after.phone,
        is_active: after.is_active,
      },
      { count: "exact" },
    )
    .eq("id", target.id)
    .eq("clinic_id", user.clinicId);
  if (changed.error || changed.count !== 1) {
    return domainFailure(
      "settings.couldNotUpdateThisStaffMemberYouMayLackPermission",
    );
  }

  const assignmentsSaved = await replaceAssistantAssignments(
    target.id,
    after.role,
    nextAssignments,
  );
  const permissionsSaved = assignmentsSaved
    ? await seedDefaultPagePermissions(user.clinicId, target.id, after.role)
    : false;
  if (!assignmentsSaved || !permissionsSaved) {
    await supabase
      .from("profiles")
      .update({
        full_name: before.full_name,
        role: before.role,
        department_id: before.department_id,
        phone: before.phone,
        is_active: before.is_active,
      })
      .eq("id", target.id)
      .eq("clinic_id", user.clinicId);
    await replaceAssistantAssignments(
      target.id,
      before.role,
      beforeAssignments,
    );
    return domainFailure(
      "settings.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  }
  refreshPrivilegedStaff(user.clinicId);
  return domainSuccess(
    { staff_id: target.id },
    {
      targetTable: "profiles",
      targetRecordIds: [target.id],
      before,
      after,
    },
  );
}

export async function changeStaffRoleMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<PrivilegedSettingsMutationData>> {
  assertDomainMutationRole(user, PRIVILEGED_STAFF_MANAGEMENT_ROLES);
  const parsed = staffRoleChangeActionSchema.safeParse(input);
  if (!parsed.success) {
    return domainFailure("settings.validationError", {
      validationError: parsed.error,
    });
  }
  const target = await loadPrivilegedStaffTarget(user, parsed.data.staff_id);
  if (!target || target.is_deleted || target.deleted_at) {
    return domainFailure("settings.staffMemberNotFound");
  }
  return updateStaffMutation(
    user,
    {
      staff_id: target.id,
      values: {
        full_name: target.full_name,
        role: parsed.data.role,
        department_id: parsed.data.department_id,
        phone: target.phone,
        is_active: target.is_active,
        supervising_doctor_ids: parsed.data.supervising_doctor_ids,
      },
    },
    mode,
  );
}

export async function setStaffActiveMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<PrivilegedSettingsMutationData>> {
  assertDomainMutationRole(user, PRIVILEGED_STAFF_MANAGEMENT_ROLES);
  const parsed = staffActiveActionSchema.safeParse(input);
  if (!parsed.success) {
    return domainFailure("settings.validationError", {
      validationError: parsed.error,
    });
  }
  const target = await loadPrivilegedStaffTarget(user, parsed.data.staff_id);
  if (!target) return domainFailure("settings.staffMemberNotFound");
  if (!managerCanManageStaffTarget(user.role, target.role)) {
    return domainFailure("settings.onlyAdminsCanManageAdminUsers");
  }
  if (target.id === user.id && !parsed.data.is_active) {
    return domainFailure("settings.youCannotDeactivateYourOwnAccount");
  }
  // See updateStaffMutation: primary-admin protection is an Assistant-boundary
  // rule, not a Settings UI rule.
  const before = {
    id: target.id,
    full_name: target.full_name,
    is_active: target.is_active,
  };
  const after = { ...before, is_active: parsed.data.is_active };
  if (mode === "preview") {
    return domainSuccess(
      { staff_id: target.id },
      {
        targetTable: "profiles",
        targetRecordIds: [target.id],
        before,
        after,
      },
    );
  }
  const updated = await createClient().then((client) =>
    client
      .from("profiles")
      .update({ is_active: parsed.data.is_active }, { count: "exact" })
      .eq("id", target.id)
      .eq("clinic_id", user.clinicId),
  );
  if (updated.error || updated.count !== 1) {
    return domainFailure(
      "settings.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  }
  refreshPrivilegedStaff(user.clinicId);
  return domainSuccess(
    { staff_id: target.id },
    {
      targetTable: "profiles",
      targetRecordIds: [target.id],
      before,
      after,
    },
  );
}

export async function staffLifecycleMutation(
  user: AuthedUser,
  operation: "soft_delete" | "restore" | "permanent_delete",
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<PrivilegedSettingsMutationData>> {
  assertDomainMutationRole(user, PRIVILEGED_STAFF_MANAGEMENT_ROLES);
  const parsed = staffLifecycleActionSchema.safeParse(input);
  if (!parsed.success) {
    return domainFailure("settings.validationError", {
      validationError: parsed.error,
    });
  }
  const target = await loadPrivilegedStaffTarget(user, parsed.data.staff_id);
  if (!target) return domainFailure("settings.staffMemberNotFound");
  if (!managerCanManageStaffTarget(user.role, target.role)) {
    return domainFailure("settings.onlyAdminsCanManageAdminUsers");
  }
  if (target.id === user.id && operation !== "restore") {
    return domainFailure("settings.youCannotDeleteYourOwnAccount");
  }
  // See updateStaffMutation: primary-admin protection is an Assistant-boundary
  // rule, not a Settings UI rule.
  if (
    operation === "permanent_delete" &&
    !target.is_deleted &&
    !target.deleted_at
  ) {
    return domainFailure("settings.staffMemberNotFound");
  }
  const before = {
    id: target.id,
    full_name: target.full_name,
    is_active: target.is_active,
    is_deleted: target.is_deleted,
    deleted_at: target.deleted_at,
  };
  const after =
    operation === "soft_delete"
      ? {
          ...before,
          is_active: false,
          deleted_at: "pending-confirmation",
        }
      : operation === "restore"
        ? {
            ...before,
            is_active: true,
            deleted_at: null,
          }
        : null;
  if (mode === "preview") {
    return domainSuccess(
      { staff_id: target.id },
      {
        targetTable: "profiles",
        targetRecordIds: [target.id],
        before,
        after,
      },
    );
  }

  if (operation === "permanent_delete") {
    const admin = createClinicScopedAdminClient(user.clinicId);
    const removedAuth = await admin.auth.admin.deleteUser(target.id);
    if (removedAuth.error) {
      return domainFailure(
        "settings.weCouldNotCompleteThisRequestPleaseTryAgain",
      );
    }
    await admin
      .from("profiles")
      .delete()
      .eq("id", target.id)
      .eq("clinic_id", user.clinicId);
  } else {
    const timestamp = new Date().toISOString();
    const next =
      operation === "soft_delete"
        ? { deleted_at: timestamp, is_active: false }
        : { deleted_at: null, is_active: true };
    const updated = await createClient().then((client) =>
      client
        .from("profiles")
        .update(next, { count: "exact" })
        .eq("id", target.id)
        .eq("clinic_id", user.clinicId),
    );
    if (updated.error || updated.count !== 1) {
      return domainFailure(
        "settings.weCouldNotCompleteThisRequestPleaseTryAgain",
      );
    }
    if (after && operation === "soft_delete") after.deleted_at = timestamp;
  }
  refreshPrivilegedStaff(user.clinicId);
  return domainSuccess(
    { staff_id: target.id },
    {
      targetTable: "profiles",
      targetRecordIds: [target.id],
      before,
      after,
    },
  );
}

export async function resetStaffPasswordMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<PrivilegedSettingsMutationData>> {
  assertDomainMutationRole(user, PRIVILEGED_STAFF_MANAGEMENT_ROLES);
  const parsed = staffPasswordResetCoreSchema.safeParse(input);
  if (!parsed.success) {
    return domainFailure("settings.validationError", {
      validationError: parsed.error,
    });
  }
  const target = await loadPrivilegedStaffTarget(user, parsed.data.staff_id);
  if (!target || target.is_deleted || target.deleted_at) {
    return domainFailure("settings.staffMemberNotFound");
  }
  if (!managerCanManageStaffTarget(user.role, target.role)) {
    return domainFailure("settings.onlyAdminsCanManageAdminUsers");
  }
  const before = {
    id: target.id,
    full_name: target.full_name,
    must_change_password: target.must_change_password,
    password: "unchanged",
  };
  const after = {
    ...before,
    must_change_password: true,
    password: "server-generated one-time password",
  };
  if (mode === "preview") {
    return domainSuccess(
      { staff_id: target.id },
      {
        targetTable: "profiles",
        targetRecordIds: [target.id],
        before,
        after,
      },
    );
  }
  const temporaryPassword =
    parsed.data.temporary_password ?? serverGeneratedTemporaryPassword();
  const admin = createClinicScopedAdminClient(user.clinicId);
  const auth = await admin.auth.admin.updateUserById(target.id, {
    password: temporaryPassword,
  });
  if (auth.error) {
    return domainFailure(
      "settings.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  }
  const profile = await admin
    .from("profiles")
    .update({ must_change_password: true }, { count: "exact" })
    .eq("id", target.id)
    .eq("clinic_id", user.clinicId);
  if (profile.error || profile.count !== 1) {
    return domainFailure(
      "settings.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  }
  refreshPrivilegedStaff(user.clinicId);
  return domainSuccess(
    {
      staff_id: target.id,
      ...(parsed.data.temporary_password
        ? {}
        : { one_time_temporary_password: temporaryPassword }),
    },
    {
      targetTable: "profiles",
      targetRecordIds: [target.id],
      before,
      after,
    },
  );
}

async function assertPrimaryAdminPermissionActor(
  user: AuthedUser,
  denialCode =
    "page-permissions.onlyThePrimaryClinicAdminCanCustomizePageVisibility",
): Promise<DomainMutationResult<never> | null> {
  if (!(await isPrimaryClinicAdmin(user.id, user.clinicId))) {
    return domainFailure(denialCode);
  }
  return null;
}

function isMissingPagePermissionsTable(error: {
  code?: string;
  message?: string;
} | null): boolean {
  return (
    error?.code === "42P01" ||
    error?.message?.toLowerCase().includes("user_page_permissions") === true
  );
}

export async function setPagePermissionMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<PrivilegedSettingsMutationData>> {
  assertDomainMutationRole(user, PRIVILEGED_ADMIN_ONLY_ROLES);
  const parsed = pagePermissionActionSchema.safeParse(input);
  if (!parsed.success) {
    return domainFailure("page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain", {
      validationError: parsed.error,
    });
  }
  const denied = await assertPrimaryAdminPermissionActor(user);
  if (denied) return denied;
  if (parsed.data.page_slug === "dashboard") {
    return domainFailure("page-permissions.dashboardCannotBeHidden");
  }
  const target = await loadPrivilegedStaffTarget(
    user,
    parsed.data.target_user_id,
  );
  if (!target || target.is_deleted || target.deleted_at) {
    return domainFailure("page-permissions.staffMemberNotFound");
  }
  if (await primaryAdminMutationBlocked(user, target.id)) {
    return domainFailure(
      "page-permissions.thePrimaryClinicAdminCannotBeCustomized",
    );
  }
  if (!getRolePageSlugs(target.role).includes(parsed.data.page_slug)) {
    return domainFailure(
      "page-permissions.thisPageIsNotAvailableForThatUserSRole",
    );
  }
  const admin = createClinicScopedAdminClient(user.clinicId);
  const stored = await admin
    .from("user_page_permissions")
    .select("is_visible")
    .eq("clinic_id", user.clinicId)
    .eq("user_id", target.id)
    .eq("page_slug", parsed.data.page_slug)
    .maybeSingle();
  let fallbackVisible: boolean | undefined;
  if (isMissingPagePermissionsTable(stored.error)) {
    const fallback = await admin
      .from("user_customizations")
      .select("access")
      .eq("profile_id", target.id)
      .eq("clinic_id", user.clinicId)
      .eq("feature", "_visible")
      .eq("page", parsed.data.page_slug)
      .maybeSingle();
    if (fallback.error) {
      return domainFailure(
        "page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain",
      );
    }
    fallbackVisible = fallback.data?.access !== "hidden";
  } else if (stored.error) {
    return domainFailure(
      "page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  }
  const before = {
    id: target.id,
    full_name: target.full_name,
    page_slug: parsed.data.page_slug,
    is_visible: stored.data?.is_visible ?? fallbackVisible ?? true,
  };
  const after = { ...before, is_visible: parsed.data.is_visible };
  if (mode === "preview") {
    return domainSuccess(
      { staff_id: target.id },
      {
        targetTable: "user_page_permissions",
        targetRecordIds: [target.id],
        before,
        after,
      },
    );
  }
  const saved = await admin.from("user_page_permissions").upsert(
    {
      user_id: target.id,
      clinic_id: user.clinicId,
      page_slug: parsed.data.page_slug,
      is_visible: parsed.data.is_visible,
    },
    { onConflict: "user_id,page_slug" },
  );
  if (isMissingPagePermissionsTable(saved.error)) {
    const fallback = await admin.from("user_customizations").upsert(
      {
        profile_id: target.id,
        clinic_id: user.clinicId,
        feature: "_visible",
        page: parsed.data.page_slug,
        access: parsed.data.is_visible ? "read_edit" : "hidden",
      },
      { onConflict: "profile_id,page,feature" },
    );
    if (fallback.error) {
      return domainFailure(
        "page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain",
      );
    }
  } else if (saved.error) {
    return domainFailure(
      "page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  }
  revalidatePath("/settings/customize");
  return domainSuccess(
    { staff_id: target.id },
    {
      targetTable: "user_page_permissions",
      targetRecordIds: [target.id],
      before,
      after,
    },
  );
}

export async function setReportPermissionMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<PrivilegedSettingsMutationData>> {
  assertDomainMutationRole(user, PRIVILEGED_ADMIN_ONLY_ROLES);
  const parsed = reportPermissionActionSchema.safeParse(input);
  if (!parsed.success) {
    return domainFailure("page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain", {
      validationError: parsed.error,
    });
  }
  const denied = await assertPrimaryAdminPermissionActor(user);
  if (denied) return denied;
  const target = await loadPrivilegedStaffTarget(
    user,
    parsed.data.target_user_id,
  );
  if (!target || target.is_deleted || target.deleted_at) {
    return domainFailure("page-permissions.staffMemberNotFound");
  }
  if (await primaryAdminMutationBlocked(user, target.id)) {
    return domainFailure(
      "page-permissions.thePrimaryClinicAdminCannotBeCustomized",
    );
  }
  const reportId = parsed.data.report_id as ClinicReportId;
  if (!reportsOpenableByRole(target.role).includes(reportId)) {
    return domainFailure(
      "page-permissions.thisPageIsNotAvailableForThatUserSRole",
    );
  }
  const admin = createClinicScopedAdminClient(user.clinicId);
  const stored = await admin
    .from("user_report_permissions")
    .select("is_visible")
    .eq("clinic_id", user.clinicId)
    .eq("user_id", target.id)
    .eq("report_id", reportId)
    .maybeSingle();
  if (stored.error) {
    return domainFailure(
      "page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  }
  const before = {
    id: target.id,
    full_name: target.full_name,
    report_id: reportId,
    is_visible:
      stored.data?.is_visible ??
      reportDefaultVisibleForRole(reportId, target.role),
  };
  const after = { ...before, is_visible: parsed.data.is_visible };
  if (mode === "preview") {
    return domainSuccess(
      { staff_id: target.id },
      {
        targetTable: "user_report_permissions",
        targetRecordIds: [target.id],
        before,
        after,
      },
    );
  }
  const saved = await admin.from("user_report_permissions").upsert(
    {
      user_id: target.id,
      clinic_id: user.clinicId,
      report_id: reportId,
      is_visible: parsed.data.is_visible,
    },
    { onConflict: "user_id,report_id" },
  );
  if (saved.error) {
    return domainFailure(
      "page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  }
  revalidatePath("/settings/customize");
  return domainSuccess(
    { staff_id: target.id },
    {
      targetTable: "user_report_permissions",
      targetRecordIds: [target.id],
      before,
      after,
    },
  );
}

/**
 * Bulk page-visibility save. Restores the pre-Phase-5f contract: role/dashboard
 * entries are filtered out before anything is written, an empty remainder is a
 * success, and every surviving entry lands in **one** upsert so a mid-list
 * refusal can never leave permissions half applied.
 */
export async function savePagePermissionsMutation(
  user: AuthedUser,
  input: unknown,
): Promise<DomainMutationResult<{ staff_id: string; written: number }>> {
  assertDomainMutationRole(user, PRIVILEGED_ADMIN_ONLY_ROLES);
  const parsed = pagePermissionBatchActionSchema.safeParse(input);
  if (!parsed.success) {
    return domainFailure(
      "page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain",
      { validationError: parsed.error },
    );
  }
  const denied = await assertPrimaryAdminPermissionActor(user);
  if (denied) return denied;
  const target = await loadPrivilegedStaffTarget(
    user,
    parsed.data.target_user_id,
  );
  if (!target) return domainFailure("page-permissions.staffMemberNotFound");
  if (await primaryAdminMutationBlocked(user, target.id)) {
    return domainFailure(
      "page-permissions.thePrimaryClinicAdminCannotBeCustomized",
    );
  }
  if (!managerCanManageStaffTarget(user.role, target.role)) {
    return domainFailure("page-permissions.onlyAdminsCanCustomizeAdminUsers");
  }

  const roleSlugs = new Set<string>(getRolePageSlugs(target.role));
  const rows = parsed.data.changes
    .filter(
      (change) =>
        change.page_slug !== "dashboard" && roleSlugs.has(change.page_slug),
    )
    .map((change) => ({
      user_id: target.id,
      clinic_id: user.clinicId,
      page_slug: change.page_slug,
      is_visible: change.is_visible,
    }));
  if (rows.length === 0) {
    return domainSuccess(
      { staff_id: target.id, written: 0 },
      {
        targetTable: "user_page_permissions",
        targetRecordIds: [target.id],
        before: [],
        after: [],
      },
    );
  }

  const admin = createClinicScopedAdminClient(user.clinicId);
  const saved = await admin
    .from("user_page_permissions")
    .upsert(rows, { onConflict: "user_id,page_slug" });
  if (isMissingPagePermissionsTable(saved.error)) {
    for (const row of rows) {
      const fallback = await admin.from("user_customizations").upsert(
        {
          profile_id: target.id,
          clinic_id: user.clinicId,
          feature: "_visible",
          page: row.page_slug,
          access: row.is_visible ? "read_edit" : "hidden",
        },
        { onConflict: "profile_id,page,feature" },
      );
      if (fallback.error) {
        return domainFailure(
          "page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain",
        );
      }
    }
  } else if (saved.error) {
    return domainFailure(
      "page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  }
  revalidatePath("/settings/customize");
  return domainSuccess(
    { staff_id: target.id, written: rows.length },
    {
      targetTable: "user_page_permissions",
      targetRecordIds: [target.id],
      before: [],
      after: rows,
    },
  );
}

/** Report-visibility twin of {@link savePagePermissionsMutation}. */
export async function saveReportPermissionsMutation(
  user: AuthedUser,
  input: unknown,
): Promise<DomainMutationResult<{ staff_id: string; written: number }>> {
  assertDomainMutationRole(user, PRIVILEGED_ADMIN_ONLY_ROLES);
  const parsed = reportPermissionBatchActionSchema.safeParse(input);
  if (!parsed.success) {
    return domainFailure(
      "page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain",
      { validationError: parsed.error },
    );
  }
  const denied = await assertPrimaryAdminPermissionActor(user);
  if (denied) return denied;
  const target = await loadPrivilegedStaffTarget(
    user,
    parsed.data.target_user_id,
  );
  if (!target) return domainFailure("page-permissions.staffMemberNotFound");
  if (await primaryAdminMutationBlocked(user, target.id)) {
    return domainFailure(
      "page-permissions.thePrimaryClinicAdminCannotBeCustomized",
    );
  }

  const allowed = new Set<string>(reportsOpenableByRole(target.role));
  const rows = parsed.data.changes
    .filter(
      (change) => isReportId(change.report_id) && allowed.has(change.report_id),
    )
    .map((change) => ({
      user_id: target.id,
      clinic_id: user.clinicId,
      report_id: change.report_id,
      is_visible: change.is_visible,
    }));
  if (rows.length === 0) {
    return domainSuccess(
      { staff_id: target.id, written: 0 },
      {
        targetTable: "user_report_permissions",
        targetRecordIds: [target.id],
        before: [],
        after: [],
      },
    );
  }

  const admin = createClinicScopedAdminClient(user.clinicId);
  const saved = await admin
    .from("user_report_permissions")
    .upsert(rows, { onConflict: "user_id,report_id" });
  if (saved.error) {
    return domainFailure(
      "page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  }
  revalidatePath("/settings/customize");
  return domainSuccess(
    { staff_id: target.id, written: rows.length },
    {
      targetTable: "user_report_permissions",
      targetRecordIds: [target.id],
      before: [],
      after: rows,
    },
  );
}

export async function setAiPermissionMutation(
  user: AuthedUser,
  input: unknown,
  mode: DomainMutationMode = "execute",
): Promise<DomainMutationResult<PrivilegedSettingsMutationData>> {
  assertDomainMutationRole(user, PRIVILEGED_ADMIN_ONLY_ROLES);
  const parsed = aiPermissionActionSchema.safeParse(input);
  if (!parsed.success) {
    return domainFailure("ai-permissions.unknownPermission", {
      validationError: parsed.error,
    });
  }
  const denied = await assertPrimaryAdminPermissionActor(
    user,
    "ai-permissions.primaryAdminOnly",
  );
  if (denied) return denied;
  const permissionKey = parsed.data.permission_key as AiUserPermissionKey;
  const entitlements = await getEntitlements(user.clinicId);
  if (
    permissionKey === "ai.financial_insights" &&
    !hasFeature(entitlements, AI_FINANCIAL_INSIGHTS_FEATURE)
  ) {
    return domainFailure(
      "ai-permissions.planDoesNotIncludeFinancialAi",
    );
  }
  const target = await loadPrivilegedStaffTarget(
    user,
    parsed.data.target_user_id,
  );
  if (!target || target.is_deleted || target.deleted_at) {
    return domainFailure("ai-permissions.staffMemberNotFound");
  }
  if (!AI_PERMISSION_GRANTABLE_ROLES[permissionKey].includes(target.role)) {
    return domainFailure(
      "ai-permissions.thisPermissionDoesNotApplyToThatRole",
    );
  }
  const admin = createClinicScopedAdminClient(user.clinicId);
  const stored = await admin
    .from("user_ai_permissions")
    .select("granted")
    .eq("clinic_id", user.clinicId)
    .eq("user_id", target.id)
    .eq("permission_key", permissionKey)
    .maybeSingle();
  if (stored.error) {
    return domainFailure(
      "ai-permissions.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  }
  const before = {
    id: target.id,
    full_name: target.full_name,
    permission_key: permissionKey,
    granted: stored.data?.granted === true,
  };
  const after = { ...before, granted: parsed.data.granted };
  if (mode === "preview") {
    return domainSuccess(
      { staff_id: target.id },
      {
        targetTable: "user_ai_permissions",
        targetRecordIds: [target.id],
        before,
        after,
      },
    );
  }
  const saved = await admin.from("user_ai_permissions").upsert(
    {
      user_id: target.id,
      clinic_id: user.clinicId,
      permission_key: permissionKey,
      granted: parsed.data.granted,
      updated_by: user.id,
    },
    { onConflict: "clinic_id,user_id,permission_key" },
  );
  if (saved.error) {
    return domainFailure(
      "ai-permissions.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
  }
  revalidatePath("/settings/ai");
  return domainSuccess(
    { staff_id: target.id },
    {
      targetTable: "user_ai_permissions",
      targetRecordIds: [target.id],
      before,
      after,
    },
  );
}
