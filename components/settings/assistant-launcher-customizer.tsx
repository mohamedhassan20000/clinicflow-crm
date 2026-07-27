"use client";

import { useMemo, useState, useTransition } from "react";
import { Loader2, RotateCcw, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  resetAssistantLauncherPlacement,
  setAssistantRoleLauncherPlacement,
  setAssistantUserLauncherOverride,
} from "@/actions/assistant-launcher-settings";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ASSISTANT_CUSTOMIZATION_ROLES,
  type AssistantLauncherCustomizationData,
} from "@/lib/ai/launcher-customization-types";
import type { AssistantPageContextType } from "@/lib/ai/page-context";
import type { UserRole } from "@/lib/rbac";
import { cn } from "@/lib/utils";

const AREA_KEYS: Record<AssistantPageContextType, string> = {
  patient: "assistantCustomizationAreaPatient",
  appointments: "assistantCustomizationAreaAppointments",
  dashboard: "assistantCustomizationAreaDashboard",
  revenue: "assistantCustomizationAreaRevenue",
  reports: "assistantCustomizationAreaReports",
  invoices: "assistantCustomizationAreaInvoices",
  staff: "assistantCustomizationAreaStaff",
  departments: "assistantCustomizationAreaDepartments",
  "doctor-schedule": "assistantCustomizationAreaDoctorSchedule",
};

const ROLE_KEYS: Record<UserRole, string> = {
  admin: "roleAdmin",
  manager: "roleManager",
  receptionist: "roleReceptionist",
  doctor: "roleDoctor",
  assistant: "roleAssistant",
};

type PlacementValue = boolean | null;

