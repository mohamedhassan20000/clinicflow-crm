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

/**
 * The package's service lines, read off three parallel field lists.
 *
 * The form renders one row per line and names all three inputs identically, so
 * `getAll` returns them in document order and position joins them back up.
 * Parallel lists rather than `items[0].service_id` keys because a row removed
 * from the middle would leave a hole in the indices, and re-indexing the DOM on
 * every removal is a second source of truth for the order.
 *
 * A row whose service is still unpicked is dropped rather than sent as a blank:
 * an empty row is a person part-way through adding a line, not a line. Zero
 * lines is a valid, permanent package shape.
 */
function templateItemsInput(formData: FormData) {
  const services = formData.getAll("item_service_id");
  const sessions = formData.getAll("item_sessions");
  const prices = formData.getAll("item_price_per_session");
  const items: { service_id: unknown; sessions: unknown; price_per_session: unknown }[] = [];
  for (const [index, service] of services.entries()) {
    if (typeof service !== "string" || service.trim() === "") continue;
    items.push({
      service_id: service,
      sessions: sessions[index],
      price_per_session: prices[index],
    });
  }
  return items;
}

function templateFormInput(formData: FormData) {
  return {
    name: formData.get("name"),
    department_id: formData.get("department_id"),
    // Zero, one or many services from the package's department. Empty is the
    // department-only package every existing template is.
    items: templateItemsInput(formData),
    total_sessions: formData.get("total_sessions"),
    price_per_session: formData.get("price_per_session"),
    total_price: formData.get("total_price"),
    notes: formData.get("notes"),
    // Optional, patient-facing, and absent unless a person typed one. The
    // mutation drops a blank rather than storing `""` — see
    // `stripBlankDisplayNames`.
    name_ar: formData.get("name_ar") || null,
    name_en: formData.get("name_en") || null,
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
