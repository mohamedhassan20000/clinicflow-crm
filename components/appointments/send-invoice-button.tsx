"use client";

import { useState, useTransition } from "react";
import { Loader2, Send } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { sendInvoiceToPatient } from "@/actions/appointments";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Manual "Send to patient" control for a saved invoice (2026-07-19 flow
 * revision). Delivery is never automatic: the employee clicks Send, confirms in
 * this popup, and the invoice is dispatched to Email and WhatsApp independently.
 * Re-sending only retries the channel that has not yet succeeded (idempotent).
 */
export function SendInvoiceButton({ appointmentId }: { appointmentId: string }) {
  const t = useTranslations("appointments");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function confirmSend() {
    startTransition(async () => {
      const result = await sendInvoiceToPatient(appointmentId);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setOpen(false);
      const channels = result.channels;
      if (!channels) {
        toast.success(t("invoiceDeliveredToast"));
        return;
      }
      const states = [channels.email, channels.whatsapp];
      const reached = states.filter(
        (s) => s === "sent" || s === "already_sent",
      ).length;
      const anyUnreached = states.some(
        (s) => s === "failed" || s === "unavailable",
      );
      if (reached === 0) {
        toast.error(t("invoiceDeliveryFailedToast"));
      } else if (anyUnreached) {
        toast.success(t("invoiceDeliveredPartialToast"));
      } else {
        toast.success(t("invoiceDeliveredToast"));
      }
    });
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 gap-1.5 text-xs"
        onClick={() => setOpen(true)}
      >
        <Send className="h-3.5 w-3.5 rtl:-scale-x-100" />
        {t("sendToPatient")}
      </Button>

      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("sendInvoiceTitle")}</DialogTitle>
            <DialogDescription>{t("sendInvoiceConfirm")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              {t("cancel")}
            </Button>
            <Button type="button" onClick={confirmSend} disabled={pending} className="gap-2">
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4 rtl:-scale-x-100" />
              )}
              {t("sendToPatient")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
