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
import { PackageTemplateForm } from "@/components/settings/packages/package-template-form";
import { createPackageTemplate } from "@/actions/package-templates";
import { useTranslations } from "next-intl";

interface Props {
  departments: { id: string; name: string; color: string }[];
}

export function AddPackageTemplateDialog({ departments }: Props) {
  const t = useTranslations("settings");
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-2" disabled={departments.length === 0}>
          <Plus className="h-4 w-4" />
          {t("addTemplate")}</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("addPackageTemplate")}</DialogTitle>
        </DialogHeader>
        <PackageTemplateForm
          action={createPackageTemplate}
          departments={departments}
          submitLabel={t("createTemplate")}
          onSuccess={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
