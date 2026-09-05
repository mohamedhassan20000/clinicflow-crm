"use client";

import { useCallback, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  MessageCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  completeMetaOnboarding,
  refreshMetaConnectionState,
} from "@/actions/messaging-onboarding";
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
import type { MetaChannelState } from "@/lib/messaging/channel-management";
import { META_SDK_VERSION } from "@/lib/messaging/meta-sdk";
import type {
  ConnectionFailureReason,
  ConnectionState,
} from "@/lib/messaging/connection-state";

type ClinicInfo = {
  name: string | null;
  phone: string | null;
  address: string | null;
};

type MetaConfig = { appId: string; configId: string } | null;

type Props = {
  initialState: MetaChannelState;
  clinic: ClinicInfo;
  canManage: boolean;
  entitled: boolean;
  metaConfig: MetaConfig;
};

const CONNECTION_STATES = [
  "connecting_to_meta",
  "waiting_phone_verification",
  "business_verification_in_progress",
  "templates_pending",
  "connected",
] as const;

type EmbeddedSignupResult = {
  code: string;
  phoneNumberId: string;
  wabaId: string;
};

type FacebookLogin = (
  callback: (response: unknown) => void,
  options: Record<string, unknown>,
) => void;

const CONNECTION_STATE_KEYS = {
  not_started: "connectionState.not_started",
  connecting_to_meta: "connectionState.connecting_to_meta",
  waiting_phone_verification: "connectionState.waiting_phone_verification",
  business_verification_in_progress: "connectionState.business_verification_in_progress",
  templates_pending: "connectionState.templates_pending",
  connected: "connectionState.connected",
  verification_failed: "connectionState.verification_failed",
} as const satisfies Record<ConnectionState | "not_started", string>;

const CONNECTION_REASON_KEYS = {
  business_verification_rejected: "connectionReason.business_verification_rejected",
  business_verification_expired: "connectionReason.business_verification_expired",
  phone_number_banned: "connectionReason.phone_number_banned",
  phone_number_restricted: "connectionReason.phone_number_restricted",
  account_restricted: "connectionReason.account_restricted",
  account_disabled: "connectionReason.account_disabled",
  generic: "connectionReason.generic",
} as const satisfies Record<ConnectionFailureReason, string>;

