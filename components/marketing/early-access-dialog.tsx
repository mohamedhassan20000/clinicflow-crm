"use client";

import { EarlyAccessForm } from "@/components/auth/early-access-form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { marketingCopy as copy } from "@/lib/marketing-copy";

export function EarlyAccessDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-2xl">{copy.earlyAccess.dialogTitle}</DialogTitle>
          <DialogDescription>{copy.earlyAccess.dialogDescription}</DialogDescription>
        </DialogHeader>
        <EarlyAccessForm mode="dialog" />
      </DialogContent>
    </Dialog>
  );
}
