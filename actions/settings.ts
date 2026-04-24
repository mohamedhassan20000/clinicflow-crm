"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/rbac";
import {
  createStaffSchema,
  updateStaffSchema,
  departmentSchema,
  insuranceSchema,
  clinicSchema,
} from "@/lib/validations/settings";

export interface ActionResult {
  error?: string;
  success?: boolean;
}

// ── Staff ────────────────────────────────────────────────────────────────────

export async function createStaff(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireRole("admin");

  const parsed = createStaffSchema.safeParse({
    full_name: fd.get("full_name"),
    email: fd.get("email"),
    role: fd.get("role"),
    department_id: fd.get("department_id") || null,
    phone: fd.get("phone") || null,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Validation error" };
  }

  const { full_name, email, role, department_id, phone } = parsed.data;

  // Generate a temporary password — user must change on first login
  const tempPassword = `Clinic@${Math.random().toString(36).slice(2, 10)}`;

  const adminClient = createAdminClient();

  // Create auth user via Admin API (auto-confirmed, no email verify)
  const { data: authData, error: authError } =
    await adminClient.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true,
    });

  if (authError || !authData.user) {
    if (authError?.message?.includes("already been registered")) {
      return { error: "A staff member with this email already exists." };
    }
    return { error: authError?.message ?? "Failed to create auth user." };
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
    phone: phone ?? null,
    must_change_password: true,
    is_active: true,
  });

  if (profileError) {
    // Roll back auth user if profile insert fails
    await adminClient.auth.admin.deleteUser(userId);
    return { error: profileError.message };
  }

  revalidatePath("/settings/staff");
  return { success: true };
}

export async function updateStaff(
  staffId: string,
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireRole("admin");

  const parsed = updateStaffSchema.safeParse({
    full_name: fd.get("full_name"),
    role: fd.get("role"),
    department_id: fd.get("department_id") || null,
    phone: fd.get("phone") || null,
    is_active: fd.get("is_active") === "true",
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Validation error" };
  }

  // Prevent self-deactivation
  if (staffId === user.id && !parsed.data.is_active) {
    return { error: "You cannot deactivate your own account." };
  }

  const supabase = await createClient();
  const { error, count } = await supabase
    .from("profiles")
    .update({
      full_name: parsed.data.full_name,
      role: parsed.data.role,
      department_id: parsed.data.department_id ?? null,
      phone: parsed.data.phone ?? null,
      is_active: parsed.data.is_active,
    }, { count: "exact" })
    .eq("id", staffId)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: error.message };
  if (!count) return { error: "Could not update this staff member. You may lack permission." };

  revalidatePath("/settings/staff");
  return { success: true };
}

export async function toggleStaffActive(
  staffId: string,
  isActive: boolean,
): Promise<ActionResult> {
  const user = await requireRole("admin");

  if (staffId === user.id && !isActive) {
    return { error: "You cannot deactivate your own account." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ is_active: isActive })
    .eq("id", staffId)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: error.message };

  revalidatePath("/settings/staff");
  return { success: true };
}

export async function deleteStaff(staffId: string): Promise<ActionResult> {
  const user = await requireRole("admin");

  if (staffId === user.id) {
    return { error: "You cannot delete your own account." };
  }

  const supabase = await createClient();

  // Verify same clinic (RLS also enforces)
  const { data: target } = await supabase
    .from("profiles")
    .select("id, clinic_id")
    .eq("id", staffId)
    .single();

  if (!target || target.clinic_id !== user.clinicId) {
    return { error: "Staff member not found." };
  }

  // Delete auth user → cascades to profile via FK on auth.users
  const adminClient = createAdminClient();
  const { error } = await adminClient.auth.admin.deleteUser(staffId);
  if (error) return { error: error.message };

  // Best-effort profile cleanup if FK cascade didn't fire
  await supabase.from("profiles").delete().eq("id", staffId);

  revalidatePath("/settings/staff");
  return { success: true };
}

export async function resetStaffPassword(staffId: string): Promise<ActionResult> {
  await requireRole("admin");

  const tempPassword = `Clinic@${Math.random().toString(36).slice(2, 10)}`;
  const adminClient = createAdminClient();

  const { error } = await adminClient.auth.admin.updateUserById(staffId, {
    password: tempPassword,
  });

  if (error) return { error: error.message };

  // Force must_change_password
  const supabase = await createClient();
  await supabase
    .from("profiles")
    .update({ must_change_password: true })
    .eq("id", staffId);

  revalidatePath("/settings/staff");
  return { success: true };
}

// ── Departments ──────────────────────────────────────────────────────────────

