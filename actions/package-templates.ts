"use server";

import { actionError } from "@/lib/i18n/action-errors";
import { localizeZodFieldErrors } from "@/lib/validations/server";
import { revalidatePath } from "next/cache";
import { requireMutationRole } from "@/lib/rbac";
import { createClinicScopedAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  createPackageTemplateSchema,
  templateIdSchema,
  updatePackageTemplateSchema,
} from "@/lib/validations/package-template";

export type PackageTemplateActionResult = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  success?: boolean;
};

async function ensureDepartmentInClinic(
  departmentId: string,
  clinicId: string,
): Promise<PackageTemplateActionResult | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("departments")
    .select("id")
    .eq("id", departmentId)
    .eq("clinic_id", clinicId)
    .maybeSingle();

  if (error) return { error: await actionError("package-templates.failedToValidateDepartment") };
  if (!data) {
    return {
      fieldErrors: { department_id: [await actionError("package-templates.selectADepartmentFromThisClinic")] },
    };
  }
  return null;
}

async function ensureTemplateInClinic(templateId: string, clinicId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("package_templates")
    .select("id")
    .eq("id", templateId)
    .eq("clinic_id", clinicId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

function revalidateSettings() {
  revalidatePath("/settings/packages");
}

export async function createPackageTemplate(
  _prev: PackageTemplateActionResult | null,
  formData: FormData,
): Promise<PackageTemplateActionResult> {
  const user = await requireMutationRole(["admin"]);

  const parsed = createPackageTemplateSchema.safeParse({
    name: formData.get("name"),
    department_id: formData.get("department_id"),
    total_sessions: formData.get("total_sessions"),
    price_per_session: formData.get("price_per_session"),
    total_price: formData.get("total_price"),
    notes: formData.get("notes"),
  });

  if (!parsed.success) {
    return { fieldErrors: await localizeZodFieldErrors(parsed.error) };
  }

  try {
    const deptError = await ensureDepartmentInClinic(
      parsed.data.department_id,
      user.clinicId,
    );
    if (deptError) return deptError;

    const supabase = createClinicScopedAdminClient(user.clinicId);
    const { error } = await supabase.from("package_templates").insert({
      clinic_id: user.clinicId,
      department_id: parsed.data.department_id,
      name: parsed.data.name,
      total_sessions: parsed.data.total_sessions,
      price_per_session: parsed.data.price_per_session,
      total_price: parsed.data.total_price,
      notes: parsed.data.notes,
      created_by: user.id,
      is_active: true,
    });

    if (error) return { error: await actionError("package-templates.failedToCreateTemplate") };

    revalidateSettings();
    return { success: true };
  } catch (error) {
    console.error("Package template creation failed", { error });
    return { error: await actionError("package-templates.unexpected") };
  }
}

export async function updatePackageTemplate(
  _prev: PackageTemplateActionResult | null,
  formData: FormData,
): Promise<PackageTemplateActionResult> {
  const user = await requireMutationRole(["admin"]);

  const parsed = updatePackageTemplateSchema.safeParse({
    template_id: formData.get("template_id"),
    name: formData.get("name"),
    department_id: formData.get("department_id"),
    total_sessions: formData.get("total_sessions"),
    price_per_session: formData.get("price_per_session"),
    total_price: formData.get("total_price"),
    notes: formData.get("notes"),
  });

  if (!parsed.success) {
    return { fieldErrors: await localizeZodFieldErrors(parsed.error) };
  }

  try {
    const existing = await ensureTemplateInClinic(
      parsed.data.template_id,
      user.clinicId,
    );
    if (!existing) return { error: await actionError("package-templates.templateNotFound") };

    const deptError = await ensureDepartmentInClinic(
      parsed.data.department_id,
      user.clinicId,
    );
    if (deptError) return deptError;

    const supabase = await createClient();
    const { error } = await supabase
      .from("package_templates")
      .update({
        name: parsed.data.name,
        department_id: parsed.data.department_id,
        total_sessions: parsed.data.total_sessions,
        price_per_session: parsed.data.price_per_session,
        total_price: parsed.data.total_price,
        notes: parsed.data.notes,
      })
      .eq("id", parsed.data.template_id)
      .eq("clinic_id", user.clinicId);

    if (error) return { error: await actionError("package-templates.failedToUpdateTemplatePleaseTryAgain") };

    revalidateSettings();
    return { success: true };
  } catch (error) {
    console.error("Package template update failed", { error });
    return { error: await actionError("package-templates.unexpected") };
  }
}

async function setTemplateActive(
  templateId: string,
  isActive: boolean,
): Promise<PackageTemplateActionResult> {
  const user = await requireMutationRole(["admin"]);

  const parsed = templateIdSchema.safeParse({ template_id: templateId });
  if (!parsed.success) {
    return { fieldErrors: await localizeZodFieldErrors(parsed.error) };
  }

  try {
    const existing = await ensureTemplateInClinic(
      parsed.data.template_id,
      user.clinicId,
    );
    if (!existing) return { error: await actionError("package-templates.templateNotFound") };

    const supabase = await createClient();
    const { error } = await supabase
      .from("package_templates")
      .update({ is_active: isActive })
      .eq("id", parsed.data.template_id)
      .eq("clinic_id", user.clinicId);

    if (error) {
      return {
        error: isActive
          ? await actionError("package-templates.failedToRestoreTemplate")
          : await actionError("package-templates.failedToDeactivateTemplate"),
      };
    }

    revalidateSettings();
    return { success: true };
  } catch (error) {
    console.error("Package template status update failed", { error });
    return { error: await actionError("package-templates.unexpected") };
  }
}

export async function deactivatePackageTemplate(
  templateId: string,
): Promise<PackageTemplateActionResult> {
  return setTemplateActive(templateId, false);
}

export async function restorePackageTemplate(
  templateId: string,
): Promise<PackageTemplateActionResult> {
  return setTemplateActive(templateId, true);
}

export async function deletePackageTemplate(
  templateId: string,
): Promise<PackageTemplateActionResult> {
  const user = await requireMutationRole(["admin"]);

  const parsed = templateIdSchema.safeParse({ template_id: templateId });
  if (!parsed.success) {
    return { fieldErrors: await localizeZodFieldErrors(parsed.error) };
  }

  try {
    const existing = await ensureTemplateInClinic(
      parsed.data.template_id,
      user.clinicId,
    );
    if (!existing) return { error: await actionError("package-templates.templateNotFound") };

    const supabase = await createClient();
    const { error } = await supabase
      .from("package_templates")
      .delete()
      .eq("id", parsed.data.template_id)
      .eq("clinic_id", user.clinicId)
      .eq("is_active", false);

    if (error) return { error: await actionError("package-templates.failedToDeleteTemplate") };

    revalidateSettings();
    return { success: true };
  } catch (error) {
    console.error("Package template deletion failed", { error });
    return { error: await actionError("package-templates.unexpected") };
  }
}
