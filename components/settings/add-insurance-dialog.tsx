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
import { InsuranceForm } from "@/components/settings/insurance-form";
import { createInsurance } from "@/actions/settings";
import { useTranslations } from "next-intl";

export function AddInsuranceDialog() {
  const t = useTranslations("settings");
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          {t("addProvider")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("addInsuranceProvider")}</DialogTitle>
        </DialogHeader>
        <InsuranceForm action={createInsurance} onSuccess={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
