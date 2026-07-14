"use server";

import { actionError, actionWeekday } from "@/lib/i18n/action-errors";
import { revalidatePath, revalidateTag } from "next/cache";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  requireMutationRole as requireRole,
  requireRole as requireReadRole,
} from "@/lib/rbac";
import { ensureDefaultPagePermissions } from "@/actions/page-permissions";
import {
  createStaffSchema,
  updateStaffSchema,
  departmentSchema,
  insuranceSchema,
  clinicSchema,
  serviceSchema,
  clinicWorkingHoursSchema,
  doctorScheduleSchema,
  type ClinicWorkingHoursValues,
  type DoctorScheduleValues,
} from "@/lib/validations/settings";
import { normalizePhone } from "@/lib/phone/registry";

export interface ActionResult {
  error?: string;
  success?: boolean;
  staffId?: string;
}

// ── Staff ────────────────────────────────────────────────────────────────────

async function getStaffTargetForClinic(
  staffId: string,
  clinicId: string,
) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, clinic_id, role")
    .eq("id", staffId)
    .eq("clinic_id", clinicId)
    .single();

  return data;
}

function managerCanManageTarget(
  actorRole: string,
  targetRole: string,
) {
  return actorRole === "admin" || targetRole !== "admin";
}

export async function createStaff(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  const parsed = createStaffSchema.safeParse({
    full_name: fd.get("full_name"),
    email: fd.get("email"),
    temporary_password: fd.get("temporary_password"),
    role: fd.get("role"),
    department_id: fd.get("department_id") || null,
    phone: fd.get("phone") || null,
  });

  if (!parsed.success) {
    return { error: await actionError("settings.validationError") };
  }

  const { full_name, email, temporary_password, role, department_id, phone } =
    parsed.data;

  if (user.role !== "admin" && role === "admin") {
    return { error: await actionError("settings.onlyAdminsCanCreateAdminUsers") };
  }

  const adminClient = createClinicScopedAdminClient(user.clinicId);

  // Create auth user via Admin API (auto-confirmed, no email verify)
  const { data: authData, error: authError } =
    await adminClient.auth.admin.createUser({
      email,
      password: temporary_password,
      email_confirm: true,
    });

  if (authError || !authData.user) {
    if (authError?.message?.includes("already been registered")) {
      return { error: await actionError("settings.aStaffMemberWithThisEmailAlreadyExists") };
    }
    return { error: await actionError("settings.failedToCreateAuthUser") };
  }

  const userId = authData.user.id;

  // Insert profile
  const supabase = await createClient();
  const { error: profileError } = await supabase.from("profiles").insert({
    id: userId,
    clinic_id: user.clinicId,
    full_name,
    role,
    department_id: department_id ?? null,
    phone: phone ? normalizePhone(phone) : null,
    must_change_password: true,
    is_active: true,
  });

  if (profileError) {
    // Roll back auth user if profile insert fails
    await adminClient.auth.admin.deleteUser(userId);
    return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  }

  if (user.role === "admin" || user.role === "manager") {
    await ensureDefaultPagePermissions(userId, role, user.clinicId);
  }

  revalidateTag(`staff:${user.clinicId}`, {});
  revalidatePath("/settings/staff");
  return { success: true, staffId: userId };
}

export async function updateStaff(
  staffId: string,
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  const parsed = updateStaffSchema.safeParse({
    full_name: fd.get("full_name"),
    role: fd.get("role"),
    department_id: fd.get("department_id") || null,
    phone: fd.get("phone") || null,
    is_active: fd.get("is_active") === "true",
  });

  if (!parsed.success) {
    return { error: await actionError("settings.validationError") };
  }

  // Prevent self-deactivation
  if (staffId === user.id && !parsed.data.is_active) {
    return { error: await actionError("settings.youCannotDeactivateYourOwnAccount") };
  }

  const target = await getStaffTargetForClinic(staffId, user.clinicId);
  if (!target) return { error: await actionError("settings.staffMemberNotFound") };
  if (!managerCanManageTarget(user.role, target.role)) {
    return { error: await actionError("settings.onlyAdminsCanManageAdminUsers") };
  }
  if (user.role !== "admin" && parsed.data.role !== target.role) {
    return { error: await actionError("settings.onlyAdminsCanChangeStaffRoles") };
  }

  const supabase = await createClient();
  const { error, count } = await supabase
    .from("profiles")
    .update({
      full_name: parsed.data.full_name,
      role: parsed.data.role,
      department_id: parsed.data.department_id ?? null,
      phone: parsed.data.phone ? normalizePhone(parsed.data.phone) : null,
      is_active: parsed.data.is_active,
    }, { count: "exact" })
    .eq("id", staffId)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  if (!count) return { error: await actionError("settings.couldNotUpdateThisStaffMemberYouMayLackPermission") };

  if (user.role === "admin" || user.role === "manager") {
    await ensureDefaultPagePermissions(staffId, parsed.data.role, user.clinicId);
  }

  revalidateTag(`staff:${user.clinicId}`, {});
  revalidatePath("/settings/staff");
  return { success: true };
}

