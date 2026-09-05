"use server";

import { domainFailureToActionResult } from "@/actions/_domain";
import * as legacy from "@/actions/settings-legacy";
import {
  createDirectoryMutation,
  createStaffMutation,
  directoryLifecycleMutation,
  resetStaffPasswordMutation,
  setStaffActiveMutation,
  staffLifecycleMutation,
  updateClinicMutation,
  updateDirectoryMutation,
  updateInvoiceFollowupSettingsMutation,
  updateReminderSettingsMutation,
  updateStaffMutation,
  updateStaffProfileMutation,
  upsertClinicWorkingHoursMutation,
  upsertStaffScheduleMutation,
  upsertStaffShiftTemplatesMutation,
} from "@/lib/settings/mutations";
import { requireMutationRole } from "@/lib/rbac";
import type {
  ClinicWorkingHoursValues,
  DoctorScheduleValues,
  StaffShiftTemplatesValues,
} from "@/lib/validations/settings";

export interface ActionResult {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  success?: boolean;
  staffId?: string;
}

function successOrFailure(
  result: Awaited<ReturnType<typeof createDirectoryMutation>>,
): Promise<ActionResult> | ActionResult {
  return result.ok
    ? { success: true, ...(result.data.id ? { staffId: result.data.id } : {}) }
    : domainFailureToActionResult(result);
}

function staffFormInput(fd: FormData) {
  return {
    full_name: fd.get("full_name"),
    email: fd.get("email"),
    temporary_password: fd.get("temporary_password"),
    role: fd.get("role"),
    department_id: fd.get("department_id") || null,
    phone: fd.get("phone") || null,
    supervising_doctor_ids: fd.getAll("supervising_doctor_ids").map(String),
  };
}

export const getAssistantSupervisingDoctorIds =
  legacy.getAssistantSupervisingDoctorIds;

export async function createStaff(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "manager"]);
  const result = await createStaffMutation(user, staffFormInput(fd));
  if (!result.ok) return domainFailureToActionResult(result);
  return { success: true, staffId: result.data.staff_id };
}

export async function updateStaff(
  staffId: string,
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "manager"]);
  const result = await updateStaffMutation(user, {
    staff_id: staffId,
    values: {
      full_name: fd.get("full_name"),
      role: fd.get("role"),
      department_id: fd.get("department_id") || null,
      phone: fd.get("phone") || null,
      is_active: fd.get("is_active") === "true",
      supervising_doctor_ids: fd
        .getAll("supervising_doctor_ids")
        .map(String),
    },
  });
  return result.ok ? { success: true } : domainFailureToActionResult(result);
}

export async function toggleStaffActive(
  staffId: string,
  isActive: boolean,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "manager"]);
  const result = await setStaffActiveMutation(user, {
    staff_id: staffId,
    is_active: isActive,
  });
  return result.ok ? { success: true } : domainFailureToActionResult(result);
}

async function staffLifecycleAdapter(
  staffId: string,
  operation: "soft_delete" | "restore" | "permanent_delete",
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "manager"]);
  const result = await staffLifecycleMutation(
    user,
    operation,
    { staff_id: staffId },
  );
  return result.ok ? { success: true } : domainFailureToActionResult(result);
}

export async function softDeleteStaff(staffId: string): Promise<ActionResult> {
  return staffLifecycleAdapter(staffId, "soft_delete");
}

export async function restoreStaff(staffId: string): Promise<ActionResult> {
  return staffLifecycleAdapter(staffId, "restore");
}

export async function deleteStaff(staffId: string): Promise<ActionResult> {
  return staffLifecycleAdapter(staffId, "permanent_delete");
}

export async function resetStaffPassword(
  staffId: string,
  temporaryPassword: string,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "manager"]);
  const result = await resetStaffPasswordMutation(user, {
    staff_id: staffId,
    temporary_password: temporaryPassword,
  });
  return result.ok ? { success: true } : domainFailureToActionResult(result);
}

export const emptyStaffTrash = legacy.emptyStaffTrash;

export async function updateStaffProfileSection(
  staffId: string,
  input: { full_name: string; phone: string | null },
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "manager"]);
  const result = await updateStaffProfileMutation(user, {
    staff_id: staffId,
    profile: input,
  });
  return result.ok ? { success: true } : domainFailureToActionResult(result);
}

function departmentInput(fd: FormData) {
  return {
    name: fd.get("name"),
    color: fd.get("color"),
    description: fd.get("description") || null,
  };
}

export async function createDepartment(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "manager"]);
  return successOrFailure(
    await createDirectoryMutation(user, "department", departmentInput(fd)),
  );
}

export async function updateDepartment(
  deptId: string,
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "manager"]);
  return successOrFailure(
    await updateDirectoryMutation(user, "department", {
      department_id: deptId,
      ...departmentInput(fd),
    }),
  );
}

async function lifecycle(
  kind: "department" | "insurance" | "service",
  operation: "toggle" | "soft_delete" | "restore" | "permanent_delete",
  id: string,
  isActive?: boolean,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "manager"]);
  return successOrFailure(
    await directoryLifecycleMutation(user, kind, operation, {
      id,
      ...(operation === "toggle" ? { is_active: isActive } : {}),
    }),
  );
}

export async function toggleDepartmentActive(deptId: string, isActive: boolean) {
  return lifecycle("department", "toggle", deptId, isActive);
}
export async function softDeleteDepartment(deptId: string) {
  return lifecycle("department", "soft_delete", deptId);
}
export async function restoreDepartment(deptId: string) {
  return lifecycle("department", "restore", deptId);
}
export async function permanentDeleteDepartment(deptId: string) {
  return lifecycle("department", "permanent_delete", deptId);
}
export const emptyDepartmentsTrash = legacy.emptyDepartmentsTrash;

