import "server-only";

import { getTranslations } from "next-intl/server";
import type { AuthedUser } from "@/lib/rbac";
import {
  getDepartmentOptions,
  getDoctorOptions,
  getReceptionistOptions,
} from "@/lib/reports/data";
import type { DocumentSetupField } from "@/lib/documents/module";
import type {
  DocumentSetupLabels,
  DocumentSetupOptions,
} from "@/components/documents/module/document-setup-controls";

/**
 * P7 Phase 4 — load only the option lists the given type's setup fields need
 * (empty arrays otherwise), so a roster type never queries receptionists and an
 * analytical type never queries departments it does not filter on.
 */
export async function loadDocumentSetupOptions(
  user: AuthedUser,
  fields: DocumentSetupField[],
): Promise<DocumentSetupOptions> {
  const wants = (key: DocumentSetupField["key"]) => fields.some((field) => field.key === key);
  const [doctors, departments, receptionists] = await Promise.all([
    wants("doctor") ? getDoctorOptions(user) : Promise.resolve([]),
    wants("department") ? getDepartmentOptions(user) : Promise.resolve([]),
    wants("receptionist") ? getReceptionistOptions(user) : Promise.resolve([]),
  ]);
  return { doctors, departments, receptionists };
}

export async function getDocumentSetupLabels(): Promise<DocumentSetupLabels> {
  const t = await getTranslations("documents.module.setup");
  return {
    period: t("period"),
    presetThisWeek: t("presetThisWeek"),
    presetThisMonth: t("presetThisMonth"),
    presetToday: t("presetToday"),
    presetCustom: t("presetCustom"),
    from: t("from"),
    to: t("to"),
    doctor: t("doctor"),
    department: t("department"),
    receptionist: t("receptionist"),
    search: t("search"),
    searchPlaceholder: t("searchPlaceholder"),
    all: t("all"),
    apply: t("editFilters"),
    saveContinue: t("saveContinue"),
  };
}
