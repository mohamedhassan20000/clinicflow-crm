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
import { ServiceForm } from "@/components/settings/service-form";
import { createService } from "@/actions/settings";
import { useTranslations } from "next-intl";

interface Props {
  departments: { id: string; name: string; color: string }[];
}

export function AddServiceDialog({ departments }: Props) {
  const t = useTranslations("settings");
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          {t("addService")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("addService")}</DialogTitle>
        </DialogHeader>
        <ServiceForm
          action={createService}
          departments={departments}
          submitLabel={t("createService")}
          onSuccess={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
