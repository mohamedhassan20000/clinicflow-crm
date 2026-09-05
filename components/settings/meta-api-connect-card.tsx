"use client";

import { useCallback, useState, useTransition } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  MessageCircle,
  Plug,
  ShieldCheck,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import { toast } from "sonner";
import { connectMetaApiCredentials } from "@/actions/messaging-onboarding";
import type { WhatsAppBusinessConnectionView } from "@/lib/messaging/connection-view";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DisconnectWhatsAppButton } from "@/components/settings/disconnect-whatsapp-button";

/**
 * Everything the clinic must configure on Meta's side. Both values are
 * clinic-specific and safe to display; null when the environment cannot produce
 * them, which the card states plainly rather than rendering a broken
 * instruction.
 */
type WebhookSetup = { callbackUrl: string; verifyToken: string } | null;

type Props = {
  initialConnection: WhatsAppBusinessConnectionView;
  canManage: boolean;
  entitled: boolean;
  webhookSetup: WebhookSetup;
};

/**
 * P7D — "Connect with Meta API": the first of the two per-clinic connection
 * methods, for clinics that already run their own WhatsApp Cloud API setup.
 *
 * The clinic supplies credentials belonging to *their* Meta app and WABA. They
 * are posted once to a server action that proves them against Meta before
 * storing them encrypted against this clinic alone, and are never rendered back
 * — the card only ever shows the resulting connection state and the display
 * number Meta reported.
 *
 * Nothing platform-side is exposed here: no ClinicFlow app id, app secret,
 * system-user token, business id, internal WABA id or raw Meta error. Failures
 * arrive as one localized sentence chosen by the server.
 */
