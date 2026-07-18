"use client";

import { useActionState, useEffect, useState } from "react";
import { ExternalLink, KeyRound, Loader2, MessageCircle, ShieldCheck } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { connectWhatsAppChannel, type MessagingActionResult } from "@/actions/messaging";
import { InternationalPhoneInput } from "@/components/shared/international-phone-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { WhatsAppChannelStatus } from "@/lib/messaging/channel-management";

type Props = {
  status: WhatsAppChannelStatus;
  canManage: boolean;
  entitled: boolean;
  signupUrl: string | null;
};

export function WhatsAppConnectionCard({ status, canManage, entitled, signupUrl }: Props) {
  const t = useTranslations("settings");
  const format = useFormatter();
  const [displayPhoneNumber, setDisplayPhoneNumber] = useState(status.displayPhoneNumber ?? "");
  const [state, formAction, pending] = useActionState(
    connectWhatsAppChannel as (
      previous: MessagingActionResult | null,
      formData: FormData,
    ) => Promise<MessagingActionResult>,
    null,
  );

  useEffect(() => {
    if (state?.success) toast.success(t("whatsAppConnected"));
  }, [state, t]);

  const statusKey = status.status
    ? ({ pending: "statusPending", active: "statusActive", error: "statusError" } as const)[status.status]
    : "statusNotConnected";
  const disabled = pending || !canManage || !entitled;

  return (
    <Card className="max-w-3xl">
      <CardHeader className="border-b">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
            <MessageCircle className="size-5" aria-hidden />
          </span>
          <div>
            <CardTitle>{t("whatsAppConnection")}</CardTitle>
            <CardDescription>{t("whatsAppConnectionDescription")}</CardDescription>
          </div>
        </div>
        <CardAction>
          <Badge variant={status.status === "active" ? "default" : "outline"}>{t(statusKey)}</Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="grid gap-3 rounded-lg border bg-muted/30 p-4 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">{t("connectionStatus")}</p>
            <p className="mt-1 font-medium">{t(statusKey)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t("connectedNumber")}</p>
            <p className="mt-1 font-medium" dir="ltr">{status.displayPhoneNumber ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t("connectedAt")}</p>
            <p className="mt-1 font-medium">
              {status.connectedAt ? format.dateTime(new Date(status.connectedAt), { dateStyle: "medium" }) : "—"}
            </p>
          </div>
        </div>

        {!entitled ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-800 dark:text-amber-300">
            {t("whatsAppNotIncluded")}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          {signupUrl ? (
            <Button variant="outline" asChild>
              <a href={signupUrl} target="_blank" rel="noreferrer">
                {t("open360dialogSignup")}
                <ExternalLink className="size-4 rtl:-scale-x-100" aria-hidden />
              </a>
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">{t("hostedSignupUnavailable")}</p>
          )}
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-4" aria-hidden />
            {t("dialog360ApiKeyHelp")}
          </span>
        </div>

        {entitled ? (
          <form action={formAction} className="space-y-4">
            {state?.error ? (
              <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {state.error}
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="dialog360-api-key">{t("dialog360ApiKey")}</Label>
              <div className="relative">
                <KeyRound className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input id="dialog360-api-key" name="apiKey" type="password" autoComplete="new-password" required minLength={16} disabled={disabled} className="ps-9" />
              </div>
              <p className="text-xs text-muted-foreground">{t("dialog360ApiKeyHelp")}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="dialog360-phone-id">{t("phoneNumberId")}</Label>
              <Input id="dialog360-phone-id" name="phoneNumberId" inputMode="numeric" pattern="[0-9]{5,32}" required disabled={disabled} dir="ltr" />
              <p className="text-xs text-muted-foreground">{t("phoneNumberIdHelp")}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="dialog360-display-phone">{t("displayPhoneNumber")}</Label>
              <InternationalPhoneInput id="dialog360-display-phone" name="displayPhoneNumber" value={displayPhoneNumber} onChange={setDisplayPhoneNumber} required disabled={disabled} />
            </div>

            {!canManage ? <p className="text-sm text-muted-foreground">{t("managerConnectionReadOnly")}</p> : null}

            <div className="flex justify-end">
              <Button type="submit" disabled={disabled}>
                {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                {pending ? t("connectingWhatsApp") : status.configured ? t("rotateWhatsAppCredentials") : t("connectWhatsApp")}
              </Button>
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
