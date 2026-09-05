"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  CheckCircle2,
  Loader2,
  MessageCircle,
  QrCode,
  ShieldCheck,
  Smartphone,
  Unplug,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  disconnectWhatsAppQrSession,
  readWhatsAppQrSession,
  startWhatsAppQrSession,
} from "@/actions/messaging-linked-device";
import {
  isLinkedDeviceTransient,
  type LinkedDeviceErrorCode,
  type LinkedDeviceView,
} from "@/lib/messaging/linked-device-view";
import type { WhatsAppConnectionMode } from "@/lib/messaging/connection-view";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Props = {
  initialView: LinkedDeviceView;
  /** Which method owns this clinic's single WhatsApp channel, if any. */
  ownedBy: WhatsAppConnectionMode | null;
  canManage: boolean;
  entitled: boolean;
  /** False when this deployment has no pairing service configured. */
  available: boolean;
};

/** How often the panel asks the server what the pairing is doing. */
const POLL_INTERVAL_MS = 2_000;

const ERROR_KEYS: Record<LinkedDeviceErrorCode, string> = {
  unavailable: "waQrErrorUnavailable",
  pairing_failed: "waQrErrorPairingFailed",
  logged_out: "waQrErrorLoggedOut",
  // A release-ordering fault, not a retryable one: the Regenerate button below
  // will keep being offered, but the sentence has to tell the admin that the
  // service itself is what needs to change.
  worker_outdated: "waQrErrorWorkerOutdated",
  unknown: "waQrErrorUnknown",
};

/**
 * "Connect with QR" — the simple way for a clinic to connect the WhatsApp
 * number they already use, by scanning a code from their own phone.
 *
 * The code shown here is a real pairing code issued by WhatsApp for this clinic
 * alone. Nothing about how that happens surfaces: no Facebook login, no Meta
 * app, no account setup, and none of the words the machinery uses. The clinic
 * sees a code, four instructions, and then their connected number.
 *
 * The browser only ever holds a picture of the current code and a coarse status.
 * Everything that could authenticate as the clinic's WhatsApp lives on the
 * server and never crosses this boundary.
 */
