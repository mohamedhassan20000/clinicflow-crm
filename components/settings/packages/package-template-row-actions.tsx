"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, PowerOff, RotateCcw, Trash2 } from "lucide-react";
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
import { PackageTemplateForm } from "@/components/settings/packages/package-template-form";
import {
  deactivatePackageTemplate,
  deletePackageTemplate,
  restorePackageTemplate,
  updatePackageTemplate,
} from "@/actions/package-templates";

export interface PackageTemplateRowData {
  id: string;
  name: string;
  department_id: string;
  total_sessions: number;
  price_per_session: number | null;
  total_price: number | null;
  notes: string | null;
  is_active: boolean;
}

interface Props {
  template: PackageTemplateRowData;
  departments: { id: string; name: string; color: string }[];
  canMutate: boolean;
}

export function PackageTemplateRowActions({
  template,
  departments,
  canMutate,
}: Props) {
  const [editOpen, setEditOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const pendingRef = useRef(false);

  if (!canMutate) return null;

  return (
    <div className="flex items-center justify-end gap-1">
      {template.is_active ? (
        <>
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
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Edit package template</DialogTitle>
              </DialogHeader>
              <PackageTemplateForm
                action={updatePackageTemplate}
                departments={departments}
                defaults={{
                  id: template.id,
                  department_id: template.department_id,
                  name: template.name,
                  total_sessions: template.total_sessions,
                  price_per_session: template.price_per_session,
                  total_price: template.total_price,
                  notes: template.notes,
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
                disabled={isPending}
              >
                {isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <PowerOff className="h-3.5 w-3.5" />
                )}
                Deactivate
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Deactivate &ldquo;{template.name}&rdquo;?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  The template will be hidden from the patient Add Package
                  dialog. You can restore it from the deactivated section.
                  Existing patient packages are unaffected.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isPending}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  disabled={isPending}
                  onClick={() =>
                    startTransition(async () => {
                      if (pendingRef.current) return;
                      pendingRef.current = true;
                      const res = await deactivatePackageTemplate(template.id);
                      if (res.error) toast.error(res.error);
                      else {
                        toast.success(`"${template.name}" deactivated.`);
                        router.refresh();
                      }
                      pendingRef.current = false;
                    })
                  }
                >
                  Deactivate
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={isPending}
            onClick={() =>
              startTransition(async () => {
                if (pendingRef.current) return;
                pendingRef.current = true;
                const res = await restorePackageTemplate(template.id);
                if (res.error) toast.error(res.error);
                else {
                  toast.success(`"${template.name}" restored.`);
                  router.refresh();
                }
                pendingRef.current = false;
              })
            }
          >
            {isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
            Restore
          </Button>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive"
                disabled={isPending}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Permanently delete &ldquo;{template.name}&rdquo;?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  This cannot be undone. Existing patient packages will keep
                  their current data.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isPending}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  disabled={isPending}
                  onClick={() =>
                    startTransition(async () => {
                      if (pendingRef.current) return;
                      pendingRef.current = true;
                      const res = await deletePackageTemplate(template.id);
                      if (res.error) toast.error(res.error);
                      else {
                        toast.success(`"${template.name}" deleted.`);
                        router.refresh();
                      }
                      pendingRef.current = false;
                    })
                  }
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
}
