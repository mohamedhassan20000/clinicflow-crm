"use client";

import { useState } from "react";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CreateStaffForm } from "@/components/settings/staff-form";
import { createStaff } from "@/actions/settings";
import type { Tables } from "@/types/database";

type Department = Pick<Tables<"departments">, "id" | "name">;

export function AddStaffDialog({ departments }: { departments: Department[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-2">
          <UserPlus className="h-4 w-4" />
          Add staff
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add staff member</DialogTitle>
        </DialogHeader>
        <CreateStaffForm
          action={createStaff}
          departments={departments}
          onSuccess={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
