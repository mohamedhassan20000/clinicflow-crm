"use client";

import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  MoreHorizontal,
  Pencil,
  KeyRound,
  UserCheck,
  UserX,
  Loader2,
  Trash2,
  FolderOpen,
} from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Label } from "@/components/ui/label";
import { EditStaffForm } from "@/components/settings/staff-form";
import { StaffProfileSheet } from "@/components/settings/staff-profile-sheet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  updateStaff,
  resetStaffPassword,
  toggleStaffActive,
  softDeleteStaff,
  restoreStaff,
} from "@/actions/settings";
import type { Tables } from "@/types/database";
import { useTranslations } from "next-intl";

type StaffMember = Tables<"profiles"> & {
  departments: { name: string; color?: string | null } | null;
};
type Department = Pick<Tables<"departments">, "id" | "name">;
export type { StaffMember };

type StaffPendingAction = {
  id: string;
  action: "delete" | "password" | "restore" | "toggle";
} | null;

const ROLE_LABELS: Record<string, string> = {
  admin: "admin",
  doctor: "doctor",
  receptionist: "receptionist",
  manager: "manager",
};

const ROLE_VARIANTS: Record<string, "default" | "secondary" | "outline"> = {
  admin: "default",
  doctor: "default",
  receptionist: "secondary",
  manager: "outline",
};

function initials(name: string) {
  return (
    name
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("") || "?"
  );
}

interface StaffTableProps {
  staff: StaffMember[];
  departments: Department[];
  doctors: { id: string; full_name: string }[];
  assignmentsByAssistant: Record<string, string[]>;
  currentUserId: string;
  lastSeenMap?: Record<string, string | null>;
  isAdmin?: boolean;
}