function hasOwnKey<T extends object>(object: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * P6C in-product onboarding wizard (plan line 1309). Four steps on the existing
 * /settings/messaging surface. Step 1 confirms clinic info; steps 2–3 are the
 * Meta-hosted Embedded Signup popup (the irreducible off-product moment — we frame
 * it, detect completion/abandonment, and never proxy or store Meta credentials);
 * step 4 shows the confirmed, honestly-labeled connection state. No review-time
 * estimate is ever shown — only decision states and the last-checked time.
 */
export function WhatsAppOnboardingWizard({
  initialState,
  clinic,
  canManage,
  entitled,
  metaConfig,
}: Props) {
  const t = useTranslations("settings");
  const format = useFormatter();
  const [state, setState] = useState<MetaChannelState>(initialState);
  const [step, setStep] = useState<1 | 2 | 4>(initialState.configured ? 4 : 1);
  const [busy, setBusy] = useState(false);
  const sdkReady = useRef(false);

  const badgeVariant =
    state.connectionState === "connected"
      ? "default"
      : state.connectionState === "verification_failed"
        ? "destructive"
        : "outline";
  const stateKey =
    state.connectionState && hasOwnKey(CONNECTION_STATE_KEYS, state.connectionState)
      ? state.connectionState
      : "not_started";
  const reasonKey =
    state.reason && hasOwnKey(CONNECTION_REASON_KEYS, state.reason)
      ? state.reason
      : "generic";

  const loadSdk = useCallback(async () => {
    if (sdkReady.current || typeof window === "undefined" || !metaConfig) return;
    await new Promise<void>((resolve) => {
      const w = window as unknown as { FB?: unknown; fbAsyncInit?: () => void };
      if (w.FB) {
        sdkReady.current = true;
        resolve();
        return;
      }
      w.fbAsyncInit = () => {
        (w.FB as { init: (o: Record<string, unknown>) => void }).init({
          appId: metaConfig.appId,
          autoLogAppEvents: true,
          xfbml: false,
          // Shared with the Coexistence card — FB.init is page-global.
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
  }, [metaConfig]);

  const submitCompletion = useCallback(
    async (result: EmbeddedSignupResult) => {
      const outcome = await completeMetaOnboarding(result);
      setBusy(false);
      if (outcome.error) {
        setStep(1);
        toast.error(outcome.error);
        return;
      }
      if (outcome.state) setState(outcome.state);
      setStep(4);
      toast.success(t("metaConnectionSaved"));
    },
    [t],
  );

  const launchEmbeddedSignup = useCallback(async () => {
    if (!metaConfig) return;
    setBusy(true);
    setStep(2);
    await loadSdk();
    const w = window as unknown as {
      FB?: { login: FacebookLogin };
    };
    if (!w.FB) {
      setBusy(false);
      setStep(1);
      toast.error(t("metaSignupUnavailable"));
      return;
    }

    // Meta posts session info (phone_number_id, waba_id) via the message channel;
    // FB.login returns the authorization code. Both are required to complete.
    const session: { phoneNumberId?: string; wabaId?: string } = {};
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== "https://www.facebook.com" && event.origin !== "https://web.facebook.com") {
        return;
      }
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data?.type === "WA_EMBEDDED_SIGNUP" && data?.data) {
          session.phoneNumberId = data.data.phone_number_id;
          session.wabaId = data.data.waba_id;
        }
      } catch {
        // Non-JSON messages from the popup are ignored.
      }
    };
    window.addEventListener("message", onMessage);

    w.FB.login(
      (response: unknown) => {
        window.removeEventListener("message", onMessage);
        const authResponse = (response as { authResponse?: { code?: string } })?.authResponse;
        const code = authResponse?.code;
        if (!code || !session.phoneNumberId || !session.wabaId) {
          // Abandonment / denial: leave the channel resumable, honestly labeled.
          setBusy(false);
          setStep(state.configured ? 4 : 1);
          toast.message(t("metaSignupIncomplete"));
          return;
        }
        void submitCompletion({
          code,
          phoneNumberId: session.phoneNumberId,
          wabaId: session.wabaId,
        });
      },
      {
        config_id: metaConfig.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {} },
      },
    );
  }, [metaConfig, loadSdk, state.configured, t, submitCompletion]);

  const refresh = useCallback(async () => {
    setBusy(true);
    const outcome = await refreshMetaConnectionState();
    setBusy(false);
    if (outcome.error) {
      toast.error(outcome.error);
      return;
    }
    if (outcome.state) setState(outcome.state);
  }, []);

  return (
    <Card className="max-w-3xl">
      <CardHeader className="border-b">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
            <MessageCircle className="size-5" aria-hidden />
          </span>
          <div>
            <CardTitle>{t("metaConnectionTitle")}</CardTitle>
            <CardDescription>{t("metaConnectionDescription")}</CardDescription>
          </div>
        </div>
        <CardAction>
          <Badge variant={badgeVariant}>{t(CONNECTION_STATE_KEYS[stateKey])}</Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-6">
        {!entitled ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-800 dark:text-amber-300">
            {t("whatsAppNotIncluded")}
          </div>
        ) : !metaConfig ? (
          <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
            {t("metaNotConfigured")}
          </div>
        ) : null}

        {/* Progress rail — decision states only, never a review-time estimate. */}
        <ol className="grid gap-2 sm:grid-cols-5">
          {CONNECTION_STATES.map((s) => {
            const reachedIndex = state.connectionState
              ? CONNECTION_STATES.indexOf(state.connectionState as (typeof CONNECTION_STATES)[number])
              : -1;
            const index = CONNECTION_STATES.indexOf(s);
            const done = reachedIndex >= index && reachedIndex !== -1;
            return (
              <li
                key={s}
                className={`rounded-md border px-2 py-1.5 text-xs ${
                  done ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"
                }`}
              >
                {t(CONNECTION_STATE_KEYS[s])}
              </li>
            );
          })}
        </ol>

        {state.connectionState === "verification_failed" ? (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{t(CONNECTION_REASON_KEYS[reasonKey])}</span>
          </div>
        ) : null}

        {/* Step 1 — confirm clinic information (prefilled). */}
        {step === 1 && entitled ? (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
            <p className="text-sm font-medium">{t("metaStep1Title")}</p>
            <dl className="grid gap-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted-foreground">{t("clinicNameLabel")}</dt>
                <dd className="mt-0.5 font-medium">{clinic.name ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("connectedNumber")}</dt>
                <dd className="mt-0.5 font-medium" dir="ltr">{clinic.phone ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("clinicAddressLabel")}</dt>
                <dd className="mt-0.5 font-medium">{clinic.address ?? "—"}</dd>
              </div>
            </dl>
            <p className="text-xs text-muted-foreground">{t("metaStep1Hint")}</p>
          </div>
        ) : null}

        {/* Step 4 — confirmed connection details, provider-aware. */}
        {step === 4 && state.configured ? (
          <div className="grid gap-3 rounded-lg border bg-muted/30 p-4 sm:grid-cols-2">
            <Detail label={t("connectedNumber")} value={state.displayPhoneNumber} dir="ltr" />
            <Detail
              label={t("lastSyncedLabel")}
              value={
                state.lastSyncedAt
                  ? format.dateTime(new Date(state.lastSyncedAt), { dateStyle: "medium", timeStyle: "short" })
                  : "—"
              }
            />
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          {entitled && metaConfig && canManage ? (
            step === 4 && state.connectionState === "connected" ? (
              <Button variant="outline" onClick={refresh} disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
                {t("refreshStatus")}
              </Button>
            ) : (
              <>
                <Button onClick={launchEmbeddedSignup} disabled={busy}>
                  {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ExternalLink className="size-4 rtl:-scale-x-100" aria-hidden />}
                  {state.configured ? t("metaReconnect") : t("connectViaMeta")}
                </Button>
                {state.configured ? (
                  <Button variant="outline" onClick={refresh} disabled={busy}>
                    <RefreshCw className="size-4" aria-hidden />
                    {t("refreshStatus")}
                  </Button>
                ) : null}
              </>
            )
          ) : null}
          {!canManage ? (
            <p className="text-sm text-muted-foreground">{t("managerConnectionReadOnly")}</p>
          ) : null}
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-4" aria-hidden />
            {t("metaCredentialSecurityHint")}
          </span>
        </div>

        {state.connectionState === "connected" ? (
          <p className="inline-flex items-center gap-1.5 text-sm text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="size-4" aria-hidden />
            {t("metaConnectedNote")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Detail({ label, value, dir }: { label: string; value: string | null; dir?: "ltr" }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-medium" dir={dir}>
        {value ?? "—"}
      </p>
    </div>
  );
}
