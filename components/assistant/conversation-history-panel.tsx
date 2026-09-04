"use client";

import { useFormatter, useTranslations } from "next-intl";
import { History, LoaderCircle, Plus, TriangleAlert, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AssistantConversationSummary } from "@/lib/ai/conversations";

/**
 * Conversation history for the staff Assistant.
 *
 * One panel serves the `/assistant` page and every contextual "Ask Assistant"
 * launcher, because there is one conversation system: the rows listed here are
 * the same `agent_conversations` the streaming route writes, fetched through the
 * shared `listAssistantConversationHistory` action. The panel makes no
 * authorization decision and holds no fallback list — the server already dropped
 * anything the caller may no longer open, and opening one re-authorizes again.
 *
 * "New chat" lives here beside the list rather than only in the header, because
 * the two are the same decision: this panel is where a user answers "which
 * conversation am I in?".
 */

export type ConversationHistoryState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; conversations: readonly AssistantConversationSummary[] };

export function ConversationHistoryPanel({
  state,
  currentConversationId,
  busy,
  titleId,
  onSelect,
  onNewConversation,
  onRetry,
  onClose,
}: {
  state: ConversationHistoryState;
  currentConversationId: string;
  busy: boolean;
  titleId: string;
  onSelect: (conversationId: string) => void;
  onNewConversation: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("assistant");
  const format = useFormatter();

  return (
    <section
      aria-labelledby={titleId}
      className="border-b border-border/60 bg-muted/20"
    >
      <div className="flex items-start justify-between gap-3 px-4 pt-3 sm:px-5">
        <div className="min-w-0">
          <h2
            id={titleId}
            className="flex items-center gap-1.5 text-sm font-semibold text-foreground"
          >
            <History className="size-4 text-primary" aria-hidden="true" />
            {t("historyTitle")}
          </h2>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {t("historyDescription")}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0"
          onClick={onClose}
          aria-label={t("historyClose")}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>

      <div className="px-4 pb-3 pt-2 sm:px-5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full justify-start gap-1.5"
          onClick={onNewConversation}
          disabled={busy}
        >
          <Plus className="size-3.5" aria-hidden="true" />
          {t("historyStartNew")}
        </Button>

        <div
          className="mt-2 max-h-64 overflow-y-auto"
          tabIndex={0}
          role="region"
          aria-label={t("historyTitle")}
        >
          {state.status === "loading" ? (
            <p
              className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
              {t("historyLoading")}
            </p>
          ) : state.status === "error" ? (
            <div className="px-1 py-3">
              <p
                role="alert"
                className="flex items-center gap-2 text-xs text-destructive"
              >
                <TriangleAlert className="size-3.5" aria-hidden="true" />
                {t("historyUnavailable")}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={onRetry}
              >
                {t("historyRetry")}
              </Button>
            </div>
          ) : state.conversations.length === 0 ? (
            <p className="rounded-xl border border-border/70 bg-card px-3 py-2 text-xs text-muted-foreground">
              {t("historyEmpty")}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {state.conversations.map((conversation) => {
                const current = conversation.id === currentConversationId;
                return (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      disabled={busy || current}
                      aria-current={current ? "true" : undefined}
                      onClick={() => onSelect(conversation.id)}
                      className={cn(
                        "min-h-11 w-full rounded-xl border px-3 py-2 text-start transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                        current
                          ? "border-primary/40 bg-primary/8"
                          : "border-border/60 bg-card hover:border-primary/30 hover:bg-primary/5",
                        busy && !current ? "opacity-60" : null,
                      )}
                    >
                      <span className="flex items-center gap-1.5">
                        {conversation.patientBound ? (
                          <UserRound
                            className="size-3.5 shrink-0 text-primary"
                            aria-hidden="true"
                          />
                        ) : null}
                        <span className="truncate text-xs font-medium text-foreground">
                          {conversation.title?.trim() || t("historyUntitled")}
                        </span>
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
                        <time dateTime={conversation.updatedAt}>
                          {format.dateTime(new Date(conversation.updatedAt), {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </time>
                        {conversation.patientBound ? (
                          <span>{t("historyPatientBound")}</span>
                        ) : null}
                        {current ? (
                          <span className="font-medium text-primary">
                            {t("historyCurrent")}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
