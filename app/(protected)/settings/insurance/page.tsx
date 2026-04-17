import type { Metadata } from "next";
import { Plus } from "lucide-react";
import { requireRole } from "@/lib/rbac";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { InsuranceForm } from "@/components/settings/insurance-form";
import { InsuranceActions } from "@/components/settings/insurance-actions";
import {
  createInsurance,
  updateInsurance,
  toggleInsuranceActive,
} from "@/actions/settings";

export const metadata: Metadata = { title: "Insurance" };

export default async function InsuranceSettingsPage() {
  const user = await requireRole("admin");
  const supabase = await createClient();

  const { data: providers } = await supabase
    .from("insurance_providers")
    .select("*")
    .eq("clinic_id", user.clinicId)
    .order("name");

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-semibold">Insurance providers</h2>
          <p className="text-sm text-muted-foreground">
            {providers?.length ?? 0} provider{(providers?.length ?? 0) !== 1 ? "s" : ""}
          </p>
        </div>
        <Dialog>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-2">
              <Plus className="h-4 w-4" />
              Add provider
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Add insurance provider</DialogTitle>
            </DialogHeader>
            <InsuranceForm action={createInsurance} />
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-xl border border-border/50 overflow-hidden">
        <table className="w-full text-sm">
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
            {(providers ?? []).length === 0 && (
              <tr>
                <td colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                  No insurance providers yet.
                </td>
              </tr>
            )}
            {(providers ?? []).map((provider) => (
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
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
