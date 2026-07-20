"use client";

import { useState, useTransition } from "react";
import { Loader2, Wallet } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  setStaffAiPermission,
  type StaffAiPermissionRow,
} from "@/actions/ai-permissions";
import { AI_FINANCIAL_INSIGHTS_PERMISSION } from "@/lib/ai/permission-keys";

/**
 * Admin management of the per-user financial AI grant (P4.6B).
 *
 * The server actions shipped with P4.6A with no surface; this is that surface.
 * It is the *only* thing this panel does — the toggle decides whether the three
 * financial assistant tools are mounted for one manager. It grants no page
 * access, changes no role, and is inert without the `ai.financial_insights`
 * entitlement, which the server action re-checks before writing.
 *
 * Admin rows are shown but not toggleable: admins already administer billing
 * and every financial page, so revoking the grant would remove an assistant
 * answer while leaving the underlying report one click away — the appearance of
 * a control rather than a real one.
 */
export function AiFinancialPermissions({
  staff,
  entitled,
  loadError = null,
}: {
  staff: StaffAiPermissionRow[];
  entitled: boolean;
  /**
   * A localized message when the staff lookup failed. Rendered as its own state
   * because an empty list and a failed read are different facts and only one of
   * them means "there is nobody to grant".
   */
  loadError?: string | null;
}) {
  const t = useTranslations("settings");
  const [rows, setRows] = useState(staff);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function handleToggle(member: StaffAiPermissionRow, next: boolean) {
    const previous = rows;
    setRows((current) =>
      current.map((row) => (row.id === member.id ? { ...row, granted: next } : row)),
    );
    setPendingId(member.id);
    startTransition(async () => {
      const result = await setStaffAiPermission(member.id, AI_FINANCIAL_INSIGHTS_PERMISSION, next);
      setPendingId(null);
      if (result.error) {
        // Revert to the server's truth rather than leaving the switch showing a
        // grant that was never written.
        setRows(previous);
        toast.error(result.error);
      } else {
        toast.success(t("aiFinancialPermissionSaved"));
      }
    });
  }

  return (
    <section className="rounded-lg border border-border/60">
      <div className="border-b border-border/50 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Wallet className="size-4 text-muted-foreground" aria-hidden="true" />
          {t("aiFinancialPermissionsTitle")}
        </h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {t("aiFinancialPermissionsDescription")}
        </p>
      </div>

      {!entitled ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          {t("aiFinancialPermissionsNotEntitled")}
        </p>
      ) : loadError ? (
        <p className="px-4 py-8 text-center text-sm text-destructive">{loadError}</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">
          {t("aiFinancialPermissionsEmpty")}
        </p>
      ) : (
        <div className="divide-y divide-border/50">
          {rows.map((member) => (
            <div
              key={member.id}
              className="flex items-center justify-between gap-4 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{member.fullName}</p>
                {member.implicit ? (
                  <p className="text-xs text-muted-foreground">
                    {t("aiFinancialPermissionImplicit")}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant="outline" className="capitalize">
                  {member.role}
                </Badge>
                {pendingId === member.id ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                ) : null}
                <Switch
                  checked={member.granted}
                  disabled={member.implicit || pendingId !== null}
                  aria-label={member.fullName}
                  onCheckedChange={(next) => handleToggle(member, next)}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