export function StaffTable({ staff, departments, doctors, assignmentsByAssistant, currentUserId, lastSeenMap, isAdmin }: StaffTableProps) {
  const t = useTranslations("settings");
  const [editTarget, setEditTarget] = useState<StaffMember | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StaffMember | null>(null);
  const [profileTarget, setProfileTarget] = useState<StaffMember | null>(null);
  const [passwordTarget, setPasswordTarget] = useState<StaffMember | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [confirmTemporaryPassword, setConfirmTemporaryPassword] = useState("");
  const [pendingAction, setPendingActionState] = useState<StaffPendingAction>(null);
  const pendingActionRef = useRef<StaffPendingAction>(null);
  const [, startTransition] = useTransition();

  function setPendingAction(action: StaffPendingAction) {
    pendingActionRef.current = action;
    setPendingActionState(action);
  }

  function handleDelete(id: string, name: string) {
    if (pendingActionRef.current) return;
    setPendingAction({ id, action: "delete" });
    startTransition(async () => {
      const result = await softDeleteStaff(id);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(t("namedItemMovedToRecycleBin", { name }), {
          duration: 10000,
          action: {
            label: t("undo"),
            onClick: () => {
              if (pendingActionRef.current) return;
              setPendingAction({ id, action: "restore" });
              restoreStaff(id)
                .then((res) => {
                  if (res.error) toast.error(res.error);
                  else toast.success(t("namedItemRestored", { name }));
                })
                .finally(() => setPendingAction(null));
            },
          },
        });
      }
      setDeleteTarget(null);
      setPendingAction(null);
    });
  }

  function resetPasswordDialog() {
    setPasswordTarget(null);
    setTemporaryPassword("");
    setConfirmTemporaryPassword("");
  }

  function validateTemporaryPassword() {
    if (temporaryPassword.length < 8) {
      return "Password must be at least 8 characters.";
    }
    if (!/[A-Z]/.test(temporaryPassword)) {
      return "Password must contain an uppercase letter.";
    }
    if (!/[0-9]/.test(temporaryPassword)) {
      return "Password must contain a number.";
    }
    if (temporaryPassword !== confirmTemporaryPassword) {
      return "Passwords do not match.";
    }
    return null;
  }

  function handleResetPassword() {
    if (!passwordTarget) return;
    if (pendingActionRef.current) return;
    const validationError = validateTemporaryPassword();
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setPendingAction({ id: passwordTarget.id, action: "password" });
    startTransition(async () => {
      const result = await resetStaffPassword(
        passwordTarget.id,
        temporaryPassword,
      );
      if (result.error) toast.error(result.error);
      else {
        toast.success(t("temporaryPasswordSetStaffWillBe"));
        resetPasswordDialog();
      }
      setPendingAction(null);
    });
  }

  function handleToggleActive(id: string, newState: boolean) {
    if (pendingActionRef.current) return;
    setPendingAction({ id, action: "toggle" });
    startTransition(async () => {
      const result = await toggleStaffActive(id, newState);
      if (result.error) toast.error(result.error);
      else toast.success(newState ? t("staffmemberreactivated") : t("staffmemberdeactivated"));
      setPendingAction(null);
    });
  }

  return (
    <>
      <div className="rounded-xl border border-border/50 overflow-hidden">
        <Table className="table-fixed">
          <colgroup>
            <col />
            <col className="hidden w-36 sm:table-column" />
            <col className="w-28" />
            <col className="w-24" />
            <col className="w-12" />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead>{t("name")}</TableHead>
              <TableHead className="hidden sm:table-cell">{t("department")}</TableHead>
              <TableHead>{t("role")}</TableHead>
              <TableHead>{t("status")}</TableHead>
              <TableHead className="text-end">
                <span className="sr-only">{t("actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {staff.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  {t("noStaffMembersYet")}
                </TableCell>
              </TableRow>
            )}
            {staff.map((s) => {
              const rowPending = pendingAction?.id === s.id;
              return (
              <TableRow
                key={s.id}
                className="cursor-pointer"
                onClick={() => setProfileTarget(s)}
              >
                <TableCell>
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar className="h-9 w-9">
                      {s.avatar_url && (
                        <AvatarImage src={s.avatar_url} alt={s.full_name} />
                      )}
                      <AvatarFallback className="text-xs font-semibold">
                        {initials(s.full_name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="truncate font-medium">{s.full_name}</p>
                      {s.phone && (
                        <p className="truncate text-xs text-muted-foreground">
                          {s.phone}
                        </p>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  {s.departments?.name ?? <span className="text-muted-foreground/50">—</span>}
                </TableCell>
                <TableCell>
                  <Badge variant={ROLE_VARIANTS[s.role] ?? "outline"} className="text-xs">
                    {ROLE_LABELS[s.role] ? t(ROLE_LABELS[s.role]) : s.role}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={s.is_active ? "default" : "secondary"}
                    className={`text-xs ${s.is_active ? "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400" : ""}`}
                  >
                    {s.is_active ? t("active") : t("inactive")}
                  </Badge>
                </TableCell>
                <TableCell
                  className="text-end"
                  onClick={(e) => e.stopPropagation()}
                >
                  {rowPending ? (
                    <Loader2 className="ms-auto h-4 w-4 animate-spin text-muted-foreground" />
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7">
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">{t("openMenu")}</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setProfileTarget(s)}>
                          <FolderOpen className="me-2 h-4 w-4" />
                          {t("viewProfileAndFiles")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => setEditTarget(s)}>
                          <Pencil className="me-2 h-4 w-4" />
                          {t("edit")}</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setPasswordTarget(s)}>
                          <KeyRound className="me-2 h-4 w-4" />
                          {t("setTemporaryPassword")}
                        </DropdownMenuItem>
                        {s.id !== currentUserId && (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              onClick={() => handleToggleActive(s.id, !s.is_active)}
                              className={s.is_active ? "text-destructive focus:text-destructive" : ""}
                            >
                              {s.is_active ? (
                                <>
                                  <UserX className="me-2 h-4 w-4" />
                                  {t("deactivate")}
                                </>
                              ) : (
                                <>
                                  <UserCheck className="me-2 h-4 w-4" />
                                  {t("reactivate")}
                                </>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setDeleteTarget(s)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="me-2 h-4 w-4" />
                              {t("delete")}
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Staff profile sheet */}
      <StaffProfileSheet
        staff={profileTarget}
        open={!!profileTarget}
        onOpenChange={(open) => !open && setProfileTarget(null)}
        lastSeen={profileTarget ? (lastSeenMap?.[profileTarget.id] ?? null) : null}
        isAdmin={isAdmin}
      />

      {/* Edit dialog */}
      <Dialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("editStaffMember")}</DialogTitle>
          </DialogHeader>
          {editTarget && (
            <EditStaffForm
              action={updateStaff.bind(null, editTarget.id)}
              departments={departments}
              doctors={doctors}
              initialSupervisingDoctorIds={
                assignmentsByAssistant[editTarget.id] ?? []
              }
              defaultValues={{
                full_name: editTarget.full_name,
                role: editTarget.role as
                  | "admin"
                  | "doctor"
                  | "receptionist"
                  | "manager"
                  | "assistant",
                department_id: editTarget.department_id ?? null,
                phone: editTarget.phone ?? null,
                is_active: editTarget.is_active,
              }}
              onSuccess={() => setEditTarget(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Set temporary password dialog */}
      <Dialog
        open={!!passwordTarget}
        onOpenChange={(open) => {
          if (!open) resetPasswordDialog();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("setTemporaryPassword")}</DialogTitle>
            <DialogDescription>
              {passwordTarget?.full_name} {t("willBeForcedToChangeThis")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="temporary-password">{t("temporaryPassword")}</Label>
              <Input
                id="temporary-password"
                type="password"
                autoComplete="new-password"
                value={temporaryPassword}
                disabled={pendingAction?.action === "password"}
                onChange={(e) => setTemporaryPassword(e.target.value)}
                placeholder={t("clinic123")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-temporary-password">
                {t("confirmTemporaryPassword")}
              </Label>
              <Input
                id="confirm-temporary-password"
                type="password"
                autoComplete="new-password"
                value={confirmTemporaryPassword}
                disabled={pendingAction?.action === "password"}
                onChange={(e) => setConfirmTemporaryPassword(e.target.value)}
                placeholder={t("clinic123")}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pendingAction?.action === "password"}
              onClick={resetPasswordDialog}
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              disabled={pendingAction?.action === "password"}
              onClick={handleResetPassword}
              className="gap-2"
            >
              {pendingAction?.action === "password" && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {t("savePassword")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("moveToRecycleBin")}</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deleteTarget?.full_name}</strong> {t("willBeDeactivatedAndMovedTo")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingAction?.action === "delete"}>
              {t("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={pendingAction?.action === "delete"}
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) handleDelete(deleteTarget.id, deleteTarget.full_name);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {pendingAction?.action === "delete" ? t("moving") : t("movetobin")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
