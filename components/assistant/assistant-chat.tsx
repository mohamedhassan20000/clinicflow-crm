"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  isToolUIPart,
} from "ai";
import {
  Bot,
  CircleStop,
  FileSearch,
  LoaderCircle,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { DoctorAssistantUIMessage } from "@/lib/ai/doctor-agent";

type AssistantChatProps = {
  initialConversationId: string;
  initialMessages: DoctorAssistantUIMessage[];
  patient?: { id: string; name: string } | null;
  remaining: number;
  historyTruncated?: boolean;
  mode?: "page" | "sheet";
};

type SessionState = {
  id: string;
  messages: DoctorAssistantUIMessage[];
  historyTruncated: boolean;
};

type DoctorAssistantPart = DoctorAssistantUIMessage["parts"][number];
type DoctorAssistantToolPart = Extract<
  DoctorAssistantPart,
  { type: `tool-${string}` } | { type: "dynamic-tool" }
>;

function createConversationId() {
  return crypto.randomUUID();
}

function toolLabel(
  name: string,
  t: ReturnType<typeof useTranslations<"assistant">>,
) {
  switch (name) {
    case "get_patient_summary":
      return t("toolPatientSummary");
    case "search_patient_visits":
      return t("toolVisitSearch");
    case "list_doctor_appointments":
      return t("toolAppointments");
    case "check_availability":
      return t("toolAvailability");
    default:
      return t("toolRecordReview");
  }
}

function ToolActivity({
  part,
}: {
  part: DoctorAssistantToolPart;
}) {
  const t = useTranslations("assistant");
  const complete = part.state === "output-available";
  const failed = part.state === "output-error";
  const name = part.type === "dynamic-tool" ? part.toolName : part.type.slice(5);
  return (
    <div className="my-2 flex items-center gap-2 rounded-xl border border-border/60 bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
      {complete ? (
        <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
      ) : failed ? (
        <FileSearch className="size-3.5 text-destructive" aria-hidden="true" />
      ) : (
        <LoaderCircle className="size-3.5 animate-spin text-primary" aria-hidden="true" />
      )}
      <span className="font-medium text-foreground/80">{toolLabel(name, t)}</span>
      <span className="ms-auto">
        {complete ? t("toolComplete") : failed ? t("toolFailed") : t("toolWorking")}
      </span>
    </div>
  );
}

function MessageBubble({ message }: { message: DoctorAssistantUIMessage }) {
  const t = useTranslations("assistant");
  const isUser = message.role === "user";
  return (
    <article
      className={cn("flex gap-3", isUser ? "justify-end" : "justify-start")}
      aria-label={isUser ? t("yourMessage") : t("assistantMessage")}
    >
      {!isUser ? (
        <div className="mt-1 grid size-8 shrink-0 place-items-center rounded-xl border border-primary/15 bg-primary/8 text-primary">
          <Bot className="size-4" aria-hidden="true" />
        </div>
      ) : null}
      <div
        className={cn(
          "max-w-[86%] rounded-2xl px-4 py-3 text-sm leading-6 shadow-xs",
          isUser
            ? "rounded-ee-md bg-primary text-primary-foreground"
            : "rounded-es-md border border-border/70 bg-card text-card-foreground",
        )}
      >
        {message.parts.map((part, index) => {
          if (part.type === "text") {
            return (
              <p key={`${message.id}-text-${index}`} className="whitespace-pre-wrap break-words">
                {part.text}
              </p>
            );
          }
          if (isToolUIPart(part)) {
            return <ToolActivity key={part.toolCallId} part={part} />;
          }
          return null;
        })}
      </div>
      {isUser ? (
        <div className="mt-1 grid size-8 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
          <UserRound className="size-4" aria-hidden="true" />
        </div>
      ) : null}
    </article>
  );
}

function ChatSession({
  session,
  patient,
  remaining,
  mode,
  onNewConversation,
}: {
  session: SessionState;
  patient?: AssistantChatProps["patient"];
  remaining: number;
  mode: NonNullable<AssistantChatProps["mode"]>;
  onNewConversation: () => void;
}) {
  const t = useTranslations("assistant");
  const router = useRouter();
  const [input, setInput] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const transport = useMemo(
    () =>
      new DefaultChatTransport<DoctorAssistantUIMessage>({
        api: "/api/agent/chat",
        credentials: "same-origin",
        prepareSendMessagesRequest({ id, messages }) {
          return {
            body: {
              id,
              patientId: patient?.id ?? null,
              message: messages.at(-1),
            },
          };
        },
        async fetch(input, init) {
          const response = await globalThis.fetch(input, init);
          if (!response.ok) {
            const payload = (await response.clone().json().catch(() => null)) as
              | { error?: string }
              | null;
            throw new Error(payload?.error ?? "temporarily_unavailable");
          }
          return response;
        },
      }),
    [patient?.id],
  );
  const {
    messages,
    sendMessage,
    status,
    error,
    stop,
    clearError,
  } = useChat<DoctorAssistantUIMessage>({
    id: session.id,
    messages: session.messages,
    transport,
    experimental_throttle: 40,
    onFinish({ isAbort, isError }) {
      if (!isAbort && !isError) {
        setAnnouncement(t("responseReady"));
        router.refresh();
      } else {
        setAnnouncement("");
      }
    },
  });
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    endRef.current?.scrollIntoView({
      block: "end",
      behavior: status === "streaming" ? "auto" : "smooth",
    });
  }, [messages, status]);

  const errorCopy = error
    ? error.message === "usage_limit_reached"
      ? t("errorCapReached")
      : error.message === "feature_not_entitled"
        ? t("errorUpgrade")
        : error.message === "rate_limited"
          ? t("errorRateLimited")
          : t("errorGeneric")
    : null;

  function submitMessage() {
    const text = input.trim();
    if (!text || busy) return;
    clearError();
    setInput("");
    void sendMessage({ text });
  }

  const suggestions = patient
    ? [t("suggestSummary"), t("suggestRecentVisits"), t("suggestFollowups")]
    : [t("suggestSchedule"), t("suggestAvailability"), t("suggestHowToUse")];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {busy ? t("thinking") : announcement}
      </span>
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3 sm:px-5">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/8 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
          <ShieldCheck className="size-3.5" aria-hidden="true" />
          {t("readOnly")}
        </span>
        {patient ? (
          <span className="truncate rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
            {t("patientContext", { patient: patient.name })}
          </span>
        ) : null}
        <span className="ms-auto text-xs tabular-nums text-muted-foreground">
          {t("remaining", { count: remaining })}
        </span>
        <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={onNewConversation} disabled={busy}>
          <Plus className="size-3.5" aria-hidden="true" />
          {t("newChat")}
        </Button>
      </div>

      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6",
          mode === "page" ? "h-[min(62vh,44rem)]" : "h-full",
        )}
      >
        {messages.length === 0 ? (
          <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center py-8 text-center">
            <div className="relative mb-6 grid size-16 place-items-center rounded-3xl border border-primary/15 bg-primary/8 text-primary">
              <Sparkles className="size-7" aria-hidden="true" />
              <span className="absolute -end-1 -top-1 size-3 rounded-full border-2 border-background bg-emerald-500" />
            </div>
            <h2 className="font-heading text-xl font-semibold tracking-tight">
              {patient ? t("patientEmptyTitle", { patient: patient.name }) : t("emptyTitle")}
            </h2>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              {patient ? t("patientEmptyDescription") : t("emptyDescription")}
            </p>
            <div className="mt-6 grid w-full gap-2 sm:grid-cols-3">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setInput(suggestion)}
                  className="min-h-11 rounded-xl border border-border/70 bg-card px-3 py-2 text-start text-xs font-medium leading-5 text-foreground/80 transition-colors hover:border-primary/30 hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-5">
            {session.historyTruncated ? (
              <p className="rounded-xl border border-border/70 bg-muted/40 px-3 py-2 text-center text-xs text-muted-foreground">
                {t("historyTrimmed")}
              </p>
            ) : null}
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {status === "submitted" ? (
              <div className="flex items-center gap-3 text-sm text-muted-foreground">
                <div className="grid size-8 place-items-center rounded-xl border border-primary/15 bg-primary/8 text-primary">
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                </div>
                {t("thinking")}
              </div>
            ) : null}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <div className="border-t border-border/60 bg-background/95 p-3 sm:p-4">
        {errorCopy ? (
          <p role="alert" className="mb-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {errorCopy}
          </p>
        ) : null}
        <div className="mx-auto max-w-3xl">
          <div className="flex items-end gap-2 rounded-2xl border border-input bg-card p-2 shadow-sm focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/20">
            <Textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  submitMessage();
                }
              }}
              aria-label={t("messageLabel")}
              placeholder={patient ? t("patientPlaceholder") : t("placeholder")}
              maxLength={4_000}
              rows={1}
              className="max-h-36 min-h-11 resize-none border-0 bg-transparent px-2 py-2 shadow-none focus-visible:ring-0 dark:bg-transparent"
              disabled={busy}
            />
            {busy ? (
              <Button type="button" size="icon" variant="outline" onClick={stop} aria-label={t("stop") }>
                <CircleStop className="size-4" aria-hidden="true" />
              </Button>
            ) : (
              <Button type="button" size="icon" onClick={submitMessage} disabled={!input.trim()} aria-label={t("send") }>
                <Send className="size-4 rtl:-scale-x-100" aria-hidden="true" />
              </Button>
            )}
          </div>
          <p className="mt-2 px-1 text-center text-[11px] leading-4 text-muted-foreground">
            {t("clinicalDisclaimer")}
          </p>
        </div>
      </div>
    </div>
  );
}

export function AssistantChat({
  initialConversationId,
  initialMessages,
  patient = null,
  remaining,
  historyTruncated = false,
  mode = "page",
}: AssistantChatProps) {
  const [session, setSession] = useState<SessionState>({
    id: initialConversationId,
    messages: initialMessages,
    historyTruncated,
  });

  return (
    <ChatSession
      key={session.id}
      session={session}
      patient={patient}
      remaining={remaining}
      mode={mode}
      onNewConversation={() => setSession({
        id: createConversationId(),
        messages: [],
        historyTruncated: false,
      })}
    />
  );
}
