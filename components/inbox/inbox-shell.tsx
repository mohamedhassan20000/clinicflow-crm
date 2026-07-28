"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import {
  CheckCheck,
  CircleUserRound,
  Clock3,
  Loader2,
  LockKeyhole,
  MessageCircleMore,
  Plus,
  Search,
  Send,
  Sparkles,
  TriangleAlert,
  UserRoundCheck,
  X,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  approveAiSuggestion,
  clearConversationEscalation,
  dismissAiSuggestion,
  linkConversationPatient,
  sendInboxReply,
  updateConversationAssignment,
  updateConversationStatus,
} from "@/actions/messaging";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createClient } from "@/lib/supabase/client";
import type {
  InboxConversation,
  InboxData,
  InboxTemplate,
} from "@/lib/messaging/inbox";
import { cn } from "@/lib/utils";

const ESCALATION_REASONS = new Set([
  "emergency",
  "human_requested",
  "medical",
  "complaint",
  "low_confidence",
  "agent_error",
]);

/** Maps a stored escalation reason to its `inbox.ai.reason.*` message key. */
function escalationReasonKey(reason: string | null): string {
  return `ai.reason.${reason && ESCALATION_REASONS.has(reason) ? reason : "low_confidence"}`;
}

function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "?";
}

function seenStorageKey(viewerId: string) {
  return `clinicflow:inbox-seen:${viewerId}`;
}

const SEEN_EVENT = "clinicflow:inbox-seen-change";

function readSeenSnapshot(viewerId: string): string | null {
  try {
    return localStorage.getItem(seenStorageKey(viewerId));
  } catch {
    return null;
  }
}

