"use client";

import { useState, useTransition } from "react";
import { Bot } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { setPatientAiReplyMode } from "@/actions/patient-ai";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

type Props = {
  /** `clinics.ai_reply_mode` as stored. `off` is the switch being off. */
  mode: "off" | "suggest" | "auto";
  canManage: boolean;
  /** How many conversations currently carry an explicit exception. */
  exceptionCount: number;
};

/**
 * P15 (§3) — the clinic-wide WhatsApp AI reply switch, where WhatsApp lives.
 *
 * ### Why it is here as well as in Patient AI settings
 *
 * The question "is the assistant answering our WhatsApp right now?" is asked in
 * the middle of a WhatsApp problem, by whoever is looking at the WhatsApp
 * connection — and until now the answer lived on a different settings page
 * under a three-position mode selector. This is the same stored value
 * (`clinics.ai_reply_mode`) through the same entitlement-gated action, shown as
 * the one thing staff actually want at that moment: on or off, everywhere.
 *
 * ### Why turning it back on restores `auto` rather than `suggest`
 *
 * Off is a *pause*, and the thing being paused is whatever the clinic had.
 * There is nowhere to remember the previous position, so the switch restores
 * the strongest mode the clinic's entitlements allow and the server downgrades
 * it — a clinic without `ai.patient_auto` lands on `suggest`, which is exactly
 * where the mode selector would have put them. The Patient AI settings page
 * remains the place to choose between drafting and sending.
 *
 * ### The relationship to per-conversation exceptions, stated
 *
 * This switch is the default, not the whole answer. Individual conversations
 * can be excluded while it is on and admitted while it is off, from the Inbox.
 * The count of those exceptions is shown here rather than hidden, because a
 * clinic that turns the assistant off everywhere and still sees replies going
 * out deserves to be told why on the same screen.
 */
export function WhatsAppAiRepliesCard({ mode, canManage, exceptionCount }: Props) {
  const t = useTranslations("settings");
  const [enabled, setEnabled] = useState(mode !== "off");
  const [pending, startTransition] = useTransition();

  function onToggle(next: boolean) {
    const previous = enabled;
    setEnabled(next);
    startTransition(async () => {
      const result = await setPatientAiReplyMode({ mode: next ? "auto" : "off" });
      if (result.error) {
        setEnabled(previous);
        toast.error(result.error);
        return;
      }
      toast.success(
        next ? t("whatsappAiRepliesOnToast") : t("whatsappAiRepliesOffToast"),
      );
    });
  }

  return (
    <Card className="max-w-3xl">
      <CardHeader className="border-b">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Bot className="size-5" aria-hidden />
          </span>
          <div className="space-y-1">
            <CardTitle>{t("whatsappAiRepliesTitle")}</CardTitle>
            <CardDescription>{t("whatsappAiRepliesDescription")}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t("whatsappAiRepliesToggleLabel")}</p>
            <p className="text-sm text-muted-foreground">
              {enabled
                ? t("whatsappAiRepliesOnHint")
                : t("whatsappAiRepliesOffHint")}
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={onToggle}
            disabled={!canManage || pending}
            aria-label={t("whatsappAiRepliesToggleLabel")}
          />
        </div>
        {exceptionCount > 0 ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
            {t("whatsappAiRepliesExceptions", { count: exceptionCount })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
