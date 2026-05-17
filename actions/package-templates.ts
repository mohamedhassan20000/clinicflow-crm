"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { createAdminClient } from "@/lib/supabase/admin";
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

function firstError(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

function templateCreateError(error: unknown) {
  const detail = firstError(error);
  return `Failed to create template: ${detail}`;
}

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

  if (error) return { error: "Failed to validate department." };
  if (!data) {
    return {
      fieldErrors: { department_id: ["Select a department from this clinic."] },
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
  const user = await requireRole(["admin"]);

  const parsed = createPackageTemplateSchema.safeParse({
    name: formData.get("name"),
    department_id: formData.get("department_id"),
    total_sessions: formData.get("total_sessions"),
    price_per_session: formData.get("price_per_session"),
    total_price: formData.get("total_price"),
    notes: formData.get("notes"),
  });

  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  try {
    const deptError = await ensureDepartmentInClinic(
      parsed.data.department_id,
      user.clinicId,
    );
    if (deptError) return deptError;

    const supabase = createAdminClient();
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

    if (error) return { error: templateCreateError(error) };

    revalidateSettings();
    return { success: true };
  } catch (error) {
    return { error: firstError(error) };
  }
}

export async function updatePackageTemplate(
  _prev: PackageTemplateActionResult | null,
  formData: FormData,
): Promise<PackageTemplateActionResult> {
  const user = await requireRole(["admin"]);

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
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  try {
    const existing = await ensureTemplateInClinic(
      parsed.data.template_id,
      user.clinicId,
    );
    if (!existing) return { error: "Template not found." };

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

    if (error) return { error: "Failed to update template. Please try again." };

    revalidateSettings();
    return { success: true };
  } catch (error) {
    return { error: firstError(error) };
  }
}

async function setTemplateActive(
  templateId: string,
  isActive: boolean,
): Promise<PackageTemplateActionResult> {
  const user = await requireRole(["admin"]);

  const parsed = templateIdSchema.safeParse({ template_id: templateId });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  try {
    const existing = await ensureTemplateInClinic(
      parsed.data.template_id,
      user.clinicId,
    );
    if (!existing) return { error: "Template not found." };

    const supabase = await createClient();
    const { error } = await supabase
      .from("package_templates")
      .update({ is_active: isActive })
      .eq("id", parsed.data.template_id)
      .eq("clinic_id", user.clinicId);

    if (error) {
      return {
        error: isActive
          ? "Failed to restore template."
          : "Failed to deactivate template.",
      };
    }

    revalidateSettings();
    return { success: true };
  } catch (error) {
    return { error: firstError(error) };
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
  const user = await requireRole(["admin"]);

  const parsed = templateIdSchema.safeParse({ template_id: templateId });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  try {
    const existing = await ensureTemplateInClinic(
      parsed.data.template_id,
      user.clinicId,
    );
    if (!existing) return { error: "Template not found." };

    const supabase = await createClient();
    const { error } = await supabase
      .from("package_templates")
      .delete()
      .eq("id", parsed.data.template_id)
      .eq("clinic_id", user.clinicId)
      .eq("is_active", false);

    if (error) return { error: "Failed to delete template." };

    revalidateSettings();
    return { success: true };
  } catch (error) {
    return { error: firstError(error) };
  }
}