export async function toggleStaffActive(
  staffId: string,
  isActive: boolean,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  if (staffId === user.id && !isActive) {
    return { error: await actionError("settings.youCannotDeactivateYourOwnAccount") };
  }

  const target = await getStaffTargetForClinic(staffId, user.clinicId);
  if (!target) return { error: await actionError("settings.staffMemberNotFound") };
  if (!managerCanManageTarget(user.role, target.role)) {
    return { error: await actionError("settings.onlyAdminsCanManageAdminUsers") };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ is_active: isActive })
    .eq("id", staffId)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  revalidateTag(`staff:${user.clinicId}`, {});
  revalidatePath("/settings/staff");
  return { success: true };
}

export async function softDeleteStaff(staffId: string): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  if (staffId === user.id) {
    return { error: await actionError("settings.youCannotDeleteYourOwnAccount") };
  }

  const target = await getStaffTargetForClinic(staffId, user.clinicId);
  if (!target) return { error: await actionError("settings.staffMemberNotFound") };
  if (!managerCanManageTarget(user.role, target.role)) {
    return { error: await actionError("settings.onlyAdminsCanManageAdminUsers") };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ deleted_at: new Date().toISOString(), is_active: false })
    .eq("id", staffId)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  revalidateTag(`staff:${user.clinicId}`, {});
  revalidatePath("/settings/staff");
  return { success: true };
}

export async function restoreStaff(staffId: string): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  const target = await getStaffTargetForClinic(staffId, user.clinicId);
  if (!target) return { error: await actionError("settings.staffMemberNotFound") };
  if (!managerCanManageTarget(user.role, target.role)) {
    return { error: await actionError("settings.onlyAdminsCanManageAdminUsers") };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ deleted_at: null, is_active: true })
    .eq("id", staffId)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  revalidateTag(`staff:${user.clinicId}`, {});
  revalidatePath("/settings/staff");
  return { success: true };
}

export async function deleteStaff(staffId: string): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  if (staffId === user.id) {
    return { error: await actionError("settings.youCannotDeleteYourOwnAccount") };
  }

  const supabase = await createClient();

  // Verify same clinic (RLS also enforces)
  const { data: target } = await supabase
    .from("profiles")
    .select("id, clinic_id, role")
    .eq("id", staffId)
    .single();

  if (!target || target.clinic_id !== user.clinicId) {
    return { error: await actionError("settings.staffMemberNotFound") };
  }
  if (!managerCanManageTarget(user.role, target.role)) {
    return { error: await actionError("settings.onlyAdminsCanManageAdminUsers") };
  }

  // Delete auth user → cascades to profile via FK on auth.users
  const adminClient = createClinicScopedAdminClient(user.clinicId);
  const { error } = await adminClient.auth.admin.deleteUser(staffId);
  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  // Best-effort profile cleanup if FK cascade didn't fire
  await supabase.from("profiles").delete().eq("id", staffId);

  revalidateTag(`staff:${user.clinicId}`, {});
  revalidatePath("/settings/staff");
  return { success: true };
}

const temporaryPasswordSchema = createStaffSchema.pick({
  temporary_password: true,
});

