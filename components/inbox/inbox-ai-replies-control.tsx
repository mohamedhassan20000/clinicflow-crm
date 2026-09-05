"use client";

import { useState, useTransition } from "react";
import { Bot, BotOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { setPatientAiReplyMode } from "@/actions/patient-ai";
import { Switch } from "@/components/ui/switch";
import type { ClinicAiReplyMode } from "@/lib/ai/patient-reply-mode";

type Props = {
  /** `clinics.ai_reply_mode` as stored. `off` is the switch being off. */
  mode: ClinicAiReplyMode;
  /** Conversations carrying an explicit `ai_enabled_override`, clinic-wide. */
  overrideCount: number;
  /** Whether this viewer may change it — the same admin gate the action enforces. */
  canManage: boolean;
};

/**
 * P17 (§7) — the clinic-wide WhatsApp AI reply switch, in the Inbox header.
 *
 * ### One setting, three views
 *
 * "Is the assistant answering our WhatsApp right now?" is asked while staring
 * at the Inbox, and until now the answer was two pages away. This is the *same*
 * stored value (`clinics.ai_reply_mode`) through the *same* server action
 * (`setPatientAiReplyMode`) as the Settings → Messaging card and the Patient AI
 * mode selector. There is deliberately no new column, no new action, no new
 * boolean and no client-side notion of "on": what the header shows is what
 * `resolveEffectiveConversationAi` and `patient-reply` read.
 *
 * ### Why off → on restores `auto`
 *
 * Identical to the Settings card, on purpose: off is a pause, there is nowhere
 * to remember the position it paused, so the switch asks for the strongest mode
 * and the server downgrades it to `suggest` for a clinic without
 * `ai.patient_auto`. The server is the authority; this component never decides
 * the resulting mode and re-reads it from the refreshed page.
 *
 * ### What it does not claim
 *
 * It is the clinic *default*, not the whole answer. Per-conversation exceptions
 * (`ai_enabled_override`) and human takeover (Pause AI) are separate, still
 * win where they apply, and are unchanged by this control. When exceptions
 * exist the count is stated beside the switch rather than hidden, so "AI
 * replies: Off" is never read as "every thread is silent".
 *
 * The optimistic flip is safely reversible: the previous value is restored and
 * the failure surfaced if the action rejects, and the authoritative value
 * arrives with the next server render.
 */
export function InboxAiRepliesControl({ mode, overrideCount, canManage }: Props) {
  const t = useTranslations("inbox");
  const [enabled, setEnabled] = useState(mode !== "off");
  const [pending, startTransition] = useTransition();
  // The server is the authority. A refresh, a realtime reload, or a change made
  // from Settings in another tab re-renders this with the stored value, and the
  // local optimistic state must yield to it rather than pin a stale reading.
  // Adjusted during render rather than in an effect, which is React's own
  // recommendation for state derived from a prop that changed.
  const [renderedMode, setRenderedMode] = useState(mode);
  if (renderedMode !== mode) {
    setRenderedMode(mode);
    setEnabled(mode !== "off");
  }

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
      toast.success(next ? t("ai.globalOnToast") : t("ai.globalOffToast"));
    });
  }

  const Icon = enabled ? Bot : BotOff;
  return (
    <div
      className="flex items-center gap-2 rounded-md border bg-card px-3 py-1.5"
      data-testid="inbox-global-ai"
      data-ai-mode={mode}
    >
      <Icon className="size-4 text-muted-foreground" aria-hidden />
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-medium">
          {enabled ? t("ai.globalOn") : t("ai.globalOff")}
        </span>
        {overrideCount > 0 ? (
          <span className="text-xs text-muted-foreground" data-testid="inbox-global-ai-overrides">
            {t("ai.globalOverrides", { count: overrideCount })}
          </span>
        ) : null}
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={onToggle}
        disabled={!canManage || pending}
        aria-label={t("ai.globalToggleLabel")}
        data-testid="inbox-global-ai-switch"
      />
    </div>
  );
}
