"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { AlertTriangle, Check, Loader2, SendHorizonal, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  createBulkSend,
  readBulkSendJob,
  resolveInterruptedBulkRecipient,
  runBulkSend,
  type BulkJobView,
} from "@/actions/bulk-messaging";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { BulkRecipientPicker } from "@/components/inbox/bulk-recipient-picker";
import { MAX_BULK_RECIPIENTS, bulkFailureLabelKey } from "@/lib/messaging/bulk-send-plan";
import type { BulkRecipient } from "@/lib/messaging/bulk-recipients";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

/**
 * P11Q — compose, review, confirm, watch.
 *
 * The four steps are deliberate, and the third one is the point. Sending the
 * same sentence to forty patients is not undoable, so the flow refuses to let it
 * happen in one click: staff write the message, then see the actual list
 * including everyone who will be *skipped* and why, and only then get a button
 * that says how many people it is about to write to.
 *
 * Afterwards the same dialog becomes the results view. A bulk send that half
 * worked is the normal case — a closed thread here, an expired service window
 * there — and the one thing this must never do is show a green tick over it.
 */

type Step = "compose" | "review" | "progress";

export function BulkSendDialog({
  open,
  onOpenChange,
  recipients,
  initialSelectedKeys,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Everyone this clinic can send to, already merged and deduplicated across
   * Inbox threads, the WhatsApp contact directory and the patient files. See
   * `lib/messaging/bulk-recipients.ts`.
   */
  recipients: BulkRecipient[];
  /** Rows the staff member ticked in the Inbox list before opening this. */
  initialSelectedKeys: string[];
  onSent: () => void;
}) {
  const t = useTranslations("inbox.bulk");
  const [step, setStep] = useState<Step>("compose");
  const [body, setBody] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<string[]>(initialSelectedKeys);
  // The picker is seeded from the Inbox selection each time the dialog is
  // opened with a different one. Adjusting state during render (guarded) rather
  // than in an effect, which is the pattern the rest of this Inbox uses.
  const [seededFrom, setSeededFrom] = useState(initialSelectedKeys);
  if (seededFrom !== initialSelectedKeys) {
    setSeededFrom(initialSelectedKeys);
    setSelectedKeys(initialSelectedKeys);
  }
  const chosen = useMemo(
    () => recipients.filter((recipient) => selectedKeys.includes(recipient.key)),
    [recipients, selectedKeys],
  );
  const [job, setJob] = useState<BulkJobView | null>(null);
  const [pending, startTransition] = useTransition();
  // Guards the window between a click and the transition starting, which is
  // where a double-click would otherwise create a second job.
  const submitting = useRef(false);

  // Literal keys, so the i18n gate can see every one of them. A key built from
  // the status would be invisible to it, and a missing status label would then
  // surface as a raw enum in front of staff.
  const recipientStatusLabel = useCallback(
    (status: BulkJobView["recipients"][number]["status"]) =>
      ({
        pending: t("recipientStatus.pending"),
        sending: t("recipientStatus.sending"),
        sent: t("recipientStatus.sent"),
        failed: t("recipientStatus.failed"),
        skipped: t("recipientStatus.skipped"),
        review: t("recipientStatus.review"),
      })[status],
    [t],
  );

  /**
   * Stable codes stay in the database; only the sentence is localized. The map
   * is total, so a code with no entry still resolves to one honest generic
   * sentence rather than leaking `SERVICE_WINDOW_CLOSED` at a receptionist.
   */
  const reasonFor = useCallback(
    (code: string | null) => {
      const key = bulkFailureLabelKey(code);
      if (!key) return null;
      return {
        "failureReason.notWhatsapp": t("failureReason.notWhatsapp"),
        "failureReason.noAddress": t("failureReason.noAddress"),
        "failureReason.conversationClosed": t("failureReason.conversationClosed"),
        "failureReason.interrupted": t("failureReason.interrupted"),
        "failureReason.interruptedDismissed": t("failureReason.interruptedDismissed"),
        "failureReason.invalidInput": t("failureReason.invalidInput"),
        "failureReason.channelUnavailable": t("failureReason.channelUnavailable"),
        "failureReason.notEntitled": t("failureReason.notEntitled"),
        "failureReason.subscriptionInactive": t("failureReason.subscriptionInactive"),
        "failureReason.usageLimitReached": t("failureReason.usageLimitReached"),
        "failureReason.conversationNotFound": t("failureReason.conversationNotFound"),
        "failureReason.serviceWindowClosed": t("failureReason.serviceWindowClosed"),
        "failureReason.templateUnavailable": t("failureReason.templateUnavailable"),
        "failureReason.mediaUnsupported": t("failureReason.mediaUnsupported"),
        "failureReason.providerSendFailed": t("failureReason.providerSendFailed"),
        "failureReason.providerSendAmbiguous": t("failureReason.providerSendAmbiguous"),
        "failureReason.generic": t("failureReason.generic"),
      }[key] ?? t("failureReason.generic");
    },
    [t],
  );

  /**
   * The results list names a recipient from what the *server* returned for it.
   *
   * A recipient chosen from the contact directory has its thread opened during
   * the send, so the browser has never seen that conversation and cannot label
   * it from anything it holds. `readBulkSendJob` reads the name off the
   * conversation row instead, which is correct for every source.
   */
  const nameFor = useCallback(
    (recipient: { name: string | null }) => recipient.name ?? t("unknownRecipient"),
    [t],
  );

  /**
   * Reset on close, in the close itself.
   *
   * Doing this in an effect keyed on `open` would set state during render
   * commit and cascade an extra render for every close; the state only ever
   * needs to change at the moment somebody closes the dialog, which is exactly
   * where this lives now.
   */
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setStep("compose");
        setBody("");
        setJob(null);
        setSelectedKeys(initialSelectedKeys);
        submitting.current = false;
      }
      onOpenChange(next);
    },
    [initialSelectedKeys, onOpenChange],
  );

  const refreshJob = useCallback(async (jobId: string) => {
    const result = await readBulkSendJob({ jobId });
    if (result.job) setJob(result.job);
  }, []);

  /**
   * Live progress on the existing realtime architecture, and nothing new.
   *
   * The recipients table is in the same `supabase_realtime` publication the
   * Inbox already listens to, so a running job reports itself instead of being
   * polled for. The subscription is scoped to this dialog and torn down with it,
   * deliberately kept out of the Inbox's own channel set: a job's progress must
   * never be able to put the Inbox's realtime status into an error state.
   *
   * If the subscription never lands, nothing breaks — the job is re-read when
   * the run returns, which is the same result a moment later.
   */
  useEffect(() => {
    if (step !== "progress" || !job) return;
    const jobId = job.id;
    const supabase = createClient();
    let disposed = false;
    const channel = supabase
      .channel(`bulk-send:${jobId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "bulk_message_recipients" },
        () => {
          if (!disposed) void refreshJob(jobId);
        },
      )
      .subscribe();
    return () => {
      disposed = true;
      void supabase.removeChannel(channel);
    };
    // Only the job identity matters; re-subscribing on every row change would
    // tear the channel down in the middle of the updates it is listening for.
  }, [step, job?.id, refreshJob]);

  const handleResolve = useCallback(
    (recipientId: string, decision: "resend" | "dismiss") => {
      if (submitting.current) return;
      submitting.current = true;
      startTransition(async () => {
        try {
          const result = await resolveInterruptedBulkRecipient({ recipientId, decision });
          if (result.error) toast.error(result.error);
          if (job) await refreshJob(job.id);
          onSent();
        } finally {
          submitting.current = false;
        }
      });
    },
    [job, onSent, refreshJob],
  );

  function handleReview() {
    if (!body.trim() || chosen.length === 0) return;
    setStep("review");
  }

  function handleConfirm() {
    if (submitting.current) return;
    submitting.current = true;
    startTransition(async () => {
      try {
        // Threads go as ids; contacts and patient files go as addresses, which
        // the server resolves to conversations through the same path the New
        // Conversation dialog uses. Both arrive at the identical plan.
        const created = await createBulkSend({
          body: body.trim(),
          conversationIds: chosen
            .map((recipient) => recipient.conversationId)
            .filter((id): id is string => Boolean(id)),
          addresses: chosen
            .filter((recipient) => !recipient.conversationId)
            .map((recipient) => recipient.address),
        });
        if (created.error || !created.jobId) {
          toast.error(created.error ?? t("startFailed"));
          return;
        }
        const jobId = created.jobId;
        setStep("progress");
        await refreshJob(jobId);
        const run = await runBulkSend({ jobId });
        if (run.error) toast.error(run.error);
        await refreshJob(jobId);
        onSent();
      } finally {
        submitting.current = false;
      }
    });
  }

  function handleRetryFailed() {
    if (!job || submitting.current) return;
    submitting.current = true;
    startTransition(async () => {
      try {
        // The same call as the first send. The claim inside it only yields
        // pending and failed recipients, so this cannot resend to anyone who
        // already received the message.
        const run = await runBulkSend({ jobId: job.id });
        if (run.error) toast.error(run.error);
        await refreshJob(job.id);
        onSent();
      } finally {
        submitting.current = false;
      }
    });
  }

  const sent = job?.recipients.filter((r) => r.status === "sent").length ?? 0;
  const failed = job?.recipients.filter((r) => r.status === "failed").length ?? 0;
  const skipped = job?.recipients.filter((r) => r.status === "skipped").length ?? 0;
  const done = job ? sent + failed + skipped : 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {step === "progress" ? t("progressDescription") : t("description")}
          </DialogDescription>
        </DialogHeader>

        {step === "compose" ? (
          <div className="space-y-3">
            <BulkRecipientPicker
              recipients={recipients}
              selectedKeys={selectedKeys}
              onChange={setSelectedKeys}
              max={MAX_BULK_RECIPIENTS}
            />
            <Textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={5}
              maxLength={4096}
              dir="auto"
              placeholder={t("bodyPlaceholder")}
              aria-label={t("bodyLabel")}
              data-testid="bulk-body"
            />
            <p className="text-xs text-muted-foreground">{t("operationalNote")}</p>
          </div>
        ) : null}

        {step === "review" ? (
          <div className="space-y-3">
            <p className="whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 text-sm" dir="auto">
              {body}
            </p>
            <p className="text-sm font-medium">
              {t("reviewHeading", { count: chosen.length })}
            </p>
            <ul className="max-h-48 space-y-1 overflow-y-auto text-sm" data-testid="bulk-review-list">
              {chosen.map((recipient) => (
                <li
                  key={recipient.key}
                  className="flex items-center gap-2 rounded px-2 py-1 odd:bg-muted/40"
                  data-source={recipient.source}
                >
                  <span className="min-w-0 flex-1 truncate" dir="auto">
                    {recipient.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground" dir="ltr">
                    {recipient.address}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {step === "progress" && job ? (
          <div className="space-y-3" data-testid="bulk-progress">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span data-testid="bulk-progress-count">
                {t("progressCount", { done, total: job.totalRecipients })}
              </span>
              {/* Never one aggregate tick: each outcome is counted separately so
                  a partial send cannot read as a whole one. */}
              <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                {t("sentCount", { count: sent })}
              </Badge>
              {failed > 0 ? (
                <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive">
                  {t("failedCount", { count: failed })}
                </Badge>
              ) : null}
              {skipped > 0 ? (
                <Badge variant="outline" className="border-muted-foreground/30 bg-muted text-muted-foreground">
                  {t("skippedCount", { count: skipped })}
                </Badge>
              ) : null}
            </div>

            <ul className="max-h-56 space-y-1 overflow-y-auto text-sm" data-testid="bulk-results">
              {job.recipients.map((recipient) => (
                <li
                  key={recipient.id}
                  className="flex items-center gap-2 rounded px-2 py-1 odd:bg-muted/40"
                  data-testid="bulk-result-row"
                  data-status={recipient.status}
                >
                  <span className="min-w-0 flex-1 truncate" dir="auto">
                    {nameFor(recipient)}
                  </span>
                  <span
                    className={cn(
                      "flex shrink-0 items-center gap-1 text-xs",
                      recipient.status === "sent" && "text-emerald-700 dark:text-emerald-300",
                      recipient.status === "failed" && "text-destructive",
                      recipient.status === "skipped" && "text-muted-foreground",
                    )}
                  >
                    {recipient.status === "sent" ? <Check className="size-3.5" aria-hidden /> : null}
                    {recipient.status === "failed" ? <X className="size-3.5" aria-hidden /> : null}
                    {recipient.status === "skipped" ? (
                      <AlertTriangle className="size-3.5" aria-hidden />
                    ) : null}
                    {recipient.status === "pending" || recipient.status === "sending" ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : null}
                    {recipientStatusLabel(recipient.status)}
                  </span>
                </li>
              ))}
            </ul>

            {/* Skips and failures always name a reason. A recipient who was not
                written to, with no explanation, is the bug this list exists to
                prevent. */}
            {job.recipients.some((r) => r.failureCode) ? (
              <ul className="space-y-1 text-xs text-muted-foreground" data-testid="bulk-reasons">
                {job.recipients
                  .filter((r) => r.failureCode)
                  .map((r) => (
                    <li key={`reason-${r.id}`} dir="auto">
                      {nameFor(r)} — {reasonFor(r.failureCode)}
                    </li>
                  ))}
              </ul>
            ) : null}

            {/* Interrupted recipients: visible, and resolvable without touching
                the database. Neither button is pressed on the clinic's behalf —
                the whole point is that a human decides, because the system
                genuinely cannot know whether the message arrived. */}
            {job.recipients.some((r) => r.status === "review") ? (
              <div
                className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
                data-testid="bulk-review-panel"
              >
                <p className="text-xs text-amber-800 dark:text-amber-300">
                  {t("reviewExplainer")}
                </p>
                {job.recipients
                  .filter((r) => r.status === "review")
                  .map((r) => (
                    <div
                      key={`review-${r.id}`}
                      className="flex flex-wrap items-center gap-2 text-sm"
                      data-testid="bulk-review-row"
                    >
                      <span className="min-w-0 flex-1 truncate" dir="auto">
                        {nameFor(r)}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => handleResolve(r.id, "resend")}
                        data-testid="bulk-review-resend"
                      >
                        {t("reviewResend")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => handleResolve(r.id, "dismiss")}
                        data-testid="bulk-review-dismiss"
                      >
                        {t("reviewDismiss")}
                      </Button>
                    </div>
                  ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter className="gap-2">
          {step === "compose" ? (
            <Button
              onClick={handleReview}
              disabled={!body.trim() || chosen.length === 0}
              data-testid="bulk-continue"
            >
              {t("continue")}
            </Button>
          ) : null}
          {step === "review" ? (
            <>
              <Button variant="outline" onClick={() => setStep("compose")} disabled={pending}>
                {t("back")}
              </Button>
              {/* The explicit final confirmation, and it says the number out
                  loud rather than just "Send". */}
              <Button onClick={handleConfirm} disabled={pending} data-testid="bulk-confirm">
                {pending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <SendHorizonal className="size-4" aria-hidden />
                )}
                {t("confirmSend", { count: chosen.length })}
              </Button>
            </>
          ) : null}
          {step === "progress" ? (
            <>
              {failed > 0 ? (
                <Button
                  variant="outline"
                  onClick={handleRetryFailed}
                  disabled={pending}
                  data-testid="bulk-retry-failed"
                >
                  {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                  {t("retryFailed", { count: failed })}
                </Button>
              ) : null}
              <Button onClick={() => handleOpenChange(false)} disabled={pending}>
                {t("close")}
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
