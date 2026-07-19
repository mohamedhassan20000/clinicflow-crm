"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { BrainCircuit, KeyRound, Loader2, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  revokeAiProviderCredential,
  saveAiProviderCredential,
  setAiProviderMode,
  testAiProviderCredential,
  type AiProviderActionResult,
} from "@/actions/ai-provider";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AiProviderSettings } from "@/lib/ai/platform/provider-connections";
import type { AiCredentialMode } from "@/lib/ai/platform/types";
import { cn } from "@/lib/utils";

type Action = (
  previous: AiProviderActionResult | null,
  formData: FormData,
) => Promise<AiProviderActionResult>;

const MODES: readonly AiCredentialMode[] = ["managed", "byok_strict", "hybrid"];
const MODE_COPY_KEYS = {
  managed: { title: "aiMode_managed", description: "aiMode_managed_description" },
  byok_strict: { title: "aiMode_byok_strict", description: "aiMode_byok_strict_description" },
  hybrid: { title: "aiMode_hybrid", description: "aiMode_hybrid_description" },
} as const;
const HEALTH_COPY_KEYS = {
  valid: "aiHealth_valid",
  invalid: "aiHealth_invalid",
  insufficient_scope: "aiHealth_insufficient_scope",
  quota: "aiHealth_quota",
  provider_unavailable: "aiHealth_provider_unavailable",
} as const;

function ActionError({ message }: { message?: string }) {
  return message ? (
    <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
      {message}
    </div>
  ) : null;
}

