"use client";

import { EarlyAccessForm } from "@/components/auth/early-access-form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslations } from "next-intl";
import { usePublicTheme } from "@/components/marketing/public-theme";

export function EarlyAccessDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("marketing.earlyAccess");
  const { theme } = usePublicTheme();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`${theme} forced-public-scope marketing-page max-h-[90dvh] overflow-y-auto sm:max-w-lg`}>
        <DialogHeader>
          <DialogTitle className="text-2xl">{t("dialogTitle")}</DialogTitle>
          <DialogDescription>{t("dialogDescription")}</DialogDescription>
        </DialogHeader>
        <EarlyAccessForm mode="dialog" />
      </DialogContent>
    </Dialog>
  );
}
