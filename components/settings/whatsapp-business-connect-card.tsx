"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  MessageCircle,
  QrCode,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import Link from "next/link";
import {
  connectWhatsAppBusinessAccount,
  readWhatsAppBusinessConnection,
} from "@/actions/messaging-onboarding";
import type { WhatsAppBusinessConnectionView } from "@/lib/messaging/connection-view";
import { META_SDK_VERSION } from "@/lib/messaging/meta-sdk";
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
import { DisconnectWhatsAppButton } from "@/components/settings/disconnect-whatsapp-button";

type Props = {
  initialConnection: WhatsAppBusinessConnectionView;
  canManage: boolean;
  entitled: boolean;
  /** Public Embedded Signup ids, or null when Coexistence onboarding is off. */
  signupConfig: { appId: string; configId: string } | null;
};

/**
 * The visible phases of the flow. Deliberately fewer than the internal
 * connection-state machine: the clinic sees Connect → confirm with Meta →
 * Verifying → Connected, and nothing about WABAs, tokens, or webhooks.
 * `awaiting_meta` is the "Connecting" beat — Meta's own popup is open.
 */
type Phase = "idle" | "awaiting_meta" | "verifying" | "connected" | "failed";

/** How long to keep re-checking before telling the clinic it is still verifying. */
const VERIFY_POLL_ATTEMPTS = 10;
const VERIFY_POLL_INTERVAL_MS = 3000;

type SignupSession = { phoneNumberId?: string; wabaId?: string };

type FacebookLogin = (
  callback: (response: unknown) => void,
  options: Record<string, unknown>,
) => void;

/**
 * Meta's Embedded Signup popup posts its session events from whichever
 * facebook.com host served the flow — `www.`, `business.`, or a locale host such
 * as `es-la.` — so pinning two exact hosts silently drops the Coexistence
 * completion event and the connection never starts. Meta's own sample checks
 * `endsWith("facebook.com")`; we require https and a real dot-boundary
 * subdomain so a look-alike host like `evilfacebook.com` cannot match.
 */
function isMetaOrigin(origin: string): boolean {
  let host: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return false;
    host = url.hostname;
  } catch {
    return false;
  }
  return host === "facebook.com" || host.endsWith(".facebook.com");
}

/**
 * P7C — "Connect WhatsApp Business" (Meta Embedded Signup v4, WhatsApp Business
 * App Coexistence).
 *
 * This is the simple path, offered alongside the unchanged manual/API setup
 * below it: the clinic keeps using WhatsApp on their phone exactly as before,
 * and the same number is mirrored into ClinicFlow.
 *
 * Meta hosts the confirmation itself — it renders the pairing QR/code inside its
 * own popup for the clinic to confirm from their WhatsApp Business app, and does
 * not hand that code to us. So this card frames that moment rather than
 * reproducing it: it explains what to expect, tracks whether the popup was
 * completed or abandoned, and then shows verification progress. No unofficial
 * WhatsApp Web session/QR library is involved anywhere.
 *
 * Everything the browser receives from Meta is treated as an unverified claim.
 * "Connected" is shown only after the server has independently verified the
 * account with Meta and stored the channel.
 */