export async function resetStaffPassword(
  staffId: string,
  temporaryPassword: string,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  const parsed = temporaryPasswordSchema.safeParse({
    temporary_password: temporaryPassword,
  });
  if (!parsed.success) {
    return { error: await actionError("settings.invalidPassword") };
  }

  const target = await getStaffTargetForClinic(staffId, user.clinicId);
  if (!target) return { error: await actionError("settings.staffMemberNotFound") };
  if (!managerCanManageTarget(user.role, target.role)) {
    return { error: await actionError("settings.onlyAdminsCanManageAdminUsers") };
  }

  const adminClient = createClinicScopedAdminClient(user.clinicId);

  const { error } = await adminClient.auth.admin.updateUserById(staffId, {
    password: parsed.data.temporary_password,
  });

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  // Force must_change_password
  const supabase = await createClient();
  await supabase
    .from("profiles")
    .update({ must_change_password: true })
    .eq("id", staffId)
    .eq("clinic_id", user.clinicId);

  revalidateTag(`staff:${user.clinicId}`, {});
  revalidatePath("/settings/staff");
  return { success: true };
}

export async function emptyStaffTrash(): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();

  const { data: targets, error: selectError } = await supabase
    .from("profiles")
    .select("id, role")
    .eq("clinic_id", user.clinicId)
    .not("deleted_at", "is", null);

  if (selectError) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  const staff = targets ?? [];
  if (staff.some((target) => target.id === user.id)) {
    return { error: await actionError("settings.youCannotPermanentlyDeleteYourOwnAccount") };
  }
  if (
    user.role !== "admin" &&
    staff.some((target) => target.role === "admin")
  ) {
    return { error: await actionError("settings.onlyAdminsCanEmptyTrashContainingAdminUsers") };
  }
  if (staff.length === 0) return { success: true };

  const adminClient = createClinicScopedAdminClient(user.clinicId);
  for (const target of staff) {
    const { error } = await adminClient.auth.admin.deleteUser(target.id);
    if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  }

  await supabase
    .from("profiles")
    .delete()
    .eq("clinic_id", user.clinicId)
    .in(
      "id",
      staff.map((target) => target.id),
    )
    .not("deleted_at", "is", null);

  revalidateTag(`staff:${user.clinicId}`, {});
  revalidatePath("/settings/staff");
  return { success: true };
}

// ── Departments ──────────────────────────────────────────────────────────────

export async function createDepartment(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  const parsed = departmentSchema.safeParse({
    name: fd.get("name"),
    color: fd.get("color"),
    description: fd.get("description") || null,
  });

  if (!parsed.success) {
    return { error: await actionError("settings.validationError") };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("departments").insert({
    ...parsed.data,
    clinic_id: user.clinicId,
  });

  if (error) {
    if (error.code === "23505") return { error: await actionError("settings.aDepartmentWithThisNameAlreadyExists") };
    return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  }

  revalidateTag(`departments:${user.clinicId}`, {});
  revalidatePath("/settings/departments");
  return { success: true };
}

export async function updateDepartment(
  deptId: string,
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  const parsed = departmentSchema.safeParse({
    name: fd.get("name"),
    color: fd.get("color"),
    description: fd.get("description") || null,
  });

  if (!parsed.success) {
    return { error: await actionError("settings.validationError") };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("departments")
    .update(parsed.data)
    .eq("id", deptId)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  revalidateTag(`departments:${user.clinicId}`, {});
  revalidatePath("/settings/departments");
  return { success: true };
}

export async function toggleDepartmentActive(
  deptId: string,
  isActive: boolean,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  const supabase = await createClient();
  const { error } = await supabase
    .from("departments")
    .update({ is_active: isActive })
    .eq("id", deptId)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  revalidateTag(`departments:${user.clinicId}`, {});
  revalidatePath("/settings/departments");
  return { success: true };
}

export async function softDeleteDepartment(deptId: string): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("departments")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", deptId)
    .eq("clinic_id", user.clinicId);
  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  revalidateTag(`departments:${user.clinicId}`, {});
  revalidatePath("/settings/departments");
  return { success: true };
}

export async function restoreDepartment(deptId: string): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("departments")
    .update({ deleted_at: null })
    .eq("id", deptId)
    .eq("clinic_id", user.clinicId);
  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  revalidateTag(`departments:${user.clinicId}`, {});
  revalidatePath("/settings/departments");
  return { success: true };
}

export async function permanentDeleteDepartment(deptId: string): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("departments")
    .delete()
    .eq("id", deptId)
    .eq("clinic_id", user.clinicId)
    .not("deleted_at", "is", null);
  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  revalidateTag(`departments:${user.clinicId}`, {});
  revalidatePath("/settings/departments");
  return { success: true };
}

export async function emptyDepartmentsTrash(): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("departments")
    .delete()
    .eq("clinic_id", user.clinicId)
    .not("deleted_at", "is", null);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  revalidateTag(`departments:${user.clinicId}`, {});
  revalidatePath("/settings/departments");
  return { success: true };
}

