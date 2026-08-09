import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireRole } from "@/lib/rbac";
import { getCachedDepartments } from "@/lib/cache/reference-data";
import { listClinicalCatalogs } from "@/actions/clinical/catalogs";
import { ClinicalCatalogSettings } from "@/components/clinical/catalog-settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("clinical");
  return { title: t("clinicalCatalogs") };
}

export default async function ClinicalSettingsPage() {
  const user = await requireRole("admin");
  const t = await getTranslations("clinical");
  const [catalogs, departmentRows] = await Promise.all([
    listClinicalCatalogs(),
    getCachedDepartments(user.clinicId),
  ]);
  const departments = departmentRows.filter((department) => department.is_active && !department.deleted_at).map(({ id, name }) => ({ id, name }));
  return <div className="space-y-6"><div><h1 className="text-2xl font-semibold tracking-tight">{t("clinicalCatalogs")}</h1><p className="text-sm text-muted-foreground">{t("clinicalCatalogsDescription")}</p></div><ClinicalCatalogSettings departments={departments} drugs={catalogs.drugs.map((entry) => ({ ...entry, departmentIds: entry.drug_catalog_departments.map((row) => row.department_id) }))} tests={catalogs.tests.map((entry) => ({ ...entry, departmentIds: entry.lab_test_catalog_departments.map((row) => row.department_id) }))} /></div>;
}
