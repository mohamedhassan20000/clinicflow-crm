"use client";

import { useState, useTransition } from "react";
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

interface Props {
  service: {
    id: string;
    name: string;
    price: number;
    department_id: string;
  };
  departments: { id: string; name: string; color: string }[];
}

export function ServiceRowActions({ service, departments }: Props) {
  const [editOpen, setEditOpen] = useState(false);
  const [isDeleting, startDelete] = useTransition();
  const router = useRouter();

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
            Edit
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit service</DialogTitle>
          </DialogHeader>
          <ServiceForm
            action={updateBound}
            departments={departments}
            defaults={{
              department_id: service.department_id,
              name: service.name,
              price: service.price,
            }}
            submitLabel="Save changes"
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
            Delete
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move &ldquo;{service.name}&rdquo; to recycle bin?</AlertDialogTitle>
            <AlertDialogDescription>
              This service will be hidden from the price list and can be
              restored within 30 days.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                startDelete(async () => {
                  const res = await softDeleteService(service.id);
                  if (res.error) {
                    toast.error(res.error);
                  } else {
                    toast.success(`"${service.name}" moved to recycle bin.`, {
                      duration: 10000,
                      action: {
                        label: "Undo",
                        onClick: () => {
                          restoreService(service.id).then((r) => {
                            if (r.error) toast.error(r.error);
                            else {
                              toast.success(`"${service.name}" restored.`);
                              router.refresh();
                            }
                          });
                        },
                      },
                    });
                    router.refresh();
                  }
                })
              }
            >
              Move to bin
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
