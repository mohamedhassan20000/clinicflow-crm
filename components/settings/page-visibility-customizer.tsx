"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useTranslations } from "next-intl";
import {
  saveUserPageVisibilityChanges,
  type StaffPagePermissionsRow,
} from "@/actions/page-permissions";
import {
  resetUserVisibilityToDefaults,
  saveUserReportVisibilityChanges,
  type StaffReportPermissionsRow,
} from "@/actions/report-permissions";
import { REPORT_CATALOG, reportDefaultVisibleForRole } from "@/lib/reports/catalog";

const REPORT_TITLE_KEYS: Record<string, string> = Object.fromEntries(
  Object.values(REPORT_CATALOG).map((entry) => [entry.id, entry.titleKey]),
);

export function PageVisibilityCustomizer({
  staff,
  reports,
  initialSelectedId,
}: {
  staff: StaffPagePermissionsRow[];
  reports: StaffReportPermissionsRow[];
  initialSelectedId?: string;
}) {
  const t = useTranslations("settings");
  const tReports = useTranslations("reports");
  const tNav = useTranslations("nav.tenant");
  const [rows, setRows] = useState(staff);
  const [savedRows, setSavedRows] = useState(staff);
  const [reportRows, setReportRows] = useState(reports);
  const [savedReportRows, setSavedReportRows] = useState(reports);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
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

  // ── Report visibility (only meaningful when the Reports page is enabled) ────
  const selectedReport = useMemo(
    () => reportRows.find((member) => member.id === selected?.id),
    [reportRows, selected?.id],
  );
  const selectedSavedReport = useMemo(
    () => savedReportRows.find((member) => member.id === selected?.id),
    [savedReportRows, selected?.id],
  );
  // Reads the LIVE local page toggle so hiding Reports hides the config section
  // immediately, before saving.
  const reportsPageEnabled = Boolean(
    selected?.permissions.find((p) => p.slug === "reports")?.isVisible,
  );
  const hasReportChanges = Boolean(
    selectedReport &&
      selectedSavedReport &&
      selectedReport.permissions.some((permission) => {
        const saved = selectedSavedReport.permissions.find(
          (item) => item.reportId === permission.reportId,
        );
        return saved && saved.isVisible !== permission.isVisible;
      }),
  );

  function handleReportToggle(reportId: string, next: boolean) {
    if (!selected) return;
    setReportRows((current) =>
      current.map((member) =>
        member.id === selected.id
          ? {
              ...member,
              permissions: member.permissions.map((permission) =>
                permission.reportId === reportId
                  ? { ...permission, isVisible: next }
                  : permission,
              ),
            }
          : member,
      ),
    );
  }

  function handleReportSave() {
    if (!selected || !selectedReport || !selectedSavedReport) return;
    const changes = selectedReport.permissions
      .filter((permission) => {
        const saved = selectedSavedReport.permissions.find(
          (item) => item.reportId === permission.reportId,
        );
        return saved && saved.isVisible !== permission.isVisible;
      })
      .map((permission) => ({
        reportId: permission.reportId,
        isVisible: permission.isVisible,
      }));
    if (changes.length === 0) return;
    startTransition(async () => {
      const result = await saveUserReportVisibilityChanges(selected.id, changes);
      if (result.error) {
        toast.error(result.error);
        setReportRows(savedReportRows);
      } else {
        setSavedReportRows(reportRows);
        toast.success(t("pageVisibilitySaved"));
      }
    });
  }

  function handleReset() {
    if (!selected || resetting) return; // prevent duplicate submissions
    setResetting(true);
    startTransition(async () => {
      const result = await resetUserVisibilityToDefaults(selected.id);
      setResetting(false);
      setConfirmReset(false);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      // Reflect the restored role defaults locally for the selected employee:
      // all role pages become visible; each report returns to its role default.
      const defaultedRows = (list: StaffPagePermissionsRow[]) =>
        list.map((member) =>
          member.id === selected.id
            ? {
                ...member,
                permissions: member.permissions.map((permission) => ({
                  ...permission,
                  isVisible: true,
                })),
              }
            : member,
        );
      const defaultedReports = (list: StaffReportPermissionsRow[]) =>
        list.map((member) =>
          member.id === selected.id
            ? {
                ...member,
                permissions: member.permissions.map((permission) => ({
                  ...permission,
                  isVisible: reportDefaultVisibleForRole(
                    permission.reportId,
                    selected.role as Parameters<
                      typeof reportDefaultVisibleForRole
                    >[1],
                  ),
                })),
              }
            : member,
        );
      setRows((c) => defaultedRows(c));
      setSavedRows((c) => defaultedRows(c));
      setReportRows((c) => defaultedReports(c));
      setSavedReportRows((c) => defaultedReports(c));
      toast.success(t("customizeResetDone"));
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
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 px-4 py-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              disabled={isSaving || resetting}
              onClick={() => setConfirmReset(true)}
            >
              {resetting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              {t("customizeResetButton")}
            </Button>
            <div className="flex items-center gap-2">
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
          </div>

          {/* Report visibility — only when this employee's Reports page is on. */}
          {reportsPageEnabled && selectedReport && selectedReport.permissions.length > 0 && (
            <div className="border-t border-border/50">
              <div className="px-4 py-3">
                <h3 className="text-sm font-semibold">{t("reportVisibility")}</h3>
                <p className="text-xs text-muted-foreground">
                  {t("chooseWhichReportsThisEmployeeCanOpen")}
                </p>
              </div>
              <div className="divide-y divide-border/50">
                {selectedReport.permissions.map((permission) => (
                  <div
                    key={permission.reportId}
                    className="flex items-center justify-between gap-4 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {tReports(
                          (REPORT_TITLE_KEYS[permission.reportId] ??
                            permission.reportId) as never,
                        )}
                      </p>
                      {(permission.financial || permission.administrative) && (
                        <p className="text-xs text-muted-foreground">
                          {permission.financial
                            ? t("financialReportNote")
                            : t("administrativeReportNote")}
                        </p>
                      )}
                    </div>
                    <Switch
                      checked={permission.isVisible}
                      disabled={isSaving || resetting}
                      onCheckedChange={(next) =>
                        handleReportToggle(permission.reportId, next)
                      }
                    />
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-end gap-2 border-t border-border/50 px-4 py-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!hasReportChanges || isSaving}
                  onClick={() => setReportRows(savedReportRows)}
                >
                  {t("discard")}
                </Button>
                <Button
                  type="button"
                  disabled={!hasReportChanges || isSaving}
                  onClick={handleReportSave}
                  className="gap-2"
                >
                  {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("saveChanges")}
                </Button>
              </div>
            </div>
          )}
        </section>
      )}

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("customizeResetTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("customizeResetDescription", {
                name: selected?.fullName ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetting}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                handleReset();
              }}
              disabled={resetting}
            >
              {resetting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              {t("customizeResetConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
