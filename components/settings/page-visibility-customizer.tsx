"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";
import {
  saveUserPageVisibilityChanges,
  type StaffPagePermissionsRow,
} from "@/actions/page-permissions";

export function PageVisibilityCustomizer({
  staff,
  initialSelectedId,
}: {
  staff: StaffPagePermissionsRow[];
  initialSelectedId?: string;
}) {
  const t = useTranslations("settings");
  const tNav = useTranslations("nav.tenant");
  const [rows, setRows] = useState(staff);
  const [savedRows, setSavedRows] = useState(staff);
  const [selectedId, setSelectedId] = useState(
    initialSelectedId && staff.some((member) => member.id === initialSelectedId)
      ? initialSelectedId
      : staff[0]?.id,
  );
  const [isSaving, startTransition] = useTransition();
  const selected = useMemo(
    () => rows.find((member) => member.id === selectedId) ?? rows[0],
    [rows, selectedId],
  );

  function setLocalVisibility(staffId: string, slug: string, isVisible: boolean) {
    setRows((current) =>
      current.map((member) =>
        member.id === staffId
          ? {
              ...member,
              permissions: member.permissions.map((permission) =>
                permission.slug === slug
                  ? { ...permission, isVisible }
                  : permission,
              ),
            }
          : member,
      ),
    );
  }

  const selectedSaved = useMemo(
    () => savedRows.find((member) => member.id === selected?.id),
    [savedRows, selected?.id],
  );
  const hasChanges = Boolean(
    selected &&
      selectedSaved &&
      selected.permissions.some((permission) => {
        const saved = selectedSaved.permissions.find(
          (item) => item.slug === permission.slug,
        );
        return saved && saved.isVisible !== permission.isVisible;
      }),
  );

  function handleToggle(slug: string, next: boolean) {
    if (!selected) return;
    setLocalVisibility(selected.id, slug, next);
  }

  function handleSave() {
    if (!selected || !selectedSaved) return;
    const changes = selected.permissions
      .filter((permission) => {
        const saved = selectedSaved.permissions.find(
          (item) => item.slug === permission.slug,
        );
        return saved && saved.isVisible !== permission.isVisible;
      })
      .map((permission) => ({
        slug: permission.slug,
        isVisible: permission.isVisible,
      }));

    if (changes.length === 0) return;
    startTransition(async () => {
      const result = await saveUserPageVisibilityChanges(selected.id, changes);
      if (result.error) {
        toast.error(result.error);
        setRows(savedRows);
      } else {
        setSavedRows(rows);
        toast.success(t("pageVisibilitySaved"));
      }
    });
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
        {t("noStaffMembersFound")}
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <div className="overflow-hidden rounded-lg border border-border/60">
        {rows.map((member) => (
          <button
            key={member.id}
            type="button"
            onClick={() => setSelectedId(member.id)}
            className={cn(
              "flex w-full items-center justify-between gap-3 border-b border-border/40 px-3 py-3 text-start last:border-b-0",
              selected?.id === member.id
                ? "bg-primary/10 text-foreground"
                : "hover:bg-muted/50",
            )}
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">
                {member.fullName}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {member.departmentName ?? t("noDepartment")}
              </span>
            </span>
            <Badge variant="secondary" className="shrink-0 capitalize">
              {member.role}
            </Badge>
          </button>
        ))}
      </div>

      {selected && (
        <section className="rounded-lg border border-border/60">
          <div className="border-b border-border/50 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold">{selected.fullName}</h2>
              <Badge variant="outline" className="capitalize">
                {selected.role}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("toggleOnlyThePagesAvailableTo")}
            </p>
          </div>

          <div className="divide-y divide-border/50">
            {selected.permissions.map((permission) => {
              return (
                <div
                  key={permission.slug}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div>
                    <p className="text-sm font-medium">{tNav(permission.slug)}</p>
                    {permission.alwaysVisible && (
                      <p className="text-xs text-muted-foreground">
                        {t("dashboardIsAlwaysVisible")}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={permission.isVisible}
                      disabled={permission.alwaysVisible || isSaving}
                      onCheckedChange={(next) =>
                        handleToggle(permission.slug, next)
                      }
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border/50 px-4 py-3">
            <Button
              type="button"
              variant="outline"
              disabled={!hasChanges || isSaving}
              onClick={() => setRows(savedRows)}
            >
              {t("discard")}
            </Button>
            <Button
              type="button"
              disabled={!hasChanges || isSaving}
              onClick={handleSave}
              className="gap-2"
            >
              {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("saveChanges")}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
