"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Pencil, ToggleLeft, ToggleRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DepartmentForm } from "@/components/settings/department-form";
import type { ActionResult } from "@/actions/settings";
import type { Tables } from "@/types/database";

type Dept = Tables<"departments">;

interface DepartmentActionsProps {
  dept: Dept;
  updateAction: (prev: ActionResult | null, fd: FormData) => Promise<ActionResult>;
  toggleAction: (isActive: boolean) => Promise<ActionResult>;
}

export function DepartmentActions({ dept, updateAction, toggleAction }: DepartmentActionsProps) {
  const [editOpen, setEditOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleToggle() {
    startTransition(async () => {
      const result = await toggleAction(!dept.is_active);
      if (result.error) toast.error(result.error);
      else toast.success(dept.is_active ? "Department deactivated." : "Department reactivated.");
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
            title={dept.is_active ? "Deactivate" : "Activate"}
          >
            {dept.is_active ? (
              <ToggleRight className="h-4 w-4 text-emerald-600" />
            ) : (
              <ToggleLeft className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
        </>
      )}

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit department</DialogTitle>
          </DialogHeader>
          <DepartmentForm
            action={updateAction}
            defaultValues={{
              name: dept.name,
              color: dept.color,
              description: dept.description,
            }}
            submitLabel="Save changes"
            onSuccess={() => setEditOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