// ── Insurance ────────────────────────────────────────────────────────────────

export async function createInsurance(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  const parsed = insuranceSchema.safeParse({
    name: fd.get("name"),
    code: fd.get("code") || null,
  });

  if (!parsed.success) {
    return { error: await actionError("settings.validationError") };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("insurance_providers").insert({
    ...parsed.data,
    clinic_id: user.clinicId,
  });

  if (error) {
    if (error.code === "23505") return { error: await actionError("settings.anInsuranceProviderWithThisNameAlreadyExists") };
    return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  }

  revalidateTag(`insurance:${user.clinicId}`, {});
  revalidatePath("/settings/insurance");
  return { success: true };
}

export async function updateInsurance(
  insuranceId: string,
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  const parsed = insuranceSchema.safeParse({
    name: fd.get("name"),
    code: fd.get("code") || null,
  });

  if (!parsed.success) {
    return { error: await actionError("settings.validationError") };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("insurance_providers")
    .update(parsed.data)
    .eq("id", insuranceId)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  revalidateTag(`insurance:${user.clinicId}`, {});
  revalidatePath("/settings/insurance");
  return { success: true };
}

export async function toggleInsuranceActive(
  insuranceId: string,
  isActive: boolean,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  const supabase = await createClient();
  const { error } = await supabase
    .from("insurance_providers")
    .update({ is_active: isActive })
    .eq("id", insuranceId)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  revalidateTag(`insurance:${user.clinicId}`, {});
  revalidatePath("/settings/insurance");
  return { success: true };
}

export async function softDeleteInsurance(insuranceId: string): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("insurance_providers")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", insuranceId)
    .eq("clinic_id", user.clinicId);
  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  revalidateTag(`insurance:${user.clinicId}`, {});
  revalidatePath("/settings/insurance");
  return { success: true };
}

export async function restoreInsurance(insuranceId: string): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("insurance_providers")
    .update({ deleted_at: null })
    .eq("id", insuranceId)
    .eq("clinic_id", user.clinicId);
  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  revalidateTag(`insurance:${user.clinicId}`, {});
  revalidatePath("/settings/insurance");
  return { success: true };
}

export async function permanentDeleteInsurance(insuranceId: string): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("insurance_providers")
    .delete()
    .eq("id", insuranceId)
    .eq("clinic_id", user.clinicId)
    .not("deleted_at", "is", null);
  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  revalidateTag(`insurance:${user.clinicId}`, {});
  revalidatePath("/settings/insurance");
  return { success: true };
}

export async function emptyInsuranceTrash(): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("insurance_providers")
    .delete()
    .eq("clinic_id", user.clinicId)
    .not("deleted_at", "is", null);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  revalidateTag(`insurance:${user.clinicId}`, {});
  revalidatePath("/settings/insurance");
  return { success: true };
}

// ── Clinic ───────────────────────────────────────────────────────────────────