export function MetaApiConnectCard({
  initialConnection,
  canManage,
  entitled,
  webhookSetup,
}: Props) {
  const t = useTranslations("settings");
  const format = useFormatter();
  const [connection, setConnection] =
    useState<WhatsAppBusinessConnectionView>(initialConnection);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // This card owns the channel only when the clinic connected through it. The
  // clinic has exactly one WhatsApp channel, so when the QR method owns it this
  // card explains that instead of offering a competing form.
  const ownedHere = connection.mode === "manual_api";
  const ownedElsewhere = connection.mode !== null && !ownedHere;
  const status = ownedHere ? connection.status : "not_connected";

  const submit = useCallback(
    (formData: FormData) => {
      setError(null);
      startTransition(async () => {
        const outcome = await connectMetaApiCredentials({
          appId: String(formData.get("appId") ?? ""),
          appSecret: String(formData.get("appSecret") ?? ""),
          accessToken: String(formData.get("accessToken") ?? ""),
          phoneNumberId: String(formData.get("phoneNumberId") ?? ""),
          wabaId: String(formData.get("wabaId") ?? ""),
        }).catch(() => null);
        if (!outcome || outcome.error || !outcome.connection) {
          setError(outcome?.error ?? t("metaApiFailedNote"));
          return;
        }
        setConnection(outcome.connection);
        toast.success(t("metaApiConnectedToast"));
      });
    },
    [t],
  );

  const badge =
    status === "connected"
      ? { label: t("waConnConnected"), variant: "default" as const }
      : status === "verifying"
        ? { label: t("waConnVerifying"), variant: "outline" as const }
        : status === "failed"
          ? { label: t("waConnError"), variant: "destructive" as const }
          : { label: t("waConnNotConnected"), variant: "outline" as const };

  const formDisabled = pending || !canManage || !entitled || ownedElsewhere;

  return (
    <Card className="max-w-3xl" data-testid="whatsapp-meta-api-card">
      <CardHeader className="border-b">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-lg bg-sky-500/10 text-sky-700 dark:text-sky-400">
            <Plug className="size-5" aria-hidden />
          </span>
          <div>
            <CardTitle>{t("metaApiTitle")}</CardTitle>
            <CardDescription>{t("metaApiDescription")}</CardDescription>
          </div>
        </div>
        <CardAction>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-6">
        {!entitled ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-800 dark:text-amber-300">
            {t("whatsAppNotIncluded")}
          </div>
        ) : ownedElsewhere ? (
          <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
            {t("metaApiOwnedByQr")}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("metaApiIntro")}</p>
        )}

        {ownedHere && status !== "not_connected" ? (
          <div
            className={`grid gap-3 rounded-lg border p-4 sm:grid-cols-2 ${
              status === "connected"
                ? "border-emerald-500/30 bg-emerald-500/5"
                : "bg-muted/30"
            }`}
          >
            <div>
              <p className="text-xs text-muted-foreground">{t("connectedNumber")}</p>
              <p className="mt-0.5 font-medium" dir="ltr">
                {connection.displayPhoneNumber ?? "—"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t("connectedAt")}</p>
              <p className="mt-0.5 font-medium">
                {connection.connectedAt
                  ? format.dateTime(new Date(connection.connectedAt), {
                      dateStyle: "medium",
                    })
                  : "—"}
              </p>
            </div>
          </div>
        ) : null}

        {ownedHere && status === "verifying" ? (
          <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t("metaApiVerifyingNote")}
          </p>
        ) : null}

        {ownedHere && status === "failed" ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{t("metaApiFailedNote")}</span>
          </div>
        ) : null}

        {ownedHere && status === "connected" ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="inline-flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="size-4" aria-hidden />
              {t("metaConnectedNote")}
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/inbox">
                <MessageCircle className="size-4" aria-hidden />
                {t("waBusinessOpenInbox")}
              </Link>
            </Button>
          </div>
        ) : null}

        {entitled && !ownedElsewhere ? (
          <>
            <WebhookSetupBlock setup={webhookSetup} />

            <form action={submit} className="space-y-4">
              {error ? (
                <div
                  role="alert"
                  className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
                >
                  {error}
                </div>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  id="meta-api-app-id"
                  name="appId"
                  label={t("metaApiAppId")}
                  help={t("metaApiAppIdHelp")}
                  inputMode="numeric"
                  pattern="[0-9]{5,32}"
                  disabled={formDisabled}
                />
                <Field
                  id="meta-api-app-secret"
                  name="appSecret"
                  label={t("metaApiAppSecret")}
                  help={t("metaApiAppSecretHelp")}
                  type="password"
                  pattern="[a-fA-F0-9]{32}"
                  disabled={formDisabled}
                  secret
                />
                <Field
                  id="meta-api-waba-id"
                  name="wabaId"
                  label={t("metaApiWabaId")}
                  help={t("metaApiWabaIdHelp")}
                  inputMode="numeric"
                  pattern="[0-9]{5,32}"
                  disabled={formDisabled}
                />
                <Field
                  id="meta-api-phone-number-id"
                  name="phoneNumberId"
                  label={t("phoneNumberId")}
                  help={t("metaApiPhoneNumberIdHelp")}
                  inputMode="numeric"
                  pattern="[0-9]{5,32}"
                  disabled={formDisabled}
                />
              </div>

              <Field
                id="meta-api-access-token"
                name="accessToken"
                label={t("metaApiAccessToken")}
                help={t("metaApiAccessTokenHelp")}
                type="password"
                minLength={32}
                disabled={formDisabled}
                secret
              />

              {!canManage ? (
                <p className="text-sm text-muted-foreground">
                  {t("managerConnectionReadOnly")}
                </p>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ShieldCheck className="size-4" aria-hidden />
                  {t("metaApiSecurityHint")}
                </span>
                <div className="flex items-center gap-2">
                  {ownedHere && canManage ? (
                    <DisconnectWhatsAppButton
                      disabled={pending}
                      label={t("metaApiDisconnect")}
                      onDisconnected={(next) => {
                        setConnection(next);
                        setError(null);
                        toast.success(t("metaApiDisconnectedToast"));
                      }}
                    />
                  ) : null}
                  <Button type="submit" disabled={formDisabled}>
                    {pending ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                      <KeyRound className="size-4" aria-hidden />
                    )}
                    {pending
                      ? t("metaApiConnecting")
                      : ownedHere
                        ? t("metaApiReconnect")
                        : t("metaApiConnect")}
                  </Button>
                </div>
              </div>
            </form>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** One labelled credential input. Secrets are never prefilled or read back. */
function Field({
  id,
  name,
  label,
  help,
  disabled,
  secret,
  ...input
}: {
  id: string;
  name: string;
  label: string;
  help: string;
  disabled: boolean;
  secret?: boolean;
} & React.ComponentProps<typeof Input>) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        required
        disabled={disabled}
        dir="ltr"
        autoComplete={secret ? "new-password" : "off"}
        aria-describedby={`${id}-help`}
        {...input}
      />
      <p id={`${id}-help`} className="text-xs text-muted-foreground">
        {help}
      </p>
    </div>
  );
}

/**
 * The callback URL and verify token the clinic pastes into their own Meta app.
 * Read-only and copyable — this is configuration the clinic performs on Meta,
 * not something ClinicFlow can do on their behalf.
 */
function WebhookSetupBlock({ setup }: { setup: WebhookSetup }) {
  const t = useTranslations("settings");
  const [copied, setCopied] = useState<string | null>(null);

  const copy = useCallback(async (field: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(field);
      setTimeout(() => setCopied((current) => (current === field ? null : current)), 2000);
    } catch {
      // Clipboard access can be denied; the value stays selectable on screen.
    }
  }, []);

  if (!setup) {
    return (
      <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
        {t("metaApiWebhookUnavailable")}
      </div>
    );
  }

  const rows = [
    { key: "callbackUrl", label: t("metaApiCallbackUrl"), value: setup.callbackUrl },
    { key: "verifyToken", label: t("metaApiVerifyToken"), value: setup.verifyToken },
  ];

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div>
        <p className="text-sm font-medium">{t("metaApiWebhookTitle")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("metaApiWebhookHint")}</p>
      </div>
      {rows.map((row) => (
        <div key={row.key} className="space-y-1">
          <p className="text-xs text-muted-foreground">{row.label}</p>
          <div className="flex items-center gap-2">
            <code
              dir="ltr"
              className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-background px-3 py-2 text-xs whitespace-nowrap"
            >
              {row.value}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void copy(row.key, row.value)}
              aria-label={`${t("metaApiCopy")} — ${row.label}`}
            >
              {copied === row.key ? (
                <Check className="size-4" aria-hidden />
              ) : (
                <Copy className="size-4" aria-hidden />
              )}
              {copied === row.key ? t("metaApiCopied") : t("metaApiCopy")}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
