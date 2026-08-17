"use client";

import { useCallback, useState, useTransition } from "react";
import { Loader2, Unplug } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { disconnectWhatsAppChannel } from "@/actions/messaging-onboarding";
import type { WhatsAppBusinessConnectionView } from "@/lib/messaging/connection-view";
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
import { Button } from "@/components/ui/button";

type Props = {
  disabled?: boolean;
  label: string;
  /** Receives the post-disconnect view so the owning card can re-render. */
  onDisconnected: (connection: WhatsAppBusinessConnectionView) => void;
};

/**
 * Shared "Disconnect" control for both connection methods.
 *
 * Disconnecting stops every WhatsApp send and inbound conversation for the
 * clinic, so it is confirmed first and the confirmation says exactly what stops
 * and what is kept. The action itself is admin-only and clinic-scoped on the
 * server; this component only ever reflects what it returns.
 */
export function DisconnectWhatsAppButton({ disabled, label, onDisconnected }: Props) {
  const t = useTranslations("settings");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const confirm = useCallback(() => {
    startTransition(async () => {
      const outcome = await disconnectWhatsAppChannel().catch(() => null);
      if (!outcome || outcome.error || !outcome.connection) {
        toast.error(outcome?.error ?? t("metaApiFailedNote"));
        return;
      }
      setOpen(false);
      onDisconnected(outcome.connection);
    });
  }, [onDisconnected, t]);

  return (
    <AlertDialog open={open} onOpenChange={(next) => (pending ? null : setOpen(next))}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" disabled={disabled || pending}>
          <Unplug className="size-4" aria-hidden />
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("waDisconnectTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("waDisconnectBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t("waDisconnectCancel")}</AlertDialogCancel>
          <AlertDialogAction
            // Kept out of the form-submit path: this must not double as a
            // credential submission if it is ever rendered inside a form.
            type="button"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              confirm();
            }}
          >
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {pending ? t("metaApiDisconnecting") : t("waDisconnectConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
