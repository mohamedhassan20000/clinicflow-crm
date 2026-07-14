"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DepartmentForm } from "@/components/settings/department-form";
import { createDepartment } from "@/actions/settings";
import { useTranslations } from "next-intl";

export function AddDepartmentDialog() {
  const t = useTranslations("settings");
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          {t("addDepartment")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("addDepartment")}</DialogTitle>
        </DialogHeader>
        <DepartmentForm
          action={createDepartment}
          submitLabel={t("createDepartment")}
          onSuccess={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