export function WhatsAppBusinessConnectCard({
  initialConnection,
  canManage,
  entitled,
  signupConfig,
}: Props) {
  const t = useTranslations("settings");
  const format = useFormatter();
  const [connection, setConnection] =
    useState<WhatsAppBusinessConnectionView>(initialConnection);
  const [phase, setPhase] = useState<Phase>(() => {
    // A channel owned by the Meta API method is not this card's state to show.
    if (initialConnection.mode !== null && initialConnection.mode !== "coexistence") {
      return "idle";
    }
    if (initialConnection.status === "connected") return "connected";
    if (initialConnection.status === "failed") return "failed";
    return initialConnection.status === "verifying" ? "verifying" : "idle";
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const sdkReady = useRef(false);
  const mounted = useRef(true);

  // The clinic has exactly one WhatsApp channel. When the Meta API method owns
  // it, this card explains that rather than offering a competing Connect button
  // that could only fail.
  const ownedElsewhere =
    connection.mode !== null && connection.mode !== "coexistence";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadSdk = useCallback(async () => {
    if (sdkReady.current || typeof window === "undefined" || !signupConfig) return;
    await new Promise<void>((resolve) => {
      const w = window as unknown as { FB?: unknown; fbAsyncInit?: () => void };
      if (w.FB) {
        sdkReady.current = true;
        resolve();
        return;
      }
      w.fbAsyncInit = () => {
        (w.FB as { init: (o: Record<string, unknown>) => void }).init({
          appId: signupConfig.appId,
          autoLogAppEvents: true,
          xfbml: false,
          // Coexistence (`whatsapp_business_app_onboarding`) is only offered
          // from v23.0 onward; older versions fall back to standard signup.
          version: META_SDK_VERSION,
        });
        sdkReady.current = true;
        resolve();
      };
      const script = document.createElement("script");
      script.src = "https://connect.facebook.net/en_US/sdk.js";
      script.async = true;
      script.crossOrigin = "anonymous";
      script.onerror = () => resolve();
      document.body.appendChild(script);
    });
  }, [signupConfig]);

  /**
   * Meta may still be propagating the number when the popup closes, so the
   * verifying step re-checks for a bounded period. Timing out is not a failure:
   * the channel exists and the background reconciliation continues, so the card
   * keeps saying "verifying" rather than claiming either outcome.
   */
  const pollUntilSettled = useCallback(async () => {
    for (let attempt = 0; attempt < VERIFY_POLL_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, VERIFY_POLL_INTERVAL_MS));
      if (!mounted.current) return;
      const next = await readWhatsAppBusinessConnection().catch(() => null);
      if (!mounted.current || !next) continue;
      setConnection(next);
      if (next.status === "connected") {
        setPhase("connected");
        return;
      }
      if (next.status === "failed") {
        setPhase("failed");
        return;
      }
    }
  }, []);

  const submit = useCallback(
    async (session: Required<SignupSession> & { code: string }) => {
      setPhase("verifying");
      const outcome = await connectWhatsAppBusinessAccount(session).catch(() => null);
      if (!mounted.current) return;
      if (!outcome || outcome.error || !outcome.connection) {
        setPhase("failed");
        return;
      }
      setConnection(outcome.connection);
      if (outcome.connection.status === "connected") {
        setPhase("connected");
        return;
      }
      if (outcome.connection.status === "failed") {
        setPhase("failed");
        return;
      }
      void pollUntilSettled();
    },
    [pollUntilSettled],
  );

  const start = useCallback(async () => {
    if (!signupConfig) return;
    setDialogOpen(true);
    setPhase("awaiting_meta");
    await loadSdk();
    const w = window as unknown as { FB?: { login: FacebookLogin } };
    if (!w.FB) {
      setPhase("failed");
      return;
    }

    // Meta posts the selected assets over postMessage; FB.login returns the
    // authorization code. Both halves are required, and only the Coexistence
    // completion event is accepted — a standard Cloud API signup completing here
    // must not be stored as a Coexistence channel.
    const session: SignupSession = {};
    let coexistenceCompleted = false;
    const onMessage = (event: MessageEvent) => {
      if (!isMetaOrigin(event.origin)) return;
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data?.type !== "WA_EMBEDDED_SIGNUP" || !data?.data) return;
        if (data.data.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING") {
          coexistenceCompleted = true;
        }
        if (data.data.phone_number_id) session.phoneNumberId = data.data.phone_number_id;
        if (data.data.waba_id) session.wabaId = data.data.waba_id;
      } catch {
        // Non-JSON messages from the popup are ignored.
      }
    };
    window.addEventListener("message", onMessage);

    w.FB.login(
      (response: unknown) => {
        window.removeEventListener("message", onMessage);
        const code = (response as { authResponse?: { code?: string } })?.authResponse?.code;
        if (!code || !coexistenceCompleted || !session.phoneNumberId || !session.wabaId) {
          // Abandoned, denied, or a non-Coexistence completion. Nothing was
          // stored, so the clinic can simply start again.
          setPhase(connection.status === "connected" ? "connected" : "idle");
          setDialogOpen(false);
          return;
        }
        void submit({
          code,
          phoneNumberId: session.phoneNumberId,
          wabaId: session.wabaId,
        });
      },
      {
        config_id: signupConfig.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: {
          setup: {},
          // Embedded Signup v4 Coexistence: Meta shows the WhatsApp Business app
          // pairing step instead of creating a new Cloud API number.
          featureType: "whatsapp_business_app_onboarding",
          // Session logging v3 is mandatory for Coexistence — it is what makes
          // Meta emit FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING with the asset
          // ids. Meta specifies it as a string; a number is not accepted.
          sessionInfoVersion: "3",
        },
      },
    );
  }, [signupConfig, loadSdk, submit, connection.status]);

  const connected = phase === "connected";
  const busy = phase === "awaiting_meta" || phase === "verifying";

  // Five explicit states, matching the flow the clinic actually experiences:
  // Not connected → Connecting (Meta's popup) → Verifying → Connected / Error.
  const badge = connected
    ? { label: t("waConnConnected"), variant: "default" as const }
    : phase === "awaiting_meta"
      ? { label: t("waConnConnecting"), variant: "outline" as const }
      : phase === "verifying"
        ? { label: t("waConnVerifying"), variant: "outline" as const }
        : phase === "failed"
          ? { label: t("waConnError"), variant: "destructive" as const }
          : { label: t("waConnNotConnected"), variant: "outline" as const };

  return (
    <>
      <Card className="max-w-3xl" data-testid="whatsapp-qr-card">
        <CardHeader className="border-b">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
              <Smartphone className="size-5" aria-hidden />
            </span>
            <div>
              <CardTitle>{t("waBusinessTitle")}</CardTitle>
              <CardDescription>{t("waBusinessDescription")}</CardDescription>
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
              {t("waBusinessOwnedByMetaApi")}
            </div>
          ) : !signupConfig ? (
            <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
              {t("waBusinessUnavailable")}
            </div>
          ) : null}

          {phase === "failed" && !ownedElsewhere ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
            >
              {t("waBusinessFailedNote")}
            </div>
          ) : null}

          {connected ? (
            <div className="grid gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 sm:grid-cols-2">
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
          ) : ownedElsewhere ? null : (
            <ul className="grid gap-2 text-sm text-muted-foreground">
              <li className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
                {t("waBusinessBenefitKeepNumber")}
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
                {t("waBusinessBenefitKeepPhone")}
              </li>
              <li className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
                {t("waBusinessBenefitInbox")}
              </li>
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {entitled && signupConfig && canManage && !ownedElsewhere ? (
              connected ? (
                <>
                  <Button asChild>
                    <Link href="/inbox">
                      <MessageCircle className="size-4" aria-hidden />
                      {t("waBusinessOpenInbox")}
                    </Link>
                  </Button>
                  <DisconnectWhatsAppButton
                    label={t("waBusinessDisconnect")}
                    onDisconnected={(next) => {
                      setConnection(next);
                      setPhase("idle");
                    }}
                  />
                </>
              ) : (
                <Button onClick={start} disabled={busy}>
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <QrCode className="size-4" aria-hidden />
                  )}
                  {phase === "failed" ? t("waBusinessTryAgain") : t("waBusinessConnect")}
                </Button>
              )
            ) : null}
            {!canManage ? (
              <p className="text-sm text-muted-foreground">{t("managerConnectionReadOnly")}</p>
            ) : null}
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="size-4" aria-hidden />
              {t("waBusinessSecurityHint")}
            </span>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={dialogOpen}
        onOpenChange={(next) => {
          // Never cancel an in-flight server verification by closing the dialog;
          // the clinic can dismiss it once the outcome is known.
          if (!next && phase === "verifying") return;
          setDialogOpen(next);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {phase === "connected"
                ? t("waBusinessDialogConnectedTitle")
                : phase === "failed"
                  ? t("waBusinessDialogFailedTitle")
                  : phase === "verifying"
                    ? t("waBusinessDialogVerifyingTitle")
                    : t("waBusinessDialogConfirmTitle")}
            </DialogTitle>
            <DialogDescription>
              {phase === "connected"
                ? t("waBusinessDialogConnectedBody")
                : phase === "failed"
                  ? t("waBusinessDialogFailedBody")
                  : phase === "verifying"
                    ? t("waBusinessDialogVerifyingBody")
                    : t("waBusinessDialogConfirmBody")}
            </DialogDescription>
          </DialogHeader>

          <FlowSteps phase={phase} />

          <div className="flex justify-end gap-2">
            {phase === "failed" ? (
              <>
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  {t("waBusinessClose")}
                </Button>
                <Button onClick={start}>{t("waBusinessTryAgain")}</Button>
              </>
            ) : phase === "connected" ? (
              <>
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  {t("waBusinessClose")}
                </Button>
                <Button asChild>
                  <Link href="/inbox">{t("waBusinessOpenInbox")}</Link>
                </Button>
              </>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The three-beat progress the clinic actually experiences. The middle beat
 * covers Meta's own confirmation screen, where the pairing QR/code is shown and
 * scanned from the WhatsApp Business app.
 */
function FlowSteps({ phase }: { phase: Phase }) {
  const t = useTranslations("settings");
  const steps = [
    { key: "confirm", label: t("waBusinessStepConfirm"), icon: QrCode },
    { key: "verify", label: t("waBusinessStepVerify"), icon: ShieldCheck },
    { key: "done", label: t("waBusinessStepDone"), icon: CheckCircle2 },
  ] as const;
  const activeIndex =
    phase === "connected" ? 2 : phase === "verifying" ? 1 : phase === "failed" ? -1 : 0;

  return (
    <ol className="grid gap-2" aria-live="polite">
      {steps.map((step, index) => {
        const done = activeIndex > index;
        const active = activeIndex === index;
        const Icon = step.icon;
        return (
          <li
            key={step.key}
            className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
              done || (active && phase === "connected")
                ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                : active
                  ? "border-primary/40 bg-primary/5 font-medium"
                  : "text-muted-foreground"
            }`}
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-background/70">
              {active && phase !== "connected" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Icon className="size-4" aria-hidden />
              )}
            </span>
            {step.label}
          </li>
        );
      })}
    </ol>
  );
}