export async function updateClinic(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  const parsed = clinicSchema.safeParse({
    name: fd.get("name"),
    phone: fd.get("phone") || null,
    address: fd.get("address") || null,
    time_format: fd.get("time_format") || "24h",
  });

  if (!parsed.success) {
    return { error: await actionError("settings.validationError") };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("clinics")
    .update({
      name: parsed.data.name,
      phone: parsed.data.phone ? normalizePhone(parsed.data.phone) : null,
      address: parsed.data.address ?? null,
      time_format: parsed.data.time_format,
    })
    .eq("id", user.clinicId);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  revalidatePath("/", "layout");
  return { success: true };
}

export async function uploadClinicLogo(fd: FormData): Promise<ActionResult & { url?: string }> {
  const user = await requireRole(["admin", "manager"]);

  const file = fd.get("logo") as File | null;
  if (!file || file.size === 0) return { error: await actionError("settings.noFileProvided") };

  const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
  if (file.size > MAX_SIZE) return { error: await actionError("settings.fileMustBeUnder5Mb") };

  const allowedTypes = ["image/png", "image/jpeg", "image/svg+xml"];
  if (!allowedTypes.includes(file.type)) {
    return { error: await actionError("settings.onlyPngJpegOrSvgFilesAreAccepted") };
  }

  const ext = file.name.split(".").pop() ?? "png";
  const path = `clinics/${user.clinicId}/logo.${ext}`;

  const supabase = await createClient();
  const { error: uploadError } = await supabase.storage
    .from("clinic-assets")
    .upload(path, file, { upsert: true, contentType: file.type });

  if (uploadError) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  const { data: urlData } = supabase.storage
    .from("clinic-assets")
    .getPublicUrl(path);

  const logoUrl = `${urlData.publicUrl}?t=${Date.now()}`;

  await supabase.from("clinics").update({ logo_url: logoUrl }).eq("id", user.clinicId);

  revalidatePath("/settings/clinic");
  return { success: true, url: logoUrl };
}

// ── Services ─────────────────────────────────────────────────────────────────

export async function createService(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  const parsed = serviceSchema.safeParse({
    department_id: fd.get("department_id"),
    name: fd.get("name"),
    price: Number(fd.get("price")),
  });

  if (!parsed.success) {
    return { error: await actionError("settings.validationError") };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("services").insert({
    clinic_id: user.clinicId,
    department_id: parsed.data.department_id,
    name: parsed.data.name,
    price: Number(parsed.data.price.toFixed(2)),
    is_active: true,
  });

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  revalidateTag(`services:${user.clinicId}`, {});
  revalidatePath("/settings/services");
  return { success: true };
}

export async function updateService(
  serviceId: string,
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);

  const parsed = serviceSchema.safeParse({
    department_id: fd.get("department_id"),
    name: fd.get("name"),
    price: Number(fd.get("price")),
  });

  if (!parsed.success) {
    return { error: await actionError("settings.validationError") };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("services")
    .update({
      department_id: parsed.data.department_id,
      name: parsed.data.name,
      price: Number(parsed.data.price.toFixed(2)),
    })
    .eq("id", serviceId)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  revalidateTag(`services:${user.clinicId}`, {});
  revalidatePath("/settings/services");
  return { success: true };
}

export async function softDeleteService(serviceId: string): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("services")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", serviceId)
    .eq("clinic_id", user.clinicId);
  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  revalidateTag(`services:${user.clinicId}`, {});
  revalidatePath("/settings/services");
  return { success: true };
}

export async function restoreService(serviceId: string): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("services")
    .update({ deleted_at: null })
    .eq("id", serviceId)
    .eq("clinic_id", user.clinicId);
  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  revalidateTag(`services:${user.clinicId}`, {});
  revalidatePath("/settings/services");
  return { success: true };
}

export async function deleteService(serviceId: string): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("services")
    .delete()
    .eq("id", serviceId)
    .eq("clinic_id", user.clinicId)
    .not("deleted_at", "is", null);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  revalidateTag(`services:${user.clinicId}`, {});
  revalidatePath("/settings/services");
  return { success: true };
}

export async function emptyServicesTrash(): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("services")
    .delete()
    .eq("clinic_id", user.clinicId)
    .not("deleted_at", "is", null);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  revalidateTag(`services:${user.clinicId}`, {});
  revalidatePath("/settings/services");
  return { success: true };
}

export async function toggleServiceActive(
  serviceId: string,
  isActive: boolean,
): Promise<ActionResult> {
  const user = await requireRole(["admin", "manager"]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("services")
    .update({ is_active: isActive })
    .eq("id", serviceId)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  revalidateTag(`services:${user.clinicId}`, {});
  revalidatePath("/settings/services");
  return { success: true };
}

// ── Clinic working hours ──────────────────────────────────────────────────────

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

export async function getClinicWorkingHours(): Promise<ClinicWorkingHoursValues> {
  const user = await requireReadRole(["admin", "manager", "receptionist", "doctor"]);
  const supabase = await createClient();

  const { data } = await supabase
    .from("clinic_working_hours")
    .select("day_of_week, shift_start, shift_end")
    .eq("clinic_id", user.clinicId)
    .order("day_of_week")
    .order("shift_start");

  const rows = data ?? [];

  return ALL_DAYS.map((dow) => {
    const dayRows = rows.filter((r) => r.day_of_week === dow);
    return {
      day_of_week: dow,
      open: dayRows.length > 0,
      shifts: dayRows.map((r) => ({
        shift_start: (r.shift_start as string).slice(0, 5),
        shift_end: (r.shift_end as string).slice(0, 5),
      })),
    };
  });
}

export async function upsertClinicWorkingHours(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireRole(["admin"]);

  const raw = fd.get("working_hours");
  if (typeof raw !== "string") return { error: await actionError("settings.invalidPayload") };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: await actionError("settings.invalidPayload") };
  }

  const result = clinicWorkingHoursSchema.safeParse(parsed);
  if (!result.success) {
    return { error: await actionError("settings.validationError2") };
  }

  const rows = result.data
    .filter((d) => d.open && d.shifts.length > 0)
    .flatMap((d) =>
      d.shifts.map((s) => ({
        clinic_id: user.clinicId,
        day_of_week: d.day_of_week,
        shift_start: s.shift_start,
        shift_end: s.shift_end,
      })),
    );

  const supabase = await createClient();

  const { error: delErr } = await supabase
    .from("clinic_working_hours")
    .delete()
    .eq("clinic_id", user.clinicId);
  if (delErr) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  if (rows.length > 0) {
    const { error: insErr } = await supabase
      .from("clinic_working_hours")
      .insert(rows);
    if (insErr) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  }

  revalidatePath("/settings/clinic");
  return { success: true };
}

