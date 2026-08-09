import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireRole } from "@/lib/rbac";
import { isPrimaryClinicAdmin } from "@/lib/primary-admin";
import { getDocumentSettingsOverview } from "@/actions/documents-settings";
import { getDocumentTypeLabels } from "@/lib/documents/module-labels";
import { DOCUMENT_ARCHETYPE_ORDER } from "@/lib/documents/module";
import { DocumentTypeSettingsManager } from "@/components/settings/document-type-settings-manager";
import {
  BrandingReadinessCard,
  CatalogReadinessCard,
  ClinicianReadinessCard,
} from "@/components/settings/documents-readiness-cards";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("documents.settings");
  return { title: t("title") };
}

export default async function DocumentsSettingsPage() {
  const user = await requireRole("admin");
  if (!(await isPrimaryClinicAdmin(user.id, user.clinicId))) redirect("/dashboard");

  const t = await getTranslations("documents.settings");
  const [overviewResult, typeLabels, moduleT] = await Promise.all([
    getDocumentSettingsOverview(),
    getDocumentTypeLabels(),
    getTranslations("documents.module.new"),
  ]);

  if (overviewResult.error || !overviewResult.data) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        {overviewResult.error ?? t("loadError")}
      </div>
    );
  }

  const overview = overviewResult.data;
  const archetypeLabels: Record<string, string> = Object.fromEntries(
    DOCUMENT_ARCHETYPE_ORDER.map((archetype) => [
      archetype,
      moduleT(
        `archetype${archetype.charAt(0).toUpperCase()}${archetype.slice(1)}` as
          | "archetypeFinancial"
          | "archetypeClinical"
          | "archetypeAnalytical"
          | "archetypeRoster"
          | "archetypeProfile"
          | "archetypeHistory"
          | "archetypeGeneric",
      ),
    ]),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <BrandingReadinessCard branding={overview.branding} />
        <ClinicianReadinessCard clinicians={overview.clinicians} />
      </div>

      <CatalogReadinessCard catalogs={overview.catalogs} />

      <DocumentTypeSettingsManager
        global={overview.global}
        types={overview.types}
        archetypeLabels={archetypeLabels}
        typeLabels={typeLabels}
      />

      <p className="text-xs text-muted-foreground">
        {t("verificationBaseNote", { url: overview.verificationBaseUrl })}
      </p>
    </div>
  );
}
