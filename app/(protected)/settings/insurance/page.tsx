import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { getCachedInsuranceProviders } from "@/lib/cache/reference-data";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { InsuranceActions } from "@/components/settings/insurance-actions";
import { AddInsuranceDialog } from "@/components/settings/add-insurance-dialog";
import {
  updateInsurance,
  toggleInsuranceActive,
  softDeleteInsurance,
  restoreInsurance,
  permanentDeleteInsurance,
  emptyInsuranceTrash,
} from "@/actions/settings";
import { SettingsTrashSection, type TrashItem } from "@/components/settings/settings-trash-section";
import { THIRTY_DAYS_MS } from "@/lib/constants";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataInsurance") };
}

export default async function InsuranceSettingsPage() {
  const t = await getTranslations("protected");
  const user = await requireRole(["admin", "manager"]);

  const allProviders = await getCachedInsuranceProviders(user.clinicId);

  const cutoff = new Date(new Date().getTime() - THIRTY_DAYS_MS).toISOString();
  const providers = (allProviders ?? []).filter((p) => !p.deleted_at);
  const trashedProviders = (allProviders ?? []).filter(
    (p) => p.deleted_at && p.deleted_at > cutoff,
  );
  const trashItems: TrashItem[] = trashedProviders.map((p) => ({
    id: p.id,
    label: p.name,
    subtitle: p.code ?? undefined,
    deletedAt: p.deleted_at!,
  }));

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">{t("insuranceProviders")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("providerCount", { count: providers?.length ?? 0 })}
          </p>
        </div>
        <AddInsuranceDialog />
      </div>

      <div className="rounded-xl border border-border/50 overflow-hidden">
        <Table className="table-fixed">
          <colgroup>
            <col />
            <col className="hidden w-28 sm:table-column" />
            <col className="w-24" />
            <col className="w-28" />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead>{t("provider")}</TableHead>
              <TableHead className="hidden sm:table-cell">{t("code")}</TableHead>
              <TableHead>{t("status")}</TableHead>
              <TableHead className="text-end">
                <span className="sr-only">{t("actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {providers.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                  {t("noInsuranceProvidersYet")}</TableCell>
              </TableRow>
            )}
            {providers.map((provider) => (
              <TableRow key={provider.id}>
                <TableCell className="font-medium">{provider.name}</TableCell>
                <TableCell className="hidden text-muted-foreground font-mono text-xs sm:table-cell">
                  {provider.code ?? <span className="text-muted-foreground/50 font-sans">—</span>}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={provider.is_active ? "default" : "secondary"}
                    className={`text-xs ${provider.is_active ? "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400" : ""}`}
                  >
                    {provider.is_active ? t("active") : t("inactive")}
                  </Badge>
                </TableCell>
                <TableCell className="text-end">
                  <InsuranceActions
                    provider={provider}
                    updateAction={updateInsurance.bind(null, provider.id)}
                    toggleAction={toggleInsuranceActive.bind(null, provider.id)}
                    deleteAction={softDeleteInsurance.bind(null, provider.id)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <SettingsTrashSection
        items={trashItems}
        entityLabel="provider"
        onRestore={restoreInsurance}
        onPermanentDelete={permanentDeleteInsurance}
        onEmptyTrash={emptyInsuranceTrash}
      />
    </div>
  );
}