export function AiProviderSettingsPanel({
  settings,
  modeEntitlements,
}: {
  settings: AiProviderSettings;
  modeEntitlements: Record<AiCredentialMode, boolean>;
}) {
  const t = useTranslations("settings");
  const format = useFormatter();
  const [modeSelection, setModeSelection] = useState<AiCredentialMode | null>(null);
  const [hybridAccepted, setHybridAccepted] = useState(false);
  const credentialForm = useRef<HTMLFormElement>(null);
  const [credentialState, credentialAction, credentialPending] = useActionState(
    saveAiProviderCredential as Action,
    null,
  );
  const [testState, testAction, testPending] = useActionState(
    testAiProviderCredential as Action,
    null,
  );
  const [modeState, modeAction, modePending] = useActionState(
    setAiProviderMode as Action,
    null,
  );
  const [revokeState, revokeAction, revokePending] = useActionState(
    revokeAiProviderCredential as Action,
    null,
  );

  useEffect(() => {
    if (!credentialState?.success) return;
    credentialForm.current?.reset();
    toast.success(t(
      credentialState.operation === "rotated"
        ? "aiCredentialRotated"
        : "aiCredentialConnected",
    ));
  }, [credentialState, t]);
  useEffect(() => {
    if (testState?.success) toast.success(t("aiCredentialValid"));
  }, [testState, t]);
  useEffect(() => {
    if (modeState?.success) toast.success(t("aiProviderModeSaved"));
  }, [modeState, t]);
  useEffect(() => {
    if (!revokeState?.success) return;
    toast.success(t("aiCredentialRevoked"));
  }, [revokeState, t]);

  const connection = settings.connection;
  const healthyConnection = connection?.healthStatus === "valid";
  const selectedMode = connection ? (modeSelection ?? settings.mode) : "managed";

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)]">
      <div className="space-y-6">
        <Card>
          <CardHeader className="border-b">
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <BrainCircuit className="size-5" aria-hidden />
              </span>
              <div>
                <CardTitle>{t("aiProviderModeTitle")}</CardTitle>
                <CardDescription>{t("aiProviderModeDescription")}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <form action={modeAction} className="space-y-5">
              <ActionError message={modeState?.error} />
              <fieldset className="space-y-3">
                <legend className="text-sm font-medium">{t("aiProviderModeLegend")}</legend>
                {MODES.map((mode) => {
                  const copy = MODE_COPY_KEYS[mode];
                  const requiresCredential = mode !== "managed";
                  const entitled = modeEntitlements[mode];
                  const disabled = !entitled || (requiresCredential && !healthyConnection);
                  return (
                    <label
                      key={mode}
                      className={cn(
                        "flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors",
                        selectedMode === mode ? "border-primary bg-primary/5" : "border-border/70",
                        disabled && "cursor-not-allowed opacity-55",
                      )}
                    >
                      <input
                        type="radio"
                        name="mode"
                        value={mode}
                        checked={selectedMode === mode}
                        onChange={() => setModeSelection(mode)}
                        disabled={disabled || modePending}
                        className="mt-1 size-4 accent-primary"
                      />
                      <span>
                        <span className="block text-sm font-medium">{t(copy.title)}</span>
                        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                          {t(copy.description)}
                        </span>
                        {!entitled ? (
                          <span className="mt-2 block text-xs font-medium text-amber-700 dark:text-amber-400">
                            {t("aiModeNotIncluded")}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
              </fieldset>

              {selectedMode === "hybrid" ? (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id="hybridAccepted"
                      name="hybridAccepted"
                      checked={hybridAccepted}
                      onCheckedChange={(value) => setHybridAccepted(value === true)}
                      disabled={modePending}
                    />
                    <Label htmlFor="hybridAccepted" className="text-sm font-normal leading-5">
                      {t("aiHybridDisclosure")}
                    </Label>
                  </div>
                </div>
              ) : null}

              <div className="space-y-2">
                <Label htmlFor="ai-mode-current-password">{t("currentPassword")}</Label>
                <Input
                  id="ai-mode-current-password"
                  name="currentPassword"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={1024}
                  disabled={modePending}
                />
                <p className="text-xs text-muted-foreground">{t("aiSensitiveChangeReauth")}</p>
              </div>
              <div className="flex justify-end">
                <Button
                  type="submit"
                  disabled={
                    modePending ||
                    !modeEntitlements[selectedMode] ||
                    (selectedMode === "hybrid" && !hybridAccepted)
                  }
                >
                  {modePending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                  {t("saveProviderMode")}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b">
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-violet-500/10 text-violet-700 dark:text-violet-300">
                <KeyRound className="size-5" aria-hidden />
              </span>
              <div>
                <CardTitle>{connection ? t("rotateAiCredential") : t("connectAiCredential")}</CardTitle>
                <CardDescription>{t("aiCredentialOneWayDescription")}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <form ref={credentialForm} action={credentialAction} className="space-y-4">
              <ActionError message={credentialState?.error} />
              <div className="space-y-2">
                <Label htmlFor="anthropic-api-key">{t("anthropicApiKey")}</Label>
                <Input
                  id="anthropic-api-key"
                  name="apiKey"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={20}
                  maxLength={512}
                  dir="ltr"
                  disabled={credentialPending}
                />
                <p className="text-xs text-muted-foreground">{t("anthropicApiKeyHelp")}</p>
              </div>
              {connection ? (
                <div className="space-y-2">
                  <Label htmlFor="ai-key-current-password">{t("currentPassword")}</Label>
                  <Input
                    id="ai-key-current-password"
                    name="currentPassword"
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={1024}
                    disabled={credentialPending}
                  />
                </div>
              ) : null}
              <div className="flex justify-end">
                <Button type="submit" disabled={credentialPending}>
                  {credentialPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                  {connection ? t("validateAndRotate") : t("validateAndConnect")}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>

      <Card className="h-fit">
        <CardHeader className="border-b">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>{t("aiConnectionStatusTitle")}</CardTitle>
              <CardDescription>{t("aiConnectionStatusDescription")}</CardDescription>
            </div>
            <Badge variant={healthyConnection ? "default" : "outline"}>
              {connection ? t(HEALTH_COPY_KEYS[connection.healthStatus]) : t("statusNotConnected")}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {connection ? (
            <>
              <dl className="grid gap-4 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">{t("aiProvider")}</dt>
                  <dd className="mt-1 font-medium">{t("aiProviderAnthropic")}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t("aiCredentialFingerprint")}</dt>
                  <dd className="mt-1 font-mono text-xs" dir="ltr">{connection.maskedFingerprint}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t("aiCredentialActivatedAt")}</dt>
                  <dd className="mt-1">{format.dateTime(new Date(connection.activatedAt), { dateStyle: "medium", timeStyle: "short" })}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t("aiCredentialLastTestedAt")}</dt>
                  <dd className="mt-1">{format.dateTime(new Date(connection.testedAt), { dateStyle: "medium", timeStyle: "short" })}</dd>
                </div>
              </dl>

              <div className="rounded-lg border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
                <ShieldCheck className="me-1 inline size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
                {t("aiCredentialNeverDisplayed")}
              </div>
              <ActionError message={testState?.error} />
              <form action={testAction}>
                <Button type="submit" variant="outline" className="w-full" disabled={testPending}>
                  {testPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
                  {t("testAiCredential")}
                </Button>
              </form>

              <ActionError message={revokeState?.error} />
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" className="w-full">
                    <Trash2 className="size-4" aria-hidden />
                    {t("revokeAiCredential")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <form action={revokeAction} className="contents">
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("revokeAiCredentialTitle")}</AlertDialogTitle>
                      <AlertDialogDescription>{t("revokeAiCredentialDescription")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="space-y-2">
                      <Label htmlFor="ai-revoke-current-password">{t("currentPassword")}</Label>
                      <Input
                        id="ai-revoke-current-password"
                        name="currentPassword"
                        type="password"
                        autoComplete="current-password"
                        required
                        maxLength={1024}
                        disabled={revokePending}
                      />
                    </div>
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={revokePending}>{t("cancel")}</AlertDialogCancel>
                      <AlertDialogAction type="submit" variant="destructive" disabled={revokePending}>
                        {revokePending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                        {t("revoke")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </form>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : (
            <p className="text-sm leading-6 text-muted-foreground">{t("aiNoCredentialDescription")}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