export function InboxShell({
  data,
  clinicId,
  viewerId,
}: {
  data: InboxData;
  clinicId: string;
  viewerId: string;
}) {
  const t = useTranslations("inbox");
  const format = useFormatter();
  const router = useRouter();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [query, setQuery] = useState("");
  const [reply, setReply] = useState("");
  const [suggestionDraft, setSuggestionDraft] = useState("");
  const [suggestionEditing, setSuggestionEditing] = useState(false);
  const [suggestionDraftFor, setSuggestionDraftFor] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [templateParameters, setTemplateParameters] = useState<string[]>([]);
  const [patientQuery, setPatientQuery] = useState("");
  const [patientDialogOpen, setPatientDialogOpen] = useState(false);
  const [now, setNow] = useState(() => new Date(data.loadedAt).valueOf());
  const [realtimeStatus, setRealtimeStatus] = useState<"connecting" | "subscribed" | "error">("connecting");
  const [pending, startTransition] = useTransition();

  const selected = data.conversations.find(
    (conversation) => conversation.id === data.selectedConversationId,
  ) ?? null;
  const selectedTemplate = data.templates.find((template) => template.id === templateId) ?? null;
  const suggestion =
    data.suggestion && selected && data.suggestion.conversationId === selected.id
      ? data.suggestion
      : null;
  const escalationReasonLabel = t(escalationReasonKey(selected?.escalationReason ?? null));

  // Reset the editable draft when a different suggestion loads. Adjusting state
  // during render (guarded) is the React-recommended alternative to a
  // setState-in-effect for deriving state from props.
  const suggestionKey = suggestion ? `${suggestion.id}:${suggestion.body}` : null;
  if (suggestionKey !== suggestionDraftFor) {
    setSuggestionDraftFor(suggestionKey);
    setSuggestionDraft(suggestion?.body ?? "");
    setSuggestionEditing(false);
  }

  const subscribeSeen = useCallback((callback: () => void) => {
    window.addEventListener("storage", callback);
    window.addEventListener(SEEN_EVENT, callback);
    return () => {
      window.removeEventListener("storage", callback);
      window.removeEventListener(SEEN_EVENT, callback);
    };
  }, []);
  const seenSnapshot = useSyncExternalStore(
    subscribeSeen,
    () => readSeenSnapshot(viewerId),
    () => null,
  );
  const seen = useMemo(() => {
    if (!seenSnapshot) return {};
    try {
      return JSON.parse(seenSnapshot) as Record<string, string>;
    } catch {
      return {};
    }
  }, [seenSnapshot]);

  useEffect(() => {
    if (!selected?.lastInboundAt) return;
    if (seen[selected.id] && seen[selected.id] >= selected.lastInboundAt) return;
    try {
      localStorage.setItem(
        seenStorageKey(viewerId),
        JSON.stringify({ ...seen, [selected.id]: selected.lastInboundAt }),
      );
      window.dispatchEvent(new Event(SEEN_EVENT));
    } catch {
      // Device persistence is an enhancement, not an action prerequisite.
    }
  }, [seen, selected?.id, selected?.lastInboundAt, viewerId]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  // While Realtime is degraded, use a narrow refresh backstop. Normal
  // subscribed inboxes remain fully event-led.
  useEffect(() => {
    if (realtimeStatus !== "error") return;
    const timer = window.setTimeout(() => router.refresh(), 5_000);
    return () => window.clearTimeout(timer);
  }, [data.loadedAt, realtimeStatus, router]);

  useEffect(() => {
    const supabase = createClient();
    let disposed = false;
    const channels: ReturnType<typeof supabase.channel>[] = [];
    const refresh = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => router.refresh(), 250);
    };
    async function subscribe() {
      const { data: { session } } = await supabase.auth.getSession();
      if (disposed) return;
      if (session?.access_token) await supabase.realtime.setAuth(session.access_token);
      if (disposed) return;
      const subscribedTables = new Set<string>();
      const realtimeTables = [
        "conversations",
        "inbound_messages",
        "outbound_messages",
        "ai_suggested_replies",
      ] as const;
      for (const table of realtimeTables) {
        const channel = supabase
          .channel(`clinic-inbox:${clinicId}:${table}`)
          // Role-aware RLS is the subscription filter. A redundant UUID
          // postgres_changes filter suppressed local INSERT delivery.
          .on("postgres_changes", { event: "*", schema: "public", table }, refresh)
          .subscribe((status) => {
            if (status === "SUBSCRIBED") {
              subscribedTables.add(table);
              if (subscribedTables.size === realtimeTables.length) setRealtimeStatus("subscribed");
            } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
              setRealtimeStatus("error");
            }
          });
        channels.push(channel);
      }
    }
    void subscribe();
    return () => {
      disposed = true;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      for (const channel of channels) void supabase.removeChannel(channel);
    };
  }, [clinicId, router]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return data.conversations;
    return data.conversations.filter((conversation) =>
      [conversation.patientName, conversation.sender, conversation.preview, conversation.patientFileNumber]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(normalized)),
    );
  }, [data.conversations, query]);

  const filteredPatients = useMemo(() => {
    const normalized = patientQuery.trim().toLocaleLowerCase();
    if (!normalized) return data.patients.slice(0, 50);
    return data.patients
      .filter((patient) =>
        [patient.name, patient.phone, patient.fileNumber].some((value) =>
          value.toLocaleLowerCase().includes(normalized),
        ),
      )
      .slice(0, 50);
  }, [data.patients, patientQuery]);

  const windowOpen = Boolean(
    selected?.windowExpiresAt && new Date(selected.windowExpiresAt).valueOf() > now,
  );

  function visibleUnread(conversation: InboxConversation) {
    if (!conversation.lastInboundAt || conversation.unreadCount === 0) return 0;
    return seen[conversation.id] && seen[conversation.id] >= conversation.lastInboundAt
      ? 0
      : conversation.unreadCount;
  }

  function messageStatusLabel(status: NonNullable<InboxData["messages"][number]["status"]>) {
    switch (status) {
      case "queued":
        return t("status.queued");
      case "sent":
        return t("status.sent");
      case "delivered":
        return t("status.delivered");
      case "read":
        return t("status.read");
      case "failed":
        return t("status.failed");
    }
  }

  function runAction(action: () => Promise<{ success?: boolean; error?: string }>, success: string) {
    startTransition(async () => {
      const result = await action();
      if (result.error) toast.error(result.error);
      else {
        toast.success(success);
        router.refresh();
      }
    });
  }

  function chooseTemplate(template: InboxTemplate) {
    setTemplateId(template.id);
    setTemplateParameters(template.variableNames.map(() => ""));
  }

  function handleApproveSuggestion() {
    if (!suggestion) return;
    const edited = suggestionEditing ? suggestionDraft.trim() : undefined;
    if (suggestionEditing && !edited) return;
    startTransition(async () => {
      const result = await approveAiSuggestion({ suggestionId: suggestion.id, body: edited });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(t("ai.suggestionSent"));
      router.refresh();
    });
  }

  function handleDismissSuggestion() {
    if (!suggestion) return;
    runAction(() => dismissAiSuggestion({ suggestionId: suggestion.id }), t("ai.suggestionDismissed"));
  }

  function handleClearEscalation() {
    if (!selected) return;
    runAction(
      () => clearConversationEscalation({ conversationId: selected.id }),
      t("ai.escalationCleared"),
    );
  }

  function handleSend() {
    if (!selected) return;
    const templateReady =
      selectedTemplate && templateParameters.every((parameter) => parameter.trim().length > 0);
    if ((!windowOpen && !templateReady) || (windowOpen && !reply.trim())) return;
    startTransition(async () => {
      const result = await sendInboxReply({
        conversationId: selected.id,
        body: windowOpen ? reply : "",
        templateId: windowOpen ? null : selectedTemplate?.id,
        templateParameters: windowOpen ? [] : templateParameters,
      });
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setReply("");
      setTemplateId(null);
      setTemplateParameters([]);
      toast.success(t("replySent"));
      router.refresh();
    });
  }

  return (
    <div className="space-y-5" data-realtime-status={realtimeStatus}>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </header>

      {data.error ? (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {t("loadError")}
        </div>
      ) : data.conversations.length === 0 ? (
        <div className="flex min-h-96 flex-col items-center justify-center rounded-xl border border-dashed p-8 text-center">
          <span className="mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
            <MessageCircleMore className="size-6 text-muted-foreground" aria-hidden />
          </span>
          <h2 className="font-semibold">{t("emptyTitle")}</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">{t("emptyDescription")}</p>
        </div>
      ) : (
        <div className="grid min-h-[36rem] overflow-hidden rounded-xl border bg-card lg:h-[calc(100dvh-13rem)] lg:grid-cols-[22rem_minmax(0,1fr)]">
          <aside className="flex min-h-72 flex-col border-b lg:min-h-0 lg:border-b-0 lg:border-e">
            <div className="border-b p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("searchPlaceholder")}
                  className="ps-9"
                  aria-label={t("searchLabel")}
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">{t("noMatches")}</p>
              ) : (
                filtered.map((conversation) => {
                  const name = conversation.patientName ?? conversation.sender ?? t("unknownSender");
                  const unread = visibleUnread(conversation);
                  return (
                    <Link
                      key={conversation.id}
                      href={`/inbox?conversation=${conversation.id}`}
                      className={cn(
                        "flex gap-3 border-b px-3 py-3 text-start transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                        selected?.id === conversation.id && "bg-primary/8",
                      )}
                    >
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                        {initials(name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{name}</span>
                          {unread > 0 ? <Badge className="ms-auto min-w-5 justify-center px-1.5">{unread}</Badge> : null}
                        </span>
                        <span className="mt-1 block truncate text-xs text-muted-foreground">
                          {conversation.preview || t("noPreview")}
                        </span>
                        <span className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                          <span>{conversation.assignedName ?? t("unassigned")}</span>
                          {conversation.status === "closed" ? <Badge variant="outline">{t("closed")}</Badge> : null}
                        </span>
                      </span>
                    </Link>
                  );
                })
              )}
            </div>
          </aside>

          {selected ? (
            <section className="flex min-h-[36rem] min-w-0 flex-col">
              <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
                <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                  {initials(selected.patientName ?? selected.sender ?? t("unknownSender"))}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate font-semibold">{selected.patientName ?? selected.sender ?? t("unknownSender")}</h2>
                    {selected.identityVerifiedAt ? (
                      <Badge variant="secondary" className="gap-1 text-emerald-700 dark:text-emerald-300">
                        <UserRoundCheck className="size-3" aria-hidden />
                        {t("verified")}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="gap-1">
                        <LockKeyhole className="size-3" aria-hidden />
                        {t("notVerified")}
                      </Badge>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground" dir="ltr">{selected.sender ?? "—"}</p>
                </div>

                <Select
                  value={selected.assignedTo ?? "__unassigned__"}
                  disabled={pending}
                  onValueChange={(value) =>
                    runAction(
                      () => updateConversationAssignment({ conversationId: selected.id, assignedTo: value === "__unassigned__" ? null : value }),
                      t("assignmentUpdated"),
                    )
                  }
                >
                  <SelectTrigger aria-label={t("assignConversation")} className="max-w-48">
                    <SelectValue placeholder={t("unassigned")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__unassigned__">{t("unassigned")}</SelectItem>
                    {data.assignees.map((assignee) => (
                      <SelectItem key={assignee.id} value={assignee.id}>{assignee.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Dialog open={patientDialogOpen} onOpenChange={setPatientDialogOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline" size="sm">
                      <CircleUserRound className="size-4" aria-hidden />
                      {selected.patientId ? t("changePatient") : t("linkPatient")}
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>{t("linkPatientTitle")}</DialogTitle>
                      <DialogDescription>{t("linkPatientDescription")}</DialogDescription>
                    </DialogHeader>
                    <div className="relative">
                      <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                      <Input value={patientQuery} onChange={(event) => setPatientQuery(event.target.value)} className="ps-9" placeholder={t("searchPatients")} />
                    </div>
                    <div className="max-h-72 overflow-y-auto rounded-lg border">
                      {selected.patientId ? (
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 border-b px-3 py-3 text-start text-sm text-destructive hover:bg-muted"
                          onClick={() => {
                            runAction(() => linkConversationPatient({ conversationId: selected.id, patientId: null }), t("patientLinkUpdated"));
                            setPatientDialogOpen(false);
                          }}
                        >
                          <X className="size-4" aria-hidden />{t("unlinkPatient")}
                        </button>
                      ) : null}
                      {filteredPatients.map((patient) => (
                        <button
                          key={patient.id}
                          type="button"
                          className="flex w-full items-center justify-between gap-3 border-b px-3 py-3 text-start last:border-b-0 hover:bg-muted"
                          onClick={() => {
                            runAction(() => linkConversationPatient({ conversationId: selected.id, patientId: patient.id }), t("patientLinkUpdated"));
                            setPatientDialogOpen(false);
                          }}
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{patient.name}</span>
                            <span className="block truncate text-xs text-muted-foreground" dir="ltr">{patient.phone}</span>
                          </span>
                          <span className="text-xs text-muted-foreground">{patient.fileNumber}</span>
                        </button>
                      ))}
                    </div>
                    <Button asChild variant="outline">
                      <Link href={`/patients/new?phone=${encodeURIComponent(selected.sender ?? "")}&returnTo=${encodeURIComponent(`/inbox?conversation=${selected.id}`)}`}>
                        <Plus className="size-4" aria-hidden />{t("createPatient")}
                      </Link>
                    </Button>
                  </DialogContent>
                </Dialog>

                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => runAction(
                    () => updateConversationStatus({ conversationId: selected.id, status: selected.status === "open" ? "closed" : "open" }),
                    selected.status === "open" ? t("conversationClosed") : t("conversationReopened"),
                  )}
                >
                  {selected.status === "open" ? t("close") : t("reopen")}
                </Button>
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto bg-muted/20 p-4" aria-live="polite">
                {data.messages.length === 0 ? (
                  <p className="py-12 text-center text-sm text-muted-foreground">{t("noMessages")}</p>
                ) : (
                  data.messages.map((message) => (
                    <div key={message.id} className={cn("flex", message.direction === "outbound" && "justify-end")}>
                      <div className={cn(
                        "max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-xs sm:max-w-[70%]",
                        message.direction === "outbound" ? "rounded-ee-sm bg-primary text-primary-foreground" : "rounded-es-sm border bg-card",
                      )}>
                        <p className="whitespace-pre-wrap break-words">{message.body || t("noPreview")}</p>
                        <div className={cn("mt-1 flex items-center justify-end gap-1 text-[10px]", message.direction === "outbound" ? "text-primary-foreground/70" : "text-muted-foreground")}>
                          <span>{format.dateTime(new Date(message.occurredAt), { dateStyle: "short", timeStyle: "short" })}</span>
                          {message.status ? <CheckCheck className="size-3" aria-label={messageStatusLabel(message.status)} /> : null}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="space-y-3 border-t p-3">
                {selected.escalatedAt ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-800 dark:text-amber-300">
                    <span className="flex items-center gap-2">
                      <TriangleAlert className="size-4 shrink-0" aria-hidden />
                      {t("ai.escalatedBanner", { reason: escalationReasonLabel })}
                    </span>
                    <Button variant="outline" size="sm" disabled={pending} onClick={handleClearEscalation}>
                      {t("ai.returnToAi")}
                    </Button>
                  </div>
                ) : null}

                {suggestion ? (
                  <div
                    className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3"
                    data-testid="ai-suggestion"
                  >
                    <div className="flex items-center gap-2 text-xs font-medium text-primary">
                      <Sparkles className="size-3.5" aria-hidden />
                      {suggestion.escalate ? t("ai.suggestionEscalationTitle") : t("ai.suggestionTitle")}
                    </div>
                    {suggestionEditing ? (
                      <Textarea
                        value={suggestionDraft}
                        onChange={(event) => setSuggestionDraft(event.target.value)}
                        maxLength={4000}
                        aria-label={t("ai.editSuggestion")}
                        className="max-h-48 min-h-16 resize-none bg-background"
                      />
                    ) : (
                      <p className="whitespace-pre-wrap break-words text-sm">{suggestion.body}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        disabled={pending || (suggestionEditing && !suggestionDraft.trim())}
                        onClick={handleApproveSuggestion}
                      >
                        {pending ? (
                          <Loader2 className="size-4 animate-spin" aria-hidden />
                        ) : (
                          <Send className="size-4 rtl:-scale-x-100" aria-hidden />
                        )}
                        {suggestionEditing ? t("ai.sendEdited") : t("ai.approveSend")}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => setSuggestionEditing((value) => !value)}
                      >
                        {suggestionEditing ? t("ai.cancelEdit") : t("ai.edit")}
                      </Button>
                      <Button variant="ghost" size="sm" disabled={pending} onClick={handleDismissSuggestion}>
                        {t("ai.dismiss")}
                      </Button>
                    </div>
                  </div>
                ) : null}

                {selected.status === "closed" ? (
                  <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 p-3 text-sm">
                    <span>{t("closedReplyHint")}</span>
                    <Button size="sm" onClick={() => runAction(() => updateConversationStatus({ conversationId: selected.id, status: "open" }), t("conversationReopened"))}>{t("reopen")}</Button>
                  </div>
                ) : windowOpen ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300">
                      <Clock3 className="size-3.5" aria-hidden />{t("windowOpen")}
                    </div>
                    <div className="flex items-end gap-2">
                      <Textarea value={reply} onChange={(event) => setReply(event.target.value)} maxLength={4096} placeholder={t("replyPlaceholder")} aria-label={t("replyLabel")} className="max-h-40 min-h-11 resize-none" />
                      <Button size="icon" disabled={pending || !reply.trim()} onClick={handleSend} aria-label={t("sendReply")}>
                        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4 rtl:-scale-x-100" aria-hidden />}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-800 dark:text-amber-300">
                      <p className="font-medium">{t("windowClosedTitle")}</p>
                      <p className="mt-1 text-xs">{t("windowClosedDescription")}</p>
                    </div>
                    {data.templates.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{t("noApprovedTemplates")}</p>
                    ) : (
                      <div className="space-y-3">
                        <Select value={templateId ?? undefined} onValueChange={(id) => {
                          const template = data.templates.find((item) => item.id === id);
                          if (template) chooseTemplate(template);
                        }}>
                          <SelectTrigger className="w-full" aria-label={t("chooseTemplate")}><SelectValue placeholder={t("chooseTemplate")} /></SelectTrigger>
                          <SelectContent>
                            {data.templates.map((template) => <SelectItem key={template.id} value={template.id}>{template.name} · {template.language.toUpperCase()}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        {selectedTemplate ? (
                          <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
                            <p className="whitespace-pre-wrap text-sm">{selectedTemplate.body}</p>
                            {selectedTemplate.variableNames.map((name, index) => (
                              <Input key={`${selectedTemplate.id}-${name}-${index}`} value={templateParameters[index] ?? ""} onChange={(event) => setTemplateParameters((current) => current.map((value, parameterIndex) => parameterIndex === index ? event.target.value : value))} placeholder={t("templateVariable", { name })} aria-label={t("templateVariable", { name })} maxLength={1000} />
                            ))}
                            <Button disabled={pending || templateParameters.some((parameter) => !parameter.trim())} onClick={handleSend}>
                              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4 rtl:-scale-x-100" aria-hidden />}
                              {t("sendTemplate")}
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