export function AssistantLauncherCustomizer({
  initialData,
}: {
  initialData: AssistantLauncherCustomizationData;
}) {
  const t = useTranslations("settings");
  const [data, setData] = useState(initialData);
  const [selectedUserId, setSelectedUserId] = useState(
    initialData.staff[0]?.id,
  );
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [, startTransition] = useTransition();

  function handleReset() {
    setResetting(true);
    startTransition(async () => {
      const result = await resetAssistantLauncherPlacement();
      setResetting(false);
      setConfirmReset(false);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      // Every persisted override was removed → the UI now reflects the code
      // defaults: clear role settings and per-user overrides locally.
      setData((current) => ({
        roleSettings: current.roleSettings.map((setting) => ({
          ...setting,
          roleSettings: {},
        })),
        staff: current.staff.map((member) => ({ ...member, overrides: {} })),
      }));
      toast.success(t("assistantPlacementResetDone"));
    });
  }
  const selectedUser = useMemo(
    () =>
      data.staff.find((member) => member.id === selectedUserId) ??
      data.staff[0],
    [data.staff, selectedUserId],
  );

  function areaLabel(area: AssistantPageContextType) {
    return t(AREA_KEYS[area] as never);
  }

  function roleLabel(role: UserRole) {
    return t(ROLE_KEYS[role] as never);
  }

  function inheritedValue(area: AssistantPageContextType, role: UserRole) {
    const row = data.roleSettings.find((setting) => setting.area === area);
    return row?.roleSettings[role] ?? row?.defaultEnabledByRole[role] ?? false;
  }

  function updateRoleState(
    area: AssistantPageContextType,
    role: UserRole,
    enabled: PlacementValue,
  ) {
    setData((current) => ({
      ...current,
      roleSettings: current.roleSettings.map((setting) => {
        if (setting.area !== area) return setting;
        const roleSettings = { ...setting.roleSettings };
        if (enabled === null) delete roleSettings[role];
        else roleSettings[role] = enabled;
        return { ...setting, roleSettings };
      }),
    }));
  }

  function updateUserState(
    userId: string,
    area: AssistantPageContextType,
    enabled: PlacementValue,
  ) {
    setData((current) => ({
      ...current,
      staff: current.staff.map((member) => {
        if (member.id !== userId) return member;
        const overrides = { ...member.overrides };
        if (enabled === null) delete overrides[area];
        else overrides[area] = enabled;
        return { ...member, overrides };
      }),
    }));
  }

  function changeRole(
    area: AssistantPageContextType,
    role: UserRole,
    enabled: PlacementValue,
  ) {
    const key = `role:${area}:${role}`;
    const previous = data.roleSettings.find(
      (setting) => setting.area === area,
    )?.roleSettings[role] ?? null;
    updateRoleState(area, role, enabled);
    setPendingKey(key);
    startTransition(async () => {
      const result = await setAssistantRoleLauncherPlacement({
        area,
        role,
        enabled,
      });
      setPendingKey(null);
      if (result.error) {
        updateRoleState(area, role, previous);
        toast.error(result.error);
        return;
      }
      toast.success(t("assistantCustomizationSaved"));
    });
  }

  function changeUser(
    userId: string,
    area: AssistantPageContextType,
    enabled: PlacementValue,
  ) {
    const key = `user:${userId}:${area}`;
    const previous = data.staff.find((member) => member.id === userId)
      ?.overrides[area] ?? null;
    updateUserState(userId, area, enabled);
    setPendingKey(key);
    startTransition(async () => {
      const result = await setAssistantUserLauncherOverride({
        userId,
        area,
        enabled,
      });
      setPendingKey(null);
      if (result.error) {
        updateUserState(userId, area, previous);
        toast.error(result.error);
        return;
      }
      toast.success(t("assistantCustomizationSaved"));
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
        <div className="flex items-start gap-3">
          <ShieldCheck
            className="mt-0.5 size-5 shrink-0 text-primary"
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-medium">
              {t("assistantCustomizationVisibilityOnlyTitle")}
            </p>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {t("assistantCustomizationVisibilityOnlyDescription")}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={pendingKey !== null || resetting}
          onClick={() => setConfirmReset(true)}
        >
          {resetting ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RotateCcw className="size-3.5" aria-hidden="true" />
          )}
          {t("assistantPlacementResetButton")}
        </Button>
      </div>

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("assistantPlacementResetTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("assistantPlacementResetDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetting}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (!resetting) handleReset();
              }}
              disabled={resetting}
            >
              {resetting ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {t("assistantPlacementResetConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Tabs defaultValue="roles">
        <TabsList aria-label={t("assistantCustomizationTabsLabel")}>
          <TabsTrigger value="roles">
            <Sparkles data-icon="inline-start" aria-hidden="true" />
            {t("assistantCustomizationRoleDefaultsTab")}
          </TabsTrigger>
          <TabsTrigger value="users">
            <UserRound data-icon="inline-start" aria-hidden="true" />
            {t("assistantCustomizationPeopleTab")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="roles" className="mt-3">
          <section
            className="overflow-hidden rounded-xl border border-border/60 bg-card"
            aria-labelledby="assistant-role-placement-heading"
          >
            <div className="border-b border-border/50 px-4 py-3">
              <h2
                id="assistant-role-placement-heading"
                className="text-sm font-semibold"
              >
                {t("assistantCustomizationRoleMatrixTitle")}
              </h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {t("assistantCustomizationRoleMatrixDescription")}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-sm">
                <caption className="sr-only">
                  {t("assistantCustomizationRoleMatrixCaption")}
                </caption>
                <thead>
                  <tr className="border-b border-border/50 bg-muted/30">
                    <th scope="col" className="px-4 py-3 text-start font-medium">
                      {t("assistantCustomizationAreaColumn")}
                    </th>
                    {ASSISTANT_CUSTOMIZATION_ROLES.map((role) => (
                      <th
                        key={role}
                        scope="col"
                        className="px-3 py-3 text-center font-medium"
                      >
                        {roleLabel(role)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {data.roleSettings.map((setting) => (
                    <tr key={setting.area}>
                      <th scope="row" className="px-4 py-3 text-start font-medium">
                        {areaLabel(setting.area)}
                      </th>
                      {ASSISTANT_CUSTOMIZATION_ROLES.map((role) => {
                        const eligible = setting.eligibleRoles.includes(role);
                        const explicit = setting.roleSettings[role];
                        const checked =
                          explicit ?? setting.defaultEnabledByRole[role] ?? false;
                        const key = `role:${setting.area}:${role}`;
                        return (
                          <td key={role} className="px-3 py-3 text-center">
                            {eligible ? (
                              <div className="flex min-h-12 flex-col items-center justify-center gap-1">
                                <div className="flex items-center gap-2">
                                  {pendingKey === key ? (
                                    <Loader2
                                      className="size-3.5 animate-spin text-muted-foreground"
                                      aria-hidden="true"
                                    />
                                  ) : null}
                                  <Switch
                                    checked={checked}
                                    disabled={pendingKey !== null}
                                    aria-label={t(
                                      "assistantCustomizationRoleToggleLabel",
                                      {
                                        area: areaLabel(setting.area),
                                        role: roleLabel(role),
                                      },
                                    )}
                                    onCheckedChange={(next) =>
                                      changeRole(setting.area, role, next)
                                    }
                                  />
                                </div>
                                {explicit === undefined ? (
                                  <span className="text-[11px] text-muted-foreground">
                                    {t("assistantCustomizationUsingDefault")}
                                  </span>
                                ) : (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className="h-5 gap-1 px-1.5 text-[11px] text-muted-foreground"
                                    disabled={pendingKey !== null}
                                    onClick={() =>
                                      changeRole(setting.area, role, null)
                                    }
                                  >
                                    <RotateCcw className="size-3" aria-hidden="true" />
                                    {t("assistantCustomizationResetDefault")}
                                  </Button>
                                )}
                              </div>
                            ) : (
                              <span
                                className="text-muted-foreground/50"
                                aria-label={t(
                                  "assistantCustomizationNotAvailableForRole",
                                )}
                              >
                                —
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </TabsContent>

        <TabsContent value="users" className="mt-3">
          {data.staff.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
              {t("assistantCustomizationNoStaff")}
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
              <div
                className="overflow-hidden rounded-xl border border-border/60 bg-card"
                aria-label={t("assistantCustomizationStaffListLabel")}
              >
                {data.staff.map((member) => (
                  <button
                    key={member.id}
                    type="button"
                    onClick={() => setSelectedUserId(member.id)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 border-b border-border/40 px-3 py-3 text-start last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      selectedUser?.id === member.id
                        ? "bg-primary/10 text-foreground"
                        : "hover:bg-muted/50",
                    )}
                    aria-pressed={selectedUser?.id === member.id}
                  >
                    <span className="min-w-0 truncate text-sm font-medium">
                      {member.fullName}
                    </span>
                    <Badge variant="secondary" className="shrink-0">
                      {roleLabel(member.role)}
                    </Badge>
                  </button>
                ))}
              </div>

              {selectedUser ? (
                <section
                  className="rounded-xl border border-border/60 bg-card"
                  aria-labelledby="assistant-user-placement-heading"
                >
                  <div className="border-b border-border/50 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2
                        id="assistant-user-placement-heading"
                        className="text-sm font-semibold"
                      >
                        {selectedUser.fullName}
                      </h2>
                      <Badge variant="outline">
                        {roleLabel(selectedUser.role)}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {t("assistantCustomizationUserDescription")}
                    </p>
                  </div>
                  <div className="divide-y divide-border/50">
                    {data.roleSettings
                      .filter((setting) =>
                        setting.eligibleRoles.includes(selectedUser.role),
                      )
                      .map((setting) => {
                        const explicit = selectedUser.overrides[setting.area];
                        const inherited = inheritedValue(
                          setting.area,
                          selectedUser.role,
                        );
                        const checked = explicit ?? inherited;
                        const key = `user:${selectedUser.id}:${setting.area}`;
                        return (
                          <div
                            key={setting.area}
                            className="flex items-center justify-between gap-4 px-4 py-3"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-medium">
                                {areaLabel(setting.area)}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {explicit === undefined
                                  ? t("assistantCustomizationInherited", {
                                      state: inherited
                                        ? t("assistantCustomizationShown")
                                        : t("assistantCustomizationHidden"),
                                    })
                                  : t("assistantCustomizationPersonalOverride")}
                              </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              {explicit !== undefined ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  className="gap-1 text-xs text-muted-foreground"
                                  disabled={pendingKey !== null}
                                  onClick={() =>
                                    changeUser(
                                      selectedUser.id,
                                      setting.area,
                                      null,
                                    )
                                  }
                                >
                                  <RotateCcw className="size-3.5" aria-hidden="true" />
                                  {t("assistantCustomizationUseRoleSetting")}
                                </Button>
                              ) : null}
                              {pendingKey === key ? (
                                <Loader2
                                  className="size-4 animate-spin text-muted-foreground"
                                  aria-hidden="true"
                                />
                              ) : null}
                              <Switch
                                checked={checked}
                                disabled={pendingKey !== null}
                                aria-label={t(
                                  "assistantCustomizationUserToggleLabel",
                                  {
                                    area: areaLabel(setting.area),
                                    user: selectedUser.fullName,
                                  },
                                )}
                                onCheckedChange={(next) =>
                                  changeUser(
                                    selectedUser.id,
                                    setting.area,
                                    next,
                                  )
                                }
                              />
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </section>
              ) : null}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
