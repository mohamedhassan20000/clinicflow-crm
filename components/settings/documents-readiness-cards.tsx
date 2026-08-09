import Link from "next/link";
import { Check, X } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import type {
  BrandingCompleteness,
  CatalogCompleteness,
  ClinicianCompletenessRow,
} from "@/actions/documents-settings";

/** A single present/missing indicator row. */
function StatusRow({ label, present }: { label: string; present: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className={present ? "" : "text-muted-foreground"}>{label}</span>
      {present ? (
        <Check className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
      ) : (
        <X className="size-4 text-amber-600 dark:text-amber-400" aria-hidden />
      )}
    </div>
  );
}

/** Branding completeness — surfaced here, edited in Clinic Settings (doc 09 §1.5). */
export async function BrandingReadinessCard({
  branding,
}: {
  branding: BrandingCompleteness;
}) {
  const t = await getTranslations("documents.settings");
  const rows: Array<{ key: keyof BrandingCompleteness["fields"]; label: string }> = [
    { key: "name", label: t("brandingName") },
    { key: "logo", label: t("brandingLogo") },
    { key: "address", label: t("brandingAddress") },
    { key: "phone", label: t("brandingPhone") },
    { key: "email", label: t("brandingEmail") },
    { key: "website", label: t("brandingWebsite") },
    { key: "license", label: t("brandingLicense") },
    { key: "taxId", label: t("brandingTaxId") },
    { key: "footer", label: t("brandingFooter") },
  ];
  const completeCount = rows.filter((row) => branding.fields[row.key]).length;

  return (
    <section className="space-y-3 rounded-xl border border-border/50 bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">{t("brandingTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("brandingDescription")}</p>
        </div>
        <Badge variant="secondary">
          {t("completeCount", { done: completeCount, total: rows.length })}
        </Badge>
      </div>
      {branding.taxIdMissing ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {t("taxIdWarning")}
        </p>
      ) : null}
      <div className="divide-y divide-border/40">
        {rows.map((row) => (
          <StatusRow key={row.key} label={row.label} present={branding.fields[row.key]} />
        ))}
      </div>
      <Link
        href="/settings/clinic"
        className="inline-block text-sm font-medium text-primary hover:underline"
      >
        {t("editInClinicSettings")}
      </Link>
    </section>
  );
}

/** Clinician credential completeness — signature/stamp readiness (doc 16 §6). */
export async function ClinicianReadinessCard({
  clinicians,
}: {
  clinicians: ClinicianCompletenessRow[];
}) {
  const t = await getTranslations("documents.settings");
  const completeCount = clinicians.filter((row) => row.complete).length;

  return (
    <section className="space-y-3 rounded-xl border border-border/50 bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">{t("credentialsTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("credentialsDescription")}</p>
        </div>
        {clinicians.length > 0 ? (
          <Badge variant="secondary">
            {t("completeCount", { done: completeCount, total: clinicians.length })}
          </Badge>
        ) : null}
      </div>
      {clinicians.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noClinicians")}</p>
      ) : (
        <div className="divide-y divide-border/40">
          {clinicians.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-3 py-2">
              <span className="text-sm font-medium">{row.fullName}</span>
              <div className="flex items-center gap-2">
                <Badge variant={row.hasLicense ? "secondary" : "outline"}>
                  {row.hasLicense ? t("licenceOn") : t("licenceOff")}
                </Badge>
                <Badge variant={row.hasSignature ? "secondary" : "outline"}>
                  {row.hasSignature ? t("signatureOn") : t("signatureOff")}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t("signatureFallbackNote")}</p>
      <Link
        href="/settings/staff"
        className="inline-block text-sm font-medium text-primary hover:underline"
      >
        {t("editInStaffSettings")}
      </Link>
    </section>
  );
}

/** Drug / lab catalog readiness — managed in Clinical Settings (P7-6A). */
export async function CatalogReadinessCard({
  catalogs,
}: {
  catalogs: CatalogCompleteness;
}) {
  const t = await getTranslations("documents.settings");
  return (
    <section className="space-y-3 rounded-xl border border-border/50 bg-card p-5">
      <div>
        <h2 className="font-semibold">{t("catalogsTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("catalogsDescription")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border/40 p-3">
          <div className="text-sm text-muted-foreground">{t("drugCatalog")}</div>
          <div className="text-lg font-semibold tabular-nums">
            {t("activeOfTotal", {
              active: catalogs.activeDrugCount,
              total: catalogs.drugCount,
            })}
          </div>
        </div>
        <div className="rounded-lg border border-border/40 p-3">
          <div className="text-sm text-muted-foreground">{t("labCatalog")}</div>
          <div className="text-lg font-semibold tabular-nums">
            {t("activeOfTotal", {
              active: catalogs.activeLabTestCount,
              total: catalogs.labTestCount,
            })}
          </div>
        </div>
      </div>
      <Link
        href="/settings/clinical"
        className="inline-block text-sm font-medium text-primary hover:underline"
      >
        {t("manageCatalogs")}
      </Link>
    </section>
  );
}