export async function createDepartment(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireRole("admin");

  const parsed = departmentSchema.safeParse({
    name: fd.get("name"),
    color: fd.get("color"),
    description: fd.get("description") || null,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Validation error" };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("departments").insert({
    ...parsed.data,
    clinic_id: user.clinicId,
  });

  if (error) {
    if (error.code === "23505") return { error: "A department with this name already exists." };
    return { error: error.message };
  }

  revalidatePath("/settings/departments");
  return { success: true };
}

export async function updateDepartment(
  deptId: string,
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireRole("admin");

  const parsed = departmentSchema.safeParse({
    name: fd.get("name"),
    color: fd.get("color"),
    description: fd.get("description") || null,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Validation error" };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("departments")
    .update(parsed.data)
    .eq("id", deptId)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: error.message };

  revalidatePath("/settings/departments");
  return { success: true };
}

export async function toggleDepartmentActive(
  deptId: string,
  isActive: boolean,
): Promise<ActionResult> {
  const user = await requireRole("admin");

  const supabase = await createClient();
  const { error } = await supabase
    .from("departments")
    .update({ is_active: isActive })
    .eq("id", deptId)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: error.message };

  revalidatePath("/settings/departments");
  return { success: true };
}

// ── Insurance ────────────────────────────────────────────────────────────────

export async function createInsurance(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireRole("admin");

  const parsed = insuranceSchema.safeParse({
    name: fd.get("name"),
    code: fd.get("code") || null,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Validation error" };
  }

  const supabase = await createClient();
  const { error } = await supabase.from("insurance_providers").insert({
    ...parsed.data,
    clinic_id: user.clinicId,
  });

  if (error) {
    if (error.code === "23505") return { error: "An insurance provider with this name already exists." };
    return { error: error.message };
  }

  revalidatePath("/settings/insurance");
  return { success: true };
}

export async function updateInsurance(
  insuranceId: string,
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireRole("admin");

  const parsed = insuranceSchema.safeParse({
    name: fd.get("name"),
    code: fd.get("code") || null,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Validation error" };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("insurance_providers")
    .update(parsed.data)
    .eq("id", insuranceId)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: error.message };

  revalidatePath("/settings/insurance");
  return { success: true };
}

export async function toggleInsuranceActive(
  insuranceId: string,
  isActive: boolean,
): Promise<ActionResult> {
  const user = await requireRole("admin");

  const supabase = await createClient();
  const { error } = await supabase
    .from("insurance_providers")
    .update({ is_active: isActive })
    .eq("id", insuranceId)
    .eq("clinic_id", user.clinicId);

  if (error) return { error: error.message };

  revalidatePath("/settings/insurance");
  return { success: true };
}

// ── Clinic ───────────────────────────────────────────────────────────────────

export async function updateClinic(
  _prev: ActionResult | null,
  fd: FormData,
): Promise<ActionResult> {
  const user = await requireRole("admin");

  const parsed = clinicSchema.safeParse({
    name: fd.get("name"),
    phone: fd.get("phone") || null,
    address: fd.get("address") || null,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Validation error" };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("clinics")
    .update({
      name: parsed.data.name,
      phone: parsed.data.phone ?? null,
      address: parsed.data.address ?? null,
    })
    .eq("id", user.clinicId);

  if (error) return { error: error.message };

  revalidatePath("/settings/clinic");
  return { success: true };
}

export async function uploadClinicLogo(fd: FormData): Promise<ActionResult & { url?: string }> {
  const user = await requireRole("admin");

  const file = fd.get("logo") as File | null;
  if (!file || file.size === 0) return { error: "No file provided." };

  const MAX_SIZE = 500 * 1024; // 500 KB
  if (file.size > MAX_SIZE) return { error: "File must be under 500 KB." };

  const allowedTypes = ["image/png", "image/jpeg", "image/svg+xml"];
  if (!allowedTypes.includes(file.type)) {
    return { error: "Only PNG, JPEG, or SVG files are accepted." };
  }

  const ext = file.name.split(".").pop() ?? "png";
  const path = `clinics/${user.clinicId}/logo.${ext}`;

  const supabase = await createClient();
  const { error: uploadError } = await supabase.storage
    .from("clinic-assets")
    .upload(path, file, { upsert: true, contentType: file.type });

  if (uploadError) return { error: uploadError.message };

  const { data: urlData } = supabase.storage
    .from("clinic-assets")
    .getPublicUrl(path);

  const logoUrl = `${urlData.publicUrl}?t=${Date.now()}`;

  await supabase.from("clinics").update({ logo_url: logoUrl }).eq("id", user.clinicId);

  revalidatePath("/settings/clinic");
  return { success: true, url: logoUrl };
}
