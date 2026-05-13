import type { Metadata } from "next";
import { requireRole } from "@/lib/rbac";
import { getCachedInsuranceProviders } from "@/lib/cache/reference-data";
import { Badge } from "@/components/ui/badge";
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

export const metadata: Metadata = { title: "Insurance" };

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export default async function InsuranceSettingsPage() {
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
          <h2 className="font-semibold">Insurance providers</h2>
          <p className="text-sm text-muted-foreground">
            {providers?.length ?? 0} provider{(providers?.length ?? 0) !== 1 ? "s" : ""}
          </p>
        </div>
        <AddInsuranceDialog />
      </div>

      <div className="rounded-xl border border-border/50 overflow-hidden">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col />
            <col className="hidden w-28 sm:table-column" />
            <col className="w-24" />
            <col className="w-28" />
          </colgroup>
          <thead>
            <tr className="border-b border-border/50 bg-muted/30">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Provider</th>
              <th className="hidden px-4 py-3 text-left font-medium text-muted-foreground sm:table-cell">
                Code
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {providers.length === 0 && (
              <tr>
                <td colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                  No insurance providers yet.
                </td>
              </tr>
            )}
            {providers.map((provider) => (
              <tr key={provider.id} className="hover:bg-muted/20 transition-colors">
                <td className="px-4 py-3 font-medium">{provider.name}</td>
                <td className="hidden px-4 py-3 text-muted-foreground font-mono text-xs sm:table-cell">
                  {provider.code ?? <span className="text-muted-foreground/50 font-sans">—</span>}
                </td>
                <td className="px-4 py-3">
                  <Badge
                    variant={provider.is_active ? "default" : "secondary"}
                    className={`text-xs ${provider.is_active ? "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/10 border-emerald-500/20" : ""}`}
                  >
                    {provider.is_active ? "Active" : "Inactive"}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <InsuranceActions
                    provider={provider}
                    updateAction={updateInsurance.bind(null, provider.id)}
                    toggleAction={toggleInsuranceActive.bind(null, provider.id)}
                    deleteAction={softDeleteInsurance.bind(null, provider.id)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
