"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, Inbox, Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { syncWhatsAppHistory } from "@/actions/messaging-linked-device";
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
import type { HistoryImportView } from "@/lib/messaging/linked-device";

/**
 * P8B — what the history import actually did, and nothing to decide.
 *
 * This replaces the accept/dismiss review card. That card existed because the
 * import used to hold most of the linked account's chats back from the Inbox
 * and ask a human which of them counted as clinic business. The product rule
 * changed: a linked account's conversations are the clinic's conversations, and
 * they all land in the Inbox. There is nothing left to triage here — only how
 * far the import got, which a clinic still needs to see, because WhatsApp
 * decides how much history it sends and the honest answer is sometimes "less
 * than you expected".
 */

type Props = {
  view: HistoryImportView;
  /**
   * Whether a linked device is connected right now, and whether this viewer may
   * act on it. Together they decide whether "Sync WhatsApp history" is offered:
   * the request only means anything on a live, authenticated session.
   */
  connected?: boolean;
  canManage?: boolean;
};

export function WhatsAppHistoryImportCard({ view, connected = false, canManage = false }: Props) {
  const t = useTranslations("settings");
  const format = useFormatter();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [requested, setRequested] = useState(false);

  // Nothing has ever been imported and nothing is running. The card would be
  // noise on a page that is mostly about connecting — unless a device *is*
  // connected, in which case this is the one place the clinic can ask for the
  // history that never arrived.
  if (view.status === "idle" && view.chatsImported === 0 && !connected) return null;

  function requestSync() {
    startTransition(async () => {
      const result = await syncWhatsAppHistory();
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      setRequested(true);
      toast.success(t("waHistorySyncRequested"));
      router.refresh();
    });
  }

  const incomplete = view.status === "partial" || view.status === "unavailable";
  // An explicit map rather than an interpolated key: the i18n gate resolves
  // message keys statically, and a template literal is invisible to it — which
  // is exactly how a status ends up rendering its own key name in production.
  const statusLabel = {
    idle: t("waHistoryStatus_idle"),
    importing: t("waHistoryStatus_importing"),
    partial: t("waHistoryStatus_partial"),
    complete: t("waHistoryStatus_complete"),
    unavailable: t("waHistoryStatus_unavailable"),
  }[view.status];

  return (
    <Card className="max-w-3xl" data-testid="whatsapp-history-import-card">
      <CardHeader className="border-b">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-lg bg-sky-500/10 text-sky-700 dark:text-sky-400">
            <Inbox className="size-5" aria-hidden />
          </span>
          <div>
            <CardTitle>{t("waHistoryImportTitle")}</CardTitle>
            <CardDescription>{t("waHistoryImportDescription")}</CardDescription>
          </div>
        </div>
        <CardAction>
          <Badge variant={view.status === "complete" ? "secondary" : "outline"}>
            {statusLabel}
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        {incomplete ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-800 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">{t("waHistoryStatusPartial")}</p>
              <p className="mt-0.5">{t("waHistoryStatusPartialBody")}</p>
            </div>
          </div>
        ) : null}

        <dl className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border p-3">
            <dt className="text-xs text-muted-foreground">{t("waHistoryImportChats")}</dt>
            <dd className="text-lg font-semibold" dir="ltr">
              {format.number(view.chatsImported)}
            </dd>
          </div>
          <div className="rounded-lg border p-3">
            <dt className="text-xs text-muted-foreground">{t("waHistoryImportMessages")}</dt>
            <dd className="text-lg font-semibold" dir="ltr">
              {format.number(view.messagesImported)}
            </dd>
          </div>
        </dl>

        {view.completedAt ? (
          <p className="text-xs text-muted-foreground">
            {t("waHistoryImportCompletedAt", {
              date: format.dateTime(new Date(view.completedAt), { dateStyle: "medium", timeStyle: "short" }),
            })}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/inbox">{t("waHistoryImportOpenInbox")}</Link>
          </Button>
          {connected && canManage ? (
            <Button variant="outline" size="sm" disabled={pending} onClick={requestSync}>
              {pending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="size-4" aria-hidden />
              )}
              {t("waHistorySyncAction")}
            </Button>
          ) : null}
        </div>
        {connected && canManage ? (
          <p className="text-xs text-muted-foreground">
            {requested ? t("waHistorySyncPendingHint") : t("waHistorySyncHint")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