function insuranceInput(fd: FormData) {
  return { name: fd.get("name"), code: fd.get("code") || null };
}

export async function createInsurance(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "manager"]);
  return successOrFailure(
    await createDirectoryMutation(user, "insurance", insuranceInput(fd)),
  );
}

export async function updateInsurance(
  insuranceId: string,
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "manager"]);
  return successOrFailure(
    await updateDirectoryMutation(user, "insurance", {
      insurance_id: insuranceId,
      ...insuranceInput(fd),
    }),
  );
}

export async function toggleInsuranceActive(id: string, isActive: boolean) {
  return lifecycle("insurance", "toggle", id, isActive);
}
export async function softDeleteInsurance(id: string) {
  return lifecycle("insurance", "soft_delete", id);
}
export async function restoreInsurance(id: string) {
  return lifecycle("insurance", "restore", id);
}
export async function permanentDeleteInsurance(id: string) {
  return lifecycle("insurance", "permanent_delete", id);
}
export const emptyInsuranceTrash = legacy.emptyInsuranceTrash;

function clinicInput(fd: FormData) {
  return {
    name: fd.get("name"),
    phone: fd.get("phone") || null,
    address: fd.get("address") || null,
    email: fd.get("email") || null,
    website: fd.get("website") || null,
    license_no: fd.get("license_no") || null,
    tax_id: fd.get("tax_id") || null,
    document_footer: fd.get("document_footer") || null,
    branding_metadata: fd.get("branding_metadata") || "{}",
    time_format: fd.get("time_format") || "24h",
  };
}

export async function updateClinic(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "manager"]);
  const result = await updateClinicMutation(user, clinicInput(fd));
  return result.ok ? { success: true } : domainFailureToActionResult(result);
}

export async function updateReminderSettings(
  enabled: boolean,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "manager"]);
  const result = await updateReminderSettingsMutation(user, { enabled });
  return result.ok ? { success: true } : domainFailureToActionResult(result);
}

export type InvoiceFollowupSettingsInput = {
  enabled: boolean;
  firstDays: number;
  secondDays: number;
  emailSubject: string | null;
  emailBody: string | null;
};

export async function updateInvoiceFollowupSettings(
  input: InvoiceFollowupSettingsInput,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "manager"]);
  const result = await updateInvoiceFollowupSettingsMutation(user, {
    enabled: input.enabled,
    first_days: Math.trunc(Number(input.firstDays)),
    second_days: Math.trunc(Number(input.secondDays)),
    email_subject: input.emailSubject,
    email_body: input.emailBody,
  });
  return result.ok ? { success: true } : domainFailureToActionResult(result);
}

export const uploadClinicLogo = legacy.uploadClinicLogo;

function serviceInput(fd: FormData) {
  return {
    department_id: fd.get("department_id"),
    name: fd.get("name"),
    price: Number(fd.get("price")),
  };
}

export async function createService(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "manager"]);
  return successOrFailure(
    await createDirectoryMutation(user, "service", serviceInput(fd)),
  );
}

export async function updateService(
  serviceId: string,
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireMutationRole(["admin", "manager"]);
  return successOrFailure(
    await updateDirectoryMutation(user, "service", {
      service_id: serviceId,
      ...serviceInput(fd),
    }),
  );
}

export async function softDeleteService(id: string) {
  return lifecycle("service", "soft_delete", id);
}
export async function restoreService(id: string) {
  return lifecycle("service", "restore", id);
}
export async function deleteService(id: string) {
  return lifecycle("service", "permanent_delete", id);
}
export async function toggleServiceActive(id: string, isActive: boolean) {
  return lifecycle("service", "toggle", id, isActive);
}
export const emptyServicesTrash = legacy.emptyServicesTrash;

export const getClinicWorkingHours = legacy.getClinicWorkingHours as () =>
  Promise<ClinicWorkingHoursValues>;

export async function upsertClinicWorkingHours(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const raw = fd.get("working_hours");
  let days: unknown;
  try {
    if (typeof raw !== "string") throw new Error("invalid payload");
    days = JSON.parse(raw);
  } catch {
    days = raw;
  }
  const user = await requireMutationRole("admin");
  const result = await upsertClinicWorkingHoursMutation(user, { days });
  return result.ok ? { success: true } : domainFailureToActionResult(result);
}

export const getStaffSchedule = legacy.getStaffSchedule as (
  staffId: string,
) => Promise<DoctorScheduleValues>;

export async function upsertStaffSchedule(
  staffId: string,
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const raw = fd.get("schedule");
  let days: unknown;
  try {
    if (typeof raw !== "string") throw new Error("invalid payload");
    days = JSON.parse(raw);
  } catch {
    days = raw;
  }
  const user = await requireMutationRole("admin");
  const result = await upsertStaffScheduleMutation(user, {
    staff_id: staffId,
    days,
  });
  return result.ok ? { success: true } : domainFailureToActionResult(result);
}

export const getStaffShiftTemplates = legacy.getStaffShiftTemplates as () =>
  Promise<StaffShiftTemplatesValues>;

export async function upsertStaffShiftTemplates(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const raw = fd.get("templates");
  let templates: unknown;
  try {
    if (typeof raw !== "string") throw new Error("invalid payload");
    templates = JSON.parse(raw);
  } catch {
    templates = raw;
  }
  const user = await requireMutationRole("admin");
  const result = await upsertStaffShiftTemplatesMutation(user, { templates });
  return result.ok ? { success: true } : domainFailureToActionResult(result);
}

export const getDoctorSchedule = getStaffSchedule;
export const upsertDoctorSchedule = upsertStaffSchedule;