export function WhatsAppQrConnectCard({
  initialView,
  ownedBy,
  canManage,
  entitled,
  available,
}: Props) {
  const t = useTranslations("settings");
  const format = useFormatter();
  const [view, setView] = useState<LinkedDeviceView>(initialView);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [starting, startTransition] = useTransition();
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const connected = view.status === "connected";
  // The clinic has exactly one WhatsApp channel. When the Meta API method owns
  // it, this card explains that instead of offering a Connect button that could
  // only fail.
  const ownedElsewhere = ownedBy !== null && ownedBy !== "linked_device";

  // While a pairing is in flight the panel re-reads the durable session state.
  // The poll stops the moment the pairing settles, the panel closes, or the
  // component unmounts, so a forgotten tab never keeps polling.
  useEffect(() => {
    if (!dialogOpen || !isLinkedDeviceTransient(view.status)) return;
    const timer = setInterval(() => {
      void (async () => {
        const next = await readWhatsAppQrSession().catch(() => null);
        if (!mounted.current || !next) return;
        setView(next);
      })();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [dialogOpen, view.status]);

  const start = useCallback(() => {
    setDialogOpen(true);
    startTransition(async () => {
      const outcome = await startWhatsAppQrSession().catch(() => null);
      if (!mounted.current) return;
      if (!outcome) {
        toast.error(t("waQrErrorUnknown"));
        return;
      }
      setView(outcome.view);
      if (outcome.error) toast.error(outcome.error);
    });
  }, [t]);

  const disconnect = useCallback(() => {
    setDisconnecting(true);
    void (async () => {
      const outcome = await disconnectWhatsAppQrSession().catch(() => null);
      if (!mounted.current) return;
      setDisconnecting(false);
      if (!outcome || outcome.error) {
        toast.error(outcome?.error ?? t("waQrErrorUnknown"));
        return;
      }
      setConfirmOpen(false);
      setDialogOpen(false);
      setView(outcome.view);
    })();
  }, [t]);

  const badge = connected
    ? { label: t("waConnConnected"), variant: "default" as const }
    : view.status === "awaiting_scan"
      ? { label: t("waQrStatusAwaitingScan"), variant: "outline" as const }
      : view.status === "starting" || view.status === "connecting"
        ? { label: t("waConnConnecting"), variant: "outline" as const }
        : view.status === "error"
          ? { label: t("waConnError"), variant: "destructive" as const }
          : { label: t("waConnNotConnected"), variant: "outline" as const };

  // An admin of a connected clinic must always be able to open the inbox or
  // disconnect — even if this deployment has since lost its pairing service.
  // Only *starting* a new pairing needs the service to be there.
  const canAct = entitled && canManage && !ownedElsewhere;
  const canStart = canAct && available;

  return (
    <>
      <Card className="max-w-3xl" data-testid="whatsapp-qr-card">
        <CardHeader className="border-b">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
              <Smartphone className="size-5" aria-hidden />
            </span>
            <div>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {t("waQrTitle")}
                {!connected ? (
                  <Badge variant="secondary" className="font-normal">
                    {t("waQrRecommended")}
                  </Badge>
                ) : null}
              </CardTitle>
              <CardDescription>{t("waQrDescription")}</CardDescription>
            </div>
          </div>
          <CardAction>
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </CardAction>
        </CardHeader>

        <CardContent className="space-y-5">
          {!entitled ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-800 dark:text-amber-300">
              {t("whatsAppNotIncluded")}
            </div>
          ) : ownedElsewhere ? (
            <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
              {t("waQrOwnedByMetaApi")}
            </div>
          ) : !available && !connected ? (
            <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
              {t("waQrUnavailable")}
            </div>
          ) : null}

          {connected ? (
            <div className="grid gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground">{t("connectedNumber")}</p>
                <p className="mt-0.5 font-medium" dir="ltr">
                  {view.phoneNumber ?? "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t("connectedAt")}</p>
                <p className="mt-0.5 font-medium">
                  {view.connectedAt
                    ? format.dateTime(new Date(view.connectedAt), { dateStyle: "medium" })
                    : "—"}
                </p>
              </div>
            </div>
          ) : ownedElsewhere ? null : (
            <ol className="grid gap-2 text-sm text-muted-foreground">
              {[t("waQrStep1"), t("waQrStep2"), t("waQrStep3"), t("waQrStep4")].map(
                (step, index) => (
                  <li key={step} className="flex items-start gap-2">
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                      {index + 1}
                    </span>
                    {step}
                  </li>
                ),
              )}
            </ol>
          )}

          {/* H4: said before the code is generated, not after. Linking copies
              existing conversations off a personal handset, and a clinic has to
              know exactly which ones before they scan. */}
          {!connected && !ownedElsewhere ? (
            <div className="rounded-lg border bg-muted/30 p-4 text-sm">
              <p className="font-medium">{t("waHistoryPrivacyTitle")}</p>
              <p className="mt-1 text-muted-foreground">{t("waHistoryPrivacyBody")}</p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            {canAct && (connected || canStart) ? (
              connected ? (
                <>
                  <Button asChild>
                    <Link href="/inbox">
                      <MessageCircle className="size-4" aria-hidden />
                      {t("waBusinessOpenInbox")}
                    </Link>
                  </Button>
                  <DisconnectButton
                    open={confirmOpen}
                    onOpenChange={setConfirmOpen}
                    pending={disconnecting}
                    onConfirm={disconnect}
                  />
                </>
              ) : (
                <Button onClick={start} disabled={starting}>
                  {starting ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <QrCode className="size-4" aria-hidden />
                  )}
                  {t("waQrGenerate")}
                </Button>
              )
            ) : null}
            {!canManage ? (
              <p className="text-sm text-muted-foreground">{t("managerConnectionReadOnly")}</p>
            ) : null}
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="size-4" aria-hidden />
              {t("waQrSecurityHint")}
            </span>
          </div>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md" data-testid="whatsapp-qr-dialog">
          <DialogHeader>
            <DialogTitle>
              {connected ? t("waQrDialogConnectedTitle") : t("waQrDialogTitle")}
            </DialogTitle>
            <DialogDescription>
              {connected ? t("waQrDialogConnectedBody") : t("waQrDialogDescription")}
            </DialogDescription>
          </DialogHeader>

          <QrPanel view={view} onRegenerate={start} regenerating={starting} />

          {connected ? (
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                {t("waBusinessClose")}
              </Button>
              <Button asChild>
                <Link href="/inbox">{t("waBusinessOpenInbox")}</Link>
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The scan surface. It shows exactly one thing at a time: the live code, the
 * reason there is no code right now, or the connected number. The code is a
 * server-rendered image — the page never handles the pairing payload itself.
 */
function QrPanel({
  view,
  onRegenerate,
  regenerating,
}: {
  view: LinkedDeviceView;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  const t = useTranslations("settings");

  if (view.status === "connected") {
    return (
      <div
        className="flex flex-col items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-6 text-center"
        aria-live="polite"
      >
        <CheckCircle2 className="size-8 text-emerald-600" aria-hidden />
        <p className="font-medium">{t("waConnConnected")}</p>
        <p className="font-medium" dir="ltr">
          {view.phoneNumber ?? "—"}
        </p>
      </div>
    );
  }

  if (view.status === "error" || view.status === "disconnected") {
    const message =
      view.status === "error" ? t(ERROR_KEYS[view.errorCode ?? "unknown"]) : t("waQrExpired");
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border p-6 text-center" role="alert">
        <p className="text-sm text-muted-foreground">{message}</p>
        <Button onClick={onRegenerate} disabled={regenerating}>
          {regenerating ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {t("waQrRegenerate")}
        </Button>
      </div>
    );
  }

  if (view.status === "awaiting_scan" && view.qrImage) {
    return (
      <div className="flex flex-col items-center gap-3" aria-live="polite">
        <div className="rounded-xl border bg-white p-3">
          {/* Unoptimized: the payload changes every few seconds and is a data
              URL, so there is nothing for the image pipeline to cache. */}
          <Image
            src={view.qrImage}
            alt={t("waQrImageAlt")}
            width={256}
            height={256}
            unoptimized
            priority
          />
        </div>
        <p className="text-sm text-muted-foreground">{t("waQrWaiting")}</p>
        <ol className="grid w-full gap-1.5 text-sm text-muted-foreground">
          {[t("waQrStep1"), t("waQrStep2"), t("waQrStep3"), t("waQrStep4")].map((step, index) => (
            <li key={step} className="flex items-start gap-2">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium">
                {index + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
      </div>
    );
  }

  // starting, connecting, or a code that has just lapsed and is being replaced.
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center" aria-live="polite">
      <Loader2 className="size-8 animate-spin text-muted-foreground" aria-hidden />
      <p className="text-sm text-muted-foreground">
        {view.status === "connecting" ? t("waQrConnecting") : t("waQrPreparing")}
      </p>
    </div>
  );
}

/**
 * Disconnecting stops every WhatsApp send and inbound conversation for the
 * clinic, so it is confirmed first.
 */
function DisconnectButton({
  open,
  onOpenChange,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  pending: boolean;
  onConfirm: () => void;
}) {
  const t = useTranslations("settings");
  return (
    <AlertDialog open={open} onOpenChange={(next) => (pending ? null : onOpenChange(next))}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" disabled={pending}>
          <Unplug className="size-4" aria-hidden />
          {t("waBusinessDisconnect")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("waDisconnectTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("waQrDisconnectBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t("waDisconnectCancel")}</AlertDialogCancel>
          <AlertDialogAction
            type="button"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
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
