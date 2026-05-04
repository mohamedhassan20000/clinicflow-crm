"use client";

import { useState, useTransition } from "react";
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
import { EditStaffForm } from "@/components/settings/staff-form";
import { StaffProfileSheet } from "@/components/settings/staff-profile-sheet";
import {
  updateStaff,
  resetStaffPassword,
  toggleStaffActive,
  softDeleteStaff,
  restoreStaff,
} from "@/actions/settings";
import type { Tables } from "@/types/database";

type StaffMember = Tables<"profiles"> & {
  departments: { name: string; color?: string | null } | null;
};
type Department = Pick<Tables<"departments">, "id" | "name">;
export type { StaffMember };

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  doctor: "Doctor",
  receptionist: "Receptionist",
  manager: "Manager",
};

const ROLE_VARIANTS: Record<string, "default" | "secondary" | "outline"> = {
  admin: "default",
  doctor: "default",
  receptionist: "secondary",
  manager: "outline",
};

interface StaffTableProps {
  staff: StaffMember[];
  departments: Department[];
  currentUserId: string;
}

export function StaffTable({ staff, departments, currentUserId }: StaffTableProps) {
  const [editTarget, setEditTarget] = useState<StaffMember | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<StaffMember | null>(null);
  const [profileTarget, setProfileTarget] = useState<StaffMember | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleDelete(id: string, name: string) {
    startTransition(async () => {
      const result = await softDeleteStaff(id);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(`"${name}" moved to recycle bin.`, {
          duration: 10000,
          action: {
            label: "Undo",
            onClick: () => {
              restoreStaff(id).then((res) => {
                if (res.error) toast.error(res.error);
                else toast.success(`"${name}" restored.`);
              });
            },
          },
        });
      }
      setDeleteTarget(null);
    });
  }

  function handleResetPassword(id: string) {
    startTransition(async () => {
      const result = await resetStaffPassword(id);
      if (result.error) toast.error(result.error);
      else toast.success("Password reset. Staff will be prompted to set a new one.");
    });
  }

  function handleToggleActive(id: string, newState: boolean) {
    startTransition(async () => {
      const result = await toggleStaffActive(id, newState);
      if (result.error) toast.error(result.error);
      else toast.success(newState ? "Staff member reactivated." : "Staff member deactivated.");
    });
  }

  return (
    <>
      <div className="rounded-xl border border-border/50 overflow-hidden">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col />
            <col className="hidden w-36 sm:table-column" />
            <col className="w-28" />
            <col className="w-24" />
            <col className="w-12" />
          </colgroup>
          <thead>
            <tr className="border-b border-border/50 bg-muted/30">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Name</th>
              <th className="hidden px-4 py-3 text-left font-medium text-muted-foreground sm:table-cell">
                Department
              </th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Role</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {staff.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="py-10 text-center text-sm text-muted-foreground"
                >
                  No staff members yet.
                </td>
              </tr>
            )}
            {staff.map((s) => (
              <tr
                key={s.id}
                className="hover:bg-muted/20 transition-colors cursor-pointer"
                onClick={() => setProfileTarget(s)}
              >
                <td className="px-4 py-3">
                  <p className="font-medium">{s.full_name}</p>
                  {s.phone && (
                    <p className="text-xs text-muted-foreground">{s.phone}</p>
                  )}
                </td>
                <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">
                  {s.departments?.name ?? <span className="text-muted-foreground/50">—</span>}
                </td>
                <td className="px-4 py-3">
                  <Badge variant={ROLE_VARIANTS[s.role] ?? "outline"} className="text-xs">
                    {ROLE_LABELS[s.role] ?? s.role}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  <Badge
                    variant={s.is_active ? "default" : "secondary"}
                    className={`text-xs ${s.is_active ? "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/10 border-emerald-500/20" : ""}`}
                  >
                    {s.is_active ? "Active" : "Inactive"}
                  </Badge>
                </td>
                <td
                  className="px-4 py-3 text-right"
                  onClick={(e) => e.stopPropagation()}
                >
                  {isPending ? (
                    <Loader2 className="ml-auto h-4 w-4 animate-spin text-muted-foreground" />
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7">
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">Open menu</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setProfileTarget(s)}>
                          <FolderOpen className="mr-2 h-4 w-4" />
                          View profile &amp; files
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => setEditTarget(s)}>
                          <Pencil className="mr-2 h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleResetPassword(s.id)}>
                          <KeyRound className="mr-2 h-4 w-4" />
                          Reset password
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
                                  <UserX className="mr-2 h-4 w-4" />
                                  Deactivate
                                </>
                              ) : (
                                <>
                                  <UserCheck className="mr-2 h-4 w-4" />
                                  Reactivate
                                </>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => setDeleteTarget(s)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Staff profile sheet */}
      <StaffProfileSheet
        staff={profileTarget}
        open={!!profileTarget}
        onOpenChange={(open) => !open && setProfileTarget(null)}
      />

      {/* Edit dialog */}
      <Dialog open={!!editTarget} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit staff member</DialogTitle>
          </DialogHeader>
          {editTarget && (
            <EditStaffForm
              action={updateStaff.bind(null, editTarget.id)}
              departments={departments}
              defaultValues={{
                full_name: editTarget.full_name,
                role: editTarget.role as "admin" | "doctor" | "receptionist" | "manager",
                department_id: editTarget.department_id ?? null,
                phone: editTarget.phone ?? null,
                is_active: editTarget.is_active,
              }}
              onSuccess={() => setEditTarget(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move to recycle bin?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deleteTarget?.full_name}</strong> will be deactivated and
              moved to the recycle bin. They can be restored within 30 days.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) handleDelete(deleteTarget.id, deleteTarget.full_name);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isPending ? "Moving…" : "Move to bin"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