// ── Doctor schedule ───────────────────────────────────────────────────────────

export async function getDoctorSchedule(
  doctorId: string,
): Promise<DoctorScheduleValues> {
  const user = await requireReadRole(["admin", "manager", "receptionist", "doctor"]);
  const supabase = await createClient();

  const { data } = await supabase
    .from("doctor_schedules")
    .select("day_of_week, start_time, end_time")
    .eq("doctor_id", doctorId)
    .eq("clinic_id", user.clinicId)
    .order("day_of_week");

  const rows = data ?? [];

  return ALL_DAYS.map((dow) => {
    const row = rows.find((r) => r.day_of_week === dow);
    return {
      day_of_week: dow,
      works: !!row,
      start_time: row ? (row.start_time as string).slice(0, 5) : null,
      end_time: row ? (row.end_time as string).slice(0, 5) : null,
    };
  });
}

export async function upsertDoctorSchedule(
  doctorId: string,
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireRole(["admin"]);

  const raw = fd.get("schedule");
  if (typeof raw !== "string") return { error: await actionError("settings.invalidPayload") };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: await actionError("settings.invalidPayload") };
  }

  const result = doctorScheduleSchema.safeParse(parsed);
  if (!result.success) {
    return { error: await actionError("settings.validationError2") };
  }

  // Validate each working day against clinic working hours
  const clinicHours = await getClinicWorkingHours();
  const clinicHasConfig = clinicHours.some((d) => d.open);

  if (clinicHasConfig) {
    for (const day of result.data) {
      if (!day.works || !day.start_time || !day.end_time) continue;
      const clinicDay = clinicHours.find((c) => c.day_of_week === day.day_of_week);
      if (!clinicDay?.open || clinicDay.shifts.length === 0) {
        return {
          error: await actionError("settings.doctorScheduleOnClosedDay", { day: await actionWeekday(day.day_of_week) }),
        };
      }
      const clinicOpen = clinicDay.shifts.reduce((min, s) => s.shift_start < min ? s.shift_start : min, clinicDay.shifts[0].shift_start);
      const clinicClose = clinicDay.shifts.reduce((max, s) => s.shift_end > max ? s.shift_end : max, clinicDay.shifts[0].shift_end);
      if (day.start_time < clinicOpen || day.end_time > clinicClose) {
        return {
          error: await actionError("settings.doctorHoursOutsideClinicHours", {
            day: await actionWeekday(day.day_of_week),
            start: day.start_time,
            end: day.end_time,
            clinicOpen,
            clinicClose,
          }),
        };
      }
    }
  }

  const rows = result.data
    .filter((d) => d.works && d.start_time && d.end_time)
    .map((d) => ({
      doctor_id: doctorId,
      clinic_id: user.clinicId,
      day_of_week: d.day_of_week,
      start_time: d.start_time as string,
      end_time: d.end_time as string,
    }));

  const supabase = await createClient();

  const { error: delErr } = await supabase
    .from("doctor_schedules")
    .delete()
    .eq("doctor_id", doctorId)
    .eq("clinic_id", user.clinicId);
  if (delErr) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };

  if (rows.length > 0) {
    const { error: insErr } = await supabase
      .from("doctor_schedules")
      .insert(rows);
    if (insErr) return { error: await actionError("settings.weCouldNotCompleteThisRequestPleaseTryAgain") };
  }

  revalidatePath("/settings/staff");
  return { success: true };
}
