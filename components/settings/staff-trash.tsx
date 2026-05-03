"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Trash2, RotateCcw, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
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
import { restoreStaff, permanentDeleteStaff } from "@/actions/settings";
import type { Tables } from "@/types/database";

type DeletedMember = Pick<
  Tables<"profiles">,
  "id" | "full_name" | "role" | "phone" | "deleted_at"
> & {
  departments: { name: string; color?: string | null } | null;
};

interface StaffTrashProps {
  deletedStaff: DeletedMember[];
}

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  doctor: "Doctor",
  receptionist: "Receptionist",
  manager: "Manager",
};

function daysRemaining(deletedAt: string | null): number {
  if (!deletedAt) return 30;
  const deletedDate = new Date(deletedAt);
  const expiresAt = new Date(deletedDate.getTime() + 30 * 24 * 60 * 60 * 1000);
  const remaining = Math.ceil((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  return Math.max(0, remaining);
}

export function StaffTrash({ deletedStaff }: StaffTrashProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [purgeTarget, setPurgeTarget] = useState<DeletedMember | null>(null);
  const [isPending, startTransition] = useTransition();

  if (deletedStaff.length === 0) return null;

  function handleRestore(member: DeletedMember) {
    startTransition(async () => {
      const result = await restoreStaff(member.id);
      if (result.error) toast.error(result.error);
      else toast.success(`${member.full_name} restored.`);
    });
  }

  function handlePermanentDelete(member: DeletedMember) {
    startTransition(async () => {
      const result = await permanentDeleteStaff(member.id);
      if (result.error) toast.error(result.error);
      else toast.success(`${member.full_name} permanently deleted.`);
      setPurgeTarget(null);
    });
  }

  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 hover:bg-destructive/10 transition-colors rounded-xl"
      >
        <div className="flex items-center gap-2">
          <Trash2 className="h-4 w-4 text-destructive" />
          <span className="text-sm font-semibold text-destructive">
            Trash
          </span>
          <Badge variant="outline" className="border-destructive/40 text-destructive text-xs">
            {deletedStaff.length}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            Items are permanently deleted after 30 days
          </span>
          {isOpen ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>

      {isOpen && (
        <div className="border-t border-destructive/20 divide-y divide-border/40">
          {deletedStaff.map((member) => {
            const days = daysRemaining(member.deleted_at);
            return (
              <div
                key={member.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-muted-foreground line-through">
                    {member.full_name}
                  </p>
                  <p className="text-xs text-muted-foreground capitalize">
                    {ROLE_LABELS[member.role] ?? member.role}
                    {member.departments ? ` · ${member.departments.name}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge
                    variant="outline"
                    className={`text-xs ${days <= 3 ? "border-destructive/50 text-destructive" : "border-border/60 text-muted-foreground"}`}
                  >
                    {days === 0 ? "Expiring soon" : `${days}d remaining`}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    disabled={isPending}
                    onClick={() => handleRestore(member)}
                  >
                    <RotateCcw className="h-3 w-3" />
                    Restore
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive"
                    disabled={isPending}
                    onClick={() => setPurgeTarget(member)}
                  >
                    <Trash2 className="h-3 w-3" />
                    Delete permanently
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AlertDialog open={!!purgeTarget} onOpenChange={(open) => !open && setPurgeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Permanently delete?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove <strong>{purgeTarget?.full_name}</strong> from
              the clinic and revoke their login. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={(e) => {
                e.preventDefault();
                if (purgeTarget) handlePermanentDelete(purgeTarget);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isPending ? "Deleting…" : "Delete permanently"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
