"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, ToggleLeft, ToggleRight, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { DepartmentForm } from "@/components/settings/department-form";
import type { ActionResult } from "@/actions/settings";
import { restoreDepartment } from "@/actions/settings";
import type { Tables } from "@/types/database";
import { useTranslations } from "next-intl";

type Dept = Tables<"departments">;

interface DepartmentActionsProps {
  dept: Dept;
  updateAction: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  toggleAction: (isActive: boolean) => Promise<ActionResult>;
  deleteAction: () => Promise<ActionResult>;
}

export function DepartmentActions({ dept, updateAction, toggleAction, deleteAction }: DepartmentActionsProps) {
  const t = useTranslations("settings");
  const [editOpen, setEditOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const pendingRef = useRef(false);

  function handleToggle() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    startTransition(async () => {
      const result = await toggleAction(!dept.is_active);
      if (result.error) toast.error(result.error);
      else {
        toast.success(dept.is_active ? t("departmentDeactivated") : t("departmentReactivated"));
        router.refresh();
      }
      pendingRef.current = false;
    });
  }

  function handleDelete() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    startTransition(async () => {
      const result = await deleteAction();
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(t("namedItemMovedToRecycleBin", { name: dept.name }), {
          duration: 10000,
          action: {
            label: t("undo"),
            onClick: () => {
              if (pendingRef.current) return;
              pendingRef.current = true;
              restoreDepartment(dept.id)
                .then((res) => {
                  if (res.error) toast.error(res.error);
                  else {
                    toast.success(t("namedItemRestored", { name: dept.name }));
                    router.refresh();
                  }
                })
                .finally(() => {
                  pendingRef.current = false;
                });
            },
          },
        });
        router.refresh();
      }
      pendingRef.current = false;
    });
  }

  return (
    <div className="flex items-center justify-end gap-1">
      {isPending ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setEditOpen(true)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleToggle}
            title={dept.is_active ? t("deactivate") : t("activate")}
          >
            {dept.is_active ? (
              <ToggleRight className="h-4 w-4 text-emerald-600 rtl:-scale-x-100" />
            ) : (
              <ToggleLeft className="h-4 w-4 text-muted-foreground rtl:-scale-x-100" />
            )}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive/60 hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("moveToRecycleBin")}</AlertDialogTitle>
                <AlertDialogDescription>
                  <strong>{dept.name}</strong> {t("willBeMovedToTheRecycle")}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isPending}>{t("cancel")}</AlertDialogCancel>
                <AlertDialogAction disabled={isPending} onClick={handleDelete}>
                  {t("moveToBin")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("editDepartment")}</DialogTitle>
          </DialogHeader>
          <DepartmentForm
            action={updateAction}
            defaultValues={{
              name: dept.name,
              color: dept.color,
              description: dept.description,
              name_ar: dept.name_ar,
              name_en: dept.name_en,
            }}
            submitLabel={t("saveChanges")}
            onSuccess={() => {
              setEditOpen(false);
              router.refresh();
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
