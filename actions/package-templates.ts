"use server";

import { domainFailureToActionResult } from "@/actions/_domain";
import {
  createPackageTemplateMutation,
  deletePackageTemplateMutation,
  setPackageTemplateActiveMutation,
  updatePackageTemplateMutation,
} from "@/lib/billing/mutations";
import { requireMutationRole } from "@/lib/rbac";

export type PackageTemplateActionResult = {
  error?: string;
  fieldErrors?: Record<string, string[]>;
  success?: boolean;
};

function templateFormInput(formData: FormData) {
  return {
    name: formData.get("name"),
    department_id: formData.get("department_id"),
    total_sessions: formData.get("total_sessions"),
    price_per_session: formData.get("price_per_session"),
    total_price: formData.get("total_price"),
    notes: formData.get("notes"),
  };
}

export async function createPackageTemplate(
  _prev: PackageTemplateActionResult | null,
  formData: FormData,
): Promise<PackageTemplateActionResult> {
  const user = await requireMutationRole("admin");
  const result = await createPackageTemplateMutation(
    user,
    templateFormInput(formData),
  );
  return result.ok
    ? { success: true }
    : domainFailureToActionResult(result);
}

export async function updatePackageTemplate(
  _prev: PackageTemplateActionResult | null,
  formData: FormData,
): Promise<PackageTemplateActionResult> {
  const user = await requireMutationRole("admin");
  const result = await updatePackageTemplateMutation(user, {
    template_id: formData.get("template_id"),
    ...templateFormInput(formData),
  });
  return result.ok
    ? { success: true }
    : domainFailureToActionResult(result);
}

async function setTemplateActive(
  templateId: string,
  active: boolean,
): Promise<PackageTemplateActionResult> {
  const user = await requireMutationRole("admin");
  const result = await setPackageTemplateActiveMutation(
    user,
    { template_id: templateId },
    active,
  );
  return result.ok
    ? { success: true }
    : domainFailureToActionResult(result);
}

export async function deactivatePackageTemplate(templateId: string) {
  return setTemplateActive(templateId, false);
}

export async function restorePackageTemplate(templateId: string) {
  return setTemplateActive(templateId, true);
}

export async function deletePackageTemplate(
  templateId: string,
): Promise<PackageTemplateActionResult> {
  const user = await requireMutationRole("admin");
  const result = await deletePackageTemplateMutation(user, {
    template_id: templateId,
  });
  return result.ok
    ? { success: true }
    : domainFailureToActionResult(result);
}
