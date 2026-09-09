"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ServiceForm } from "@/components/settings/service-form";
import { softDeleteService, restoreService, updateService } from "@/actions/settings";
import { useTranslations } from "next-intl";

interface Props {
  service: {
    id: string;
    name: string;
    price: number;
    department_id: string;
    /** Optional patient-facing display names; absent before the migration. */
    name_ar?: string | null;
    name_en?: string | null;
  };
  departments: { id: string; name: string; color: string }[];
}

export function ServiceRowActions({ service, departments }: Props) {
  const t = useTranslations("settings");
  const [editOpen, setEditOpen] = useState(false);
  const [isDeleting, startDelete] = useTransition();
  const router = useRouter();
  const deletePendingRef = useRef(false);

  const updateBound = updateService.bind(null, service.id);

  return (
    <div className="flex items-center justify-end gap-1">
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
          >
            <Pencil className="h-3.5 w-3.5" />
            {t("edit")}</Button>
        </DialogTrigger>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("editService")}</DialogTitle>
          </DialogHeader>
          <ServiceForm
            action={updateBound}
            departments={departments}
            defaults={{
              department_id: service.department_id,
              name: service.name,
              price: service.price,
              name_ar: service.name_ar,
              name_en: service.name_en,
            }}
            submitLabel={t("saveChanges")}
            onSuccess={() => {
              setEditOpen(false);
              router.refresh();
            }}
          />
        </DialogContent>
      </Dialog>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive"
            disabled={isDeleting}
          >
            {isDeleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            {t("delete")}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("moveNamedServiceToBin", { name: service.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {"This service will be hidden from the price list and can be"}
              {t("restoredWithin30Days")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={isDeleting}
              onClick={() =>
                startDelete(async () => {
                  if (deletePendingRef.current) return;
                  deletePendingRef.current = true;
                  const res = await softDeleteService(service.id);
                  if (res.error) {
                    toast.error(res.error);
                  } else {
                    toast.success(t("namedItemMovedToRecycleBin", { name: service.name }), {
                      duration: 10000,
                      action: {
                        label: t("undo"),
                        onClick: () => {
                          if (deletePendingRef.current) return;
                          deletePendingRef.current = true;
                          restoreService(service.id)
                            .then((r) => {
                              if (r.error) toast.error(r.error);
                              else {
                                toast.success(t("namedItemRestored", { name: service.name }));
                                router.refresh();
                              }
                            })
                            .finally(() => {
                              deletePendingRef.current = false;
                            });
                        },
                      },
                    });
                    router.refresh();
                  }
                  deletePendingRef.current = false;
                })
              }
            >
              {t("moveToBin")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
