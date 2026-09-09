"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import {
  ArrowDown,
  BotOff,
  CalendarClock,
  CheckCheck,
  CircleUserRound,
  Loader2,
  LockKeyhole,
  MessageCircleMore,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Send,
  SendHorizonal,
  Sparkles,
  TriangleAlert,
  UserRoundCheck,
  Users,
  X,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  approveAiSuggestion,
  clearConversationEscalation,
  dismissAiSuggestion,
  linkConversationPatient,
  setConversationAiEnabled,
  setConversationHumanTakeover,
  updateConversationAssignment,
  updateConversationStatus,
} from "@/actions/messaging";
import { MessageAttachments } from "@/components/inbox/message-attachments";
import {
  isMediaPlaceholderBody,
  mediaPlaceholderKind,
} from "@/lib/messaging/media-placeholder";
import {
  CONVERSATION_BADGE_STATES,
  CONVERSATION_BADGE_CLASSES,
  conversationBadgeState,
  type ConversationBadgeState,
} from "@/lib/messaging/conversation-status";
import { InboxComposer } from "@/components/inbox/inbox-composer";
import { BulkCloseDialog } from "@/components/inbox/bulk-close-dialog";
import { BulkSendDialog } from "@/components/inbox/bulk-send-dialog";
import { MAX_BULK_RECIPIENTS } from "@/lib/messaging/bulk-send-plan";
import { buildBulkRecipients } from "@/lib/messaging/bulk-recipients";
import { Checkbox } from "@/components/ui/checkbox";
import { InboxAiRepliesControl } from "@/components/inbox/inbox-ai-replies-control";
import { NewConversationDialog } from "@/components/inbox/new-conversation-dialog";
import { PatientAppointmentsDialog } from "@/components/inbox/patient-appointments-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatInboxTimestamp } from "@/lib/i18n/message-timestamp";
import { createClient } from "@/lib/supabase/client";
import type {
  InboxConversation,
  InboxData,
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

/**
 * P8: what to call this conversation.
 *
 * The linked patient's own name wins outright — it is the record the clinic
 * keeps. Failing that, the name WhatsApp reports for the contact is far more
 * useful to a receptionist than a bare number, but it is chosen by whoever is
 * typing, so it is a label and nothing more: it never resolves a patient, never
 * matches a record, and is never shown as though it were verified.
 */
function conversationTitle(
  conversation: Pick<InboxConversation, "patientName" | "displayName" | "sender">,
  fallback: string,
): string {
  return conversation.patientName ?? conversation.displayName ?? conversation.sender ?? fallback;
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

/** Where the conversation-list collapse is remembered, for this tab only. */
const LIST_COLLAPSED_KEY = "clinicflow:inbox-list-collapsed";
const LIST_COLLAPSED_EVENT = "clinicflow:inbox-list-collapsed-change";

function readListCollapsed(): boolean {
  try {
    return sessionStorage.getItem(LIST_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribeListCollapsed(callback: () => void) {
  window.addEventListener(LIST_COLLAPSED_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(LIST_COLLAPSED_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

function readSeenSnapshot(viewerId: string): string | null {
  try {
    return localStorage.getItem(seenStorageKey(viewerId));
  } catch {
    return null;
  }
}


/**
 * P11P — the one badge that says what a thread needs, beside the name.
 *
 * Label only, one or two words, never the enum. `conversationBadgeState` owns
 * the decision; this owns nothing but how it looks.
 */
function ConversationStatusBadge({
  conversation,
  t,
}: {
  conversation: Pick<
    InboxData["conversations"][number],
    | "status"
    | "escalatedAt"
    | "hasDeliveryFailure"
    | "lastMessageAt"
    | "lastInboundAt"
    | "hasActiveEpisode"
    | "patientId"
    | "aiPausedAt"
    // P15 — the five inputs the canonical derivation gained. Listed rather
    // than spread so a field that stops being loaded fails the build here
    // instead of silently changing every badge in the list.
    | "aiTechnicalFailureAt"
    | "aiEnabled"
    | "hasOutstandingReview"
    | "lastAssistantReplyAt"
    | "lastHumanReplyAt"
    // The pair that dates the explicit Open/Closed decision, so a reopened
    // thread is not overruled by an episode pointer that ended before it.
    | "statusUpdatedAt"
    | "contextResetAt"
  >;
  t: ReturnType<typeof useTranslations>;
}) {
  const state = conversationBadgeState(conversation);
  // Literal keys rather than one key interpolated from the state: the i18n
  // gate resolves literal keys only, and a computed key is exactly the kind that
  // goes missing from a catalog with nothing failing until a clinic sees it.
  const label = {
    aiHandling: t("statusBadge.aiHandling"),
    done: t("statusBadge.done"),
    needsReview: t("statusBadge.needsReview"),
    newContact: t("statusBadge.newContact"),
    humanHandling: t("statusBadge.humanHandling"),
    waitingPatient: t("statusBadge.waitingPatient"),
    problem: t("statusBadge.problem"),
  }[state];
  // The badge itself has room for two words. The full product wording lives on
  // the title/aria label, so the state is unambiguous to anyone who hovers or
  // uses a screen reader without the list turning into prose.
  const description = {
    aiHandling: t("statusBadgeDescription.aiHandling"),
    done: t("statusBadgeDescription.done"),
    needsReview: t("statusBadgeDescription.needsReview"),
    newContact: t("statusBadgeDescription.newContact"),
    humanHandling: t("statusBadgeDescription.humanHandling"),
    waitingPatient: t("statusBadgeDescription.waitingPatient"),
    problem: t("statusBadgeDescription.problem"),
  }[state];
  return (
    <Badge
      variant="outline"
      className={cn("shrink-0 px-1.5 font-medium", CONVERSATION_BADGE_CLASSES[state])}
      data-testid="conversation-status-badge"
      data-state={state}
      title={description}
      aria-label={description}
    >
      {label}
    </Badge>
  );
}

/**
 * P16 — the one line a conversation row shows under the contact's name.
 *
 * A media message has no text of its own, so what is stored is the worker's
 * marker (`[image]`, `[document]`, …) for inbound and, since P16, the same
 * marker for a caption-less outbound file. Neither is something to show a
 * receptionist: the raw marker reads like the patient typed brackets, and the
 * empty string used to fall through to "No message preview" — which is what a
 * clinic saw for every photo and every PDF on the thread.
 *
 * So the marker becomes a localized label ("Photo" / "صورة") and
 * "No message preview" goes back to meaning what it says: a message this build
 * has no idea how to describe.
 */
function conversationPreviewLine(
  preview: string,
  t: ReturnType<typeof useTranslations<"inbox">>,
): string {
  // Spelled out rather than interpolated: the i18n gate reads these call sites
  // to prove every rendered key exists in both catalogs, and a template literal
  // is a key it cannot follow.
  switch (mediaPlaceholderKind(preview)) {
    case "image":
      return t("mediaPreview.image");
    case "video":
      return t("mediaPreview.video");
    case "videoNote":
      return t("mediaPreview.videoNote");
    case "document":
      return t("mediaPreview.document");
    case "sticker":
      return t("mediaPreview.sticker");
    case "contact":
      return t("mediaPreview.contact");
    case "location":
      return t("mediaPreview.location");
    case "audio":
      return t("mediaPreview.audio");
    case "voiceMessage":
      return t("mediaPreview.voiceMessage");
    default:
      return preview.trim() || t("noPreview");
  }
}

export function InboxShell({
  data,
  clinicId,
  viewerId,
  // Least privilege by default: a caller that does not say who is looking gets
  // the read-only header control, never the one that can change a clinic-wide
  // setting. The server action is the actual gate either way.
  viewerRole = "receptionist",
}: {
  data: InboxData;
  clinicId: string;
  viewerId: string;
  /**
   * P17 (§7) — who is looking, so the header's clinic-wide AI switch is
   * offered only to the role that may change it. The server action enforces the
   * same gate; this only decides whether an unusable control is rendered.
   */
  viewerRole?: "admin" | "receptionist";
}) {
  const t = useTranslations("inbox");
  const locale = useLocale();
  const router = useRouter();
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [query, setQuery] = useState(data.search);
  const [statusFilter, setStatusFilter] = useState<ConversationBadgeState | "all">("all");
  /**
   * P11Q — bulk selection is a *mode*, not a permanent column.
   *
   * The Inbox is a place people read one conversation at a time, so a checkbox
   * on every row all day would be clutter charged to the common case for the
   * sake of the rare one. Selection appears only once staff ask for it, and the
   * whole apparatus — checkboxes, count, send button — leaves with it.
   */
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [suggestionDraft, setSuggestionDraft] = useState("");
  const [suggestionEditing, setSuggestionEditing] = useState(false);
  const [suggestionDraftFor, setSuggestionDraftFor] = useState<string | null>(null);
  const [patientQuery, setPatientQuery] = useState("");
  const [patientDialogOpen, setPatientDialogOpen] = useState(false);
  const [pastAppointmentsOpen, setPastAppointmentsOpen] = useState(false);
  /**
   * P18 — whether the conversation list is hidden, giving the thread the whole
   * width.
   *
   * At 1280 and below the two-pane Inbox leaves the chat around 700 px, which
   * is where the composer, the attachment strip and long Arabic messages all
   * start fighting each other. Collapsing the list is the honest fix: the
   * reader is looking at one conversation, and the list is one click away.
   *
   * Remembered for the session in `sessionStorage` and nowhere else. It is a
   * view preference, not a setting: no column, no server round trip, no
   * migration, and a browser that refuses storage simply starts expanded.
   */
  const listCollapsed = useSyncExternalStore(
    subscribeListCollapsed,
    readListCollapsed,
    // The server has no session, so it always renders the list. React then
    // reconciles the stored preference after hydration without a mismatch —
    // the same pattern the unread-seen store above uses.
    () => false,
  );
  const setListCollapsed = useCallback(
    (next: boolean | ((current: boolean) => boolean)) => {
      const value = typeof next === "function" ? next(readListCollapsed()) : next;
      try {
        sessionStorage.setItem(LIST_COLLAPSED_KEY, value ? "1" : "0");
      } catch {
        // A view preference is never load-bearing: the toggle still works for
        // this render, it simply is not remembered.
      }
      window.dispatchEvent(new Event(LIST_COLLAPSED_EVENT));
    },
    [],
  );
  const [now, setNow] = useState(() => new Date(data.loadedAt).valueOf());
  const [realtimeStatus, setRealtimeStatus] = useState<"connecting" | "subscribed" | "error">("connecting");
  const [pending, startTransition] = useTransition();
  const threadRef = useRef<HTMLDivElement | null>(null);
  const [hasNewBelow, setHasNewBelow] = useState(false);
  // Whether the reader is following the conversation. Starts true because a
  // freshly opened thread is opened at its newest message.
  const followingRef = useRef(true);
  // Which thread the refs above describe, so opening a different one is
  // distinguishable from a new message arriving in the current one.
  const conversationRef = useRef<string | null>(null);

  const selected = data.conversations.find(
    (conversation) => conversation.id === data.selectedConversationId,
  ) ?? null;
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

  /**
   * P10 — following the conversation, the way every chat client does.
   *
   * There was no scroll management here at all: the thread rendered at
   * `scrollTop = 0` and stayed there, so a staff member sending a reply, or an
   * AI or inbound message arriving, left the newest message off-screen below a
   * scroll they had to perform themselves every single time.
   *
   * The rule is the ordinary one, and the half that matters is the second:
   *
   *   * near the bottom → follow new messages;
   *   * scrolled up reading history → do not move them, and show a button
   *     saying there is something new.
   *
   * "Near" is a threshold rather than an exact bottom because the bottom is
   * rarely exact — a growing composer, an image finishing its layout, or a
   * fractional device pixel ratio all leave a few pixels of slack that would
   * otherwise read as "the user has scrolled away".
   */
  const NEAR_BOTTOM_PX = 120;

  const scrollToNewest = useCallback((behavior: ScrollBehavior = "smooth") => {
    const thread = threadRef.current;
    if (!thread) return;
    // `scrollTo` is what gives the smooth behaviour, and it is also the one
    // part of this that jsdom does not implement — so the assignment is the
    // fallback rather than a second code path. Both land in the same place.
    if (typeof thread.scrollTo === "function") {
      thread.scrollTo({ top: thread.scrollHeight, behavior });
    } else {
      thread.scrollTop = thread.scrollHeight;
    }
    followingRef.current = true;
    setHasNewBelow(false);
  }, []);

  const handleThreadScroll = useCallback(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const distance = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
    const following = distance <= NEAR_BOTTOM_PX;
    followingRef.current = following;
    if (following) setHasNewBelow(false);
  }, []);

  /**
   * One effect, because there are not two decisions here — there is one, and
   * it depends on whether the conversation changed.
   *
   * Splitting it into "reset on conversation change" and "follow on new
   * message" created a race that jsdom found immediately: both fire on the
   * same commit when a thread is opened, and whichever ran second decided
   * whether the new-message indicator was showing. Keeping the two branches in
   * one effect makes the ordering a property of the code rather than of the
   * scheduler.
   */
  const newestMessageId = data.messages[data.messages.length - 1]?.id ?? null;
  useEffect(() => {
    const thread = threadRef.current;
    if (!selected?.id) return;
    if (conversationRef.current !== selected.id) {
      // A different thread: land on its newest message, never on the top, and
      // never carrying the previous thread's indicator across.
      conversationRef.current = selected.id;
      followingRef.current = true;
      setHasNewBelow(false);
      if (thread) thread.scrollTop = thread.scrollHeight;
      return;
    }
    if (!newestMessageId) return;
    if (followingRef.current) scrollToNewest();
    else setHasNewBelow(true);
  }, [newestMessageId, scrollToNewest, selected?.id]);

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
    // P11T — the Inbox's own refresh rate is what was taking it down.
    //
    // The measured failure: `get_inbox_conversation_summaries` timing out
    // against the `authenticated` role's 8s budget, 1,431 times in 24 hours,
    // always in bursts of seven or eight within two seconds and always
    // immediately after outbound write activity. The RPC itself is not slow —
    // P11S made it 268 ms, and `pg_stat_statements` records mean 416 ms against
    // a **max of 7,466 ms** over 1,300 calls. A function whose mean is 0.4 s and
    // whose worst case is 7.5 s is not slow; it is starved.
    //
    // What starves it is this callback. Four channels subscribe to every row
    // change on `conversations`, `inbound_messages`, `outbound_messages` and
    // `ai_suggested_replies`, clinic-wide, and each one calls `router.refresh()`
    // — a full `loadInboxData`: the summaries RPC plus four list reads plus
    // three thread reads. One AI turn writes ten to twenty rows across those
    // tables (the inbound, the conversation's stage/collected/status columns,
    // the draft, the outbound, then its sent → delivered → read ticks), a bulk
    // send writes hundreds, and *every open Inbox tab in the clinic runs the
    // whole load for every one of them, at the same instant*. Five staff with
    // the Inbox open turn one patient message into dozens of concurrent RPCs on
    // a shared-CPU instance, which is precisely the burst signature in the logs.
    //
    // Two changes, and neither hides an error:
    //
    //   * **A real debounce.** 250 ms is shorter than the gap between the writes
    //     of a single turn, so it coalesced almost nothing. At 1.2 s a whole
    //     turn collapses into one refresh, with a hard ceiling so a continuous
    //     stream still updates promptly rather than being starved by its own
    //     traffic.
    //   * **Jitter.** The debounce alone keeps every tab in lockstep, because
    //     they are all timing from the same broadcast. A random spread breaks
    //     the thundering herd, which is the half that actually produced the
    //     concurrency.
    const REFRESH_DEBOUNCE_MS = 1_200;
    const REFRESH_JITTER_MS = 800;
    const REFRESH_MAX_WAIT_MS = 4_000;
    let firstPendingAt: number | null = null;
    const refresh = () => {
      const now = Date.now();
      if (firstPendingAt === null) firstPendingAt = now;
      // Never let coalescing push an update past the ceiling: a busy thread must
      // still be seen to move.
      const remaining = REFRESH_MAX_WAIT_MS - (now - firstPendingAt);
      const delay = Math.max(
        0,
        Math.min(REFRESH_DEBOUNCE_MS + Math.random() * REFRESH_JITTER_MS, remaining),
      );
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        firstPendingAt = null;
        router.refresh();
      }, delay);
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
    return data.conversations.filter((conversation) =>
      (statusFilter === "all" || conversationBadgeState(conversation) === statusFilter) &&
      (!normalized ||
        [
          conversation.patientName,
          conversation.displayName,
          conversation.sender,
          conversation.preview,
          conversation.patientFileNumber,
        ]
          .filter(Boolean)
          .some((value) => value!.toLocaleLowerCase().includes(normalized))),
    );
  }, [data.conversations, query, statusFilter]);

  /**
   * Everyone this Inbox can bulk-send to, in one deduplicated list.
   *
   * Built here rather than in the dialog because all three sources are already
   * in the page payload — the conversation summaries, the WhatsApp contact
   * directory the New Conversation dialog reads, and the clinic's patient
   * files — so the picker costs no additional fetch. The merge and the
   * dedupe-by-number rule live in `lib/messaging/bulk-recipients.ts`, which is
   * pure and tested on its own.
   */
  const bulkRecipients = useMemo(
    () =>
      buildBulkRecipients({
        conversations: data.conversations,
        contacts: data.contacts,
        patients: data.patients.map((patient) => ({
          id: patient.id,
          name: patient.name,
          phone: patient.phone,
          fileNumber: patient.fileNumber,
        })),
        fallbackName: t("unknownSender"),
      }),
    [data.contacts, data.conversations, data.patients, t],
  );

  /**
   * The rows ticked in the Inbox list, as picker keys.
   *
   * A ticked thread whose number also appears in the contact directory
   * deduplicated onto the *conversation* row, so its key is the conversation's
   * one; a thread with no usable address never made it into the list at all
   * and is dropped here rather than seeding a selection that cannot be sent.
   */
  const initialBulkKeys = useMemo(() => {
    const available = new Set(bulkRecipients.map((recipient) => recipient.key));
    return selectedIds
      .map((id) => `conversation:${id}`)
      .filter((key) => available.has(key));
  }, [bulkRecipients, selectedIds]);

  /**
   * The list can only be hidden while a conversation is open to hide it *for*.
   * Collapsing it with nothing selected would leave an empty pane and no way
   * back, so the toggle simply does not apply there.
   */
  const listPaneVisible = !listCollapsed || !data.selectedConversationId;

  const statusFilterLabels: Record<ConversationBadgeState, string> = {
    aiHandling: t("statusBadge.aiHandling"),
    done: t("statusBadge.done"),
    needsReview: t("statusBadge.needsReview"),
    newContact: t("statusBadge.newContact"),
    humanHandling: t("statusBadge.humanHandling"),
    waitingPatient: t("statusBadge.waitingPatient"),
    problem: t("statusBadge.problem"),
  };

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

  return (
    <div className="space-y-5" data-realtime-status={realtimeStatus}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selecting ? (
            <>
              <span className="text-sm text-muted-foreground" data-testid="bulk-selected-count">
                {t("bulk.selectedCount", { count: selectedIds.length })}
              </span>
              <Button
                size="sm"
                disabled={selectedIds.length === 0}
                onClick={() => setBulkOpen(true)}
                data-testid="bulk-compose"
              >
                <SendHorizonal className="size-4" aria-hidden />
                {t("bulk.compose")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSelecting(false);
                  setSelectedIds([]);
                }}
                data-testid="bulk-cancel"
              >
                {t("bulk.cancel")}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSelecting(true)}
              data-testid="bulk-start-selecting"
            >
              <Users className="size-4" aria-hidden />
              {t("bulk.select")}
            </Button>
          )}
          {/* P17 (§7) — the clinic-wide AI reply setting, where WhatsApp is
              actually read. Same stored value and same action as Settings → Messaging.
              i18n-allow: implementation note inside a JSX comment, never rendered.
              Per-conversation overrides and Pause AI are unchanged and still win
              where they apply. */}
          {/* Admin only, and the server action re-checks the same role. A
              receptionist never sees a control that would refuse them. */}
          {viewerRole === "admin" ? <BulkCloseDialog /> : null}
          <InboxAiRepliesControl
            mode={data.clinicAi?.mode ?? "off"}
            overrideCount={data.clinicAi?.overrideCount ?? 0}
            canManage={viewerRole === "admin"}
          />
          <NewConversationDialog contacts={data.contacts} directory={data.contactDirectory} />
        </div>
      </header>

      {/* H3: the Inbox loaded, but an optional P8 column was not available —
          the window between a deploy and its migration. Contact labels and
          takeover badges are missing; conversations, replies and templates are
          not, and the page says which of the two this is instead of failing
          whole. */}
      {!data.error && data.degraded ? (
        <div
          role="status"
          className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-800 dark:text-amber-300"
        >
          {t("degradedNotice")}
        </div>
      ) : null}

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
          <div className="mt-4">
            <NewConversationDialog contacts={data.contacts} directory={data.contactDirectory} />
          </div>
        </div>
      ) : (
        <div
          className={cn(
            "grid min-h-[36rem] overflow-hidden rounded-xl border bg-card lg:h-[calc(100dvh-13rem)]",
            // The list column is a fixed 22rem at ≥1024 and a slimmer 18rem
            // between 1024 and 1280, where the chat needs the difference more
            // than the list does. Collapsed, the chat takes the whole grid —
            // never by scrolling the page sideways.
            listPaneVisible
              ? "lg:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[22rem_minmax(0,1fr)]"
              : "lg:grid-cols-[minmax(0,1fr)]",
          )}
          data-list-collapsed={listPaneVisible ? "false" : "true"}
        >
          {listPaneVisible ? (
          <aside className="flex min-h-72 flex-col border-b lg:min-h-0 lg:border-b-0 lg:border-e">
            <div className="space-y-2 border-b p-3">
              <form
                className="relative"
                onSubmit={(event) => {
                  event.preventDefault();
                  const params = new URLSearchParams();
                  if (selected?.id) params.set("conversation", selected.id);
                  if (query.trim()) params.set("q", query.trim());
                  router.replace(`/inbox${params.size ? `?${params.toString()}` : ""}`);
                }}
              >
                <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("searchPlaceholder")}
                  className="ps-9 pe-16"
                  aria-label={t("searchLabel")}
                />
                <Button type="submit" variant="ghost" size="sm" className="absolute end-1 top-1/2 -translate-y-1/2">
                  {t("search")}
                </Button>
              </form>
              <div className="flex min-w-0 items-center gap-2">
                <Select
                  value={statusFilter}
                  onValueChange={(value) =>
                    setStatusFilter(value as ConversationBadgeState | "all")
                  }
                >
                  <SelectTrigger
                    size="sm"
                    className="min-w-0 flex-1 sm:max-w-52"
                    aria-label={t("statusFilter.label")}
                  >
                    <SelectValue placeholder={t("statusFilter.label")} />
                  </SelectTrigger>
                  <SelectContent align="start">
                    <SelectItem value="all">{t("statusFilter.all")}</SelectItem>
                    {CONVERSATION_BADGE_STATES.map((state) => (
                      <SelectItem key={state} value={state}>
                        {statusFilterLabels[state]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {statusFilter !== "all" ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    onClick={() => setStatusFilter("all")}
                  >
                    {t("statusFilter.clear")}
                  </Button>
                ) : null}
              </div>
            </div>
            {/* The list pane's scroll container. Named so a test can assert
                the node itself survives a selection — the property the reader's
                scroll position depends on. */}
            <div className="flex-1 overflow-y-auto" data-testid="conversation-list-scroll">
              {filtered.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">{t("noMatches")}</p>
              ) : (
                filtered.map((conversation) => {
                  const name = conversationTitle(conversation, t("unknownSender"));
                  const unread = visibleUnread(conversation);
                  const rowClassName = cn(
                    "flex w-full gap-3 border-b px-3 py-3 text-start transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    selected?.id === conversation.id && "bg-primary/8",
                  );
                  const checked = selectedIds.includes(conversation.id);
                  // P12 — no "AI paused" chip on this row any more. The status
                  // badge beside the name now reads "Active conversation" for
                  // exactly the threads that chip marked, and two chips saying
                  // one thing is the double badge this pass set out to remove.
                  // The thread header keeps it, beside the control that sets it.
                  const body = (
                    <>
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
                        {initials(name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium" dir="auto">
                            {name}
                          </span>
                          <ConversationStatusBadge conversation={conversation} t={t} />
                          {unread > 0 ? <Badge className="ms-auto min-w-5 justify-center px-1.5">{unread}</Badge> : null}
                        </span>
                        <span className="mt-1 block truncate text-xs text-muted-foreground" dir="auto">
                          {conversationPreviewLine(conversation.preview, t)}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          <span>{conversation.assignedName ?? t("unassigned")}</span>
                        </span>
                      </span>
                    </>
                  );
                  // Selection mode swaps navigation for selection on the same
                  // row, rather than adding a second control beside it: in this
                  // mode a click means "choose this thread", and a row that
                  // still navigated away mid-selection would lose the choices.
                  return selecting ? (
                    <button
                      key={conversation.id}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      onClick={() =>
                        setSelectedIds((current) =>
                          current.includes(conversation.id)
                            ? current.filter((id) => id !== conversation.id)
                            : current.length >= MAX_BULK_RECIPIENTS
                              ? current
                              : [...current, conversation.id],
                        )
                      }
                      className={cn(rowClassName, checked && "bg-primary/10")}
                      data-testid="bulk-selectable-row"
                    >
                      <Checkbox
                        checked={checked}
                        tabIndex={-1}
                        aria-hidden
                        className="mt-3 shrink-0 pointer-events-none"
                      />
                      {body}
                    </button>
                  ) : (
                    <Link
                      key={conversation.id}
                      href={`/inbox?conversation=${conversation.id}${data.search ? `&q=${encodeURIComponent(data.search)}` : ""}`}
                      className={rowClassName}
                    >
                      {body}
                    </Link>
                  );
                })
              )}
            </div>
          </aside>
          ) : null}

          {selected ? (
            /*
             * P12 — the remount boundary, moved here from the page.
             *
             * Everything about *one* conversation lives inside this section:
             * the thread, its scroll container, and the composer (which keys
             * itself, and always did). Keying the section is what makes "no
             * state from thread A reaches thread B" a structural property here
             * rather than something each child has to remember.
             *
             * The `<aside>` beside it is about *all* the conversations, so it
             * is deliberately outside this boundary: its scroll container is
             * the same DOM node before and after a selection, which is what
             * keeps the reader where they were in a long list.
             */
            <section key={selected.id} className="flex min-h-[36rem] min-w-0 flex-col">
              {/*
                P18 — the conversation header, laid out so it cannot collide
                with itself.

                The old header was one `flex-wrap` row holding the avatar, the
                name, four badges, the phone number, the WhatsApp name and six
                controls. At full width it fit; at 1440 and below the identity
                text and the buttons competed for the same line and overlapped,
                and the usual reflex — shrink the text — would only have made a
                phone number harder to read.

                Two structural changes instead:

                  * **The identity block has a ceiling.** It is its own column
                    with a `max-w` and truncation on every line, so a long
                    patient name, a long WhatsApp display name and a badge row
                    cannot grow into the actions beside them.
                  * **The actions have a hierarchy.** Pause/Resume AI, the
                    assignment and Close/Reopen stay on the bar because they are
                    what a receptionist reaches for mid-conversation. Everything
                    else moves into one overflow menu — rendered exactly once,
                    never a second copy hidden by a media query, so there is no
                    width at which the same action appears twice.
              */}
              <div className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b px-4 py-3">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  aria-pressed={listCollapsed}
                  onClick={() => setListCollapsed((current) => !current)}
                  title={listCollapsed ? t("layout.showConversations") : t("layout.hideConversations")}
                  data-testid="conversation-list-toggle"
                >
                  {/* The panel glyphs point at the pane they act on, so they
                      flip with the writing direction like every other
                      directional icon in this Inbox. */}
                  {listCollapsed ? (
                    <PanelLeftOpen className="size-4 rtl:-scale-x-100" aria-hidden />
                  ) : (
                    <PanelLeftClose className="size-4 rtl:-scale-x-100" aria-hidden />
                  )}
                  <span className="sr-only">
                    {listCollapsed ? t("layout.showConversations") : t("layout.hideConversations")}
                  </span>
                </Button>
                <span className="hidden size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary sm:flex">
                  {initials(conversationTitle(selected, t("unknownSender")))}
                </span>
                <div className="min-w-0 flex-1 basis-64 xl:max-w-md" data-testid="conversation-identity">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <h2 className="max-w-full truncate font-semibold" dir="auto">
                      {conversationTitle(selected, t("unknownSender"))}
                    </h2>
                    <ConversationStatusBadge conversation={selected} t={t} />
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
                    {selected.aiPausedAt ? (
                      <Badge variant="outline" className="gap-1">
                        <BotOff className="size-3" aria-hidden />
                        {t("ai.pausedBadge")}
                      </Badge>
                    ) : null}
                  </div>
                  {/* The number stays LTR whatever the interface language: a
                      phone number reversed by bidi reordering is a wrong number. */}
                  <p className="truncate text-xs text-muted-foreground" dir="ltr">{selected.sender ?? "—"}</p>
                  {/* P8: once a patient is linked their record is the identity,
                      and the WhatsApp name is kept beside it as context — useful
                      when the two disagree, and never presented as proof. */}
                  {selected.patientName && selected.displayName ? (
                    <p className="truncate text-xs text-muted-foreground" dir="auto">
                      {t("whatsappName")}: {selected.displayName}
                    </p>
                  ) : null}
                </div>

                <div
                  className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-2"
                  data-testid="conversation-actions"
                >
                  <Button
                    variant={selected.aiPausedAt ? "secondary" : "outline"}
                    size="sm"
                    disabled={pending}
                    aria-pressed={Boolean(selected.aiPausedAt)}
                    title={selected.aiPausedAt ? t("ai.resumeAiHint") : t("ai.pauseAiHint")}
                    onClick={() =>
                      runAction(
                        () =>
                          setConversationHumanTakeover({
                            conversationId: selected.id,
                            paused: !selected.aiPausedAt,
                          }),
                        selected.aiPausedAt ? t("ai.resumed") : t("ai.paused"),
                      )
                    }
                  >
                    <BotOff className="size-4" aria-hidden />
                    {selected.aiPausedAt ? t("ai.resumeAi") : t("ai.pauseAi")}
                  </Button>

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
                    <SelectTrigger size="sm" aria-label={t("assignConversation")} className="w-36 min-w-0">
                      <SelectValue placeholder={t("unassigned")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__unassigned__">{t("unassigned")}</SelectItem>
                      {data.assignees.map((assignee) => (
                        <SelectItem key={assignee.id} value={assignee.id}>{assignee.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

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

                  {/* The secondary controls, in one place at every width. A
                      second copy shown only on wide screens would be the same
                      action twice in the accessibility tree and twice in every
                      test that counts it. */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t("layout.moreActions")}
                        data-testid="conversation-more-actions"
                      >
                        <MoreHorizontal className="size-4" aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setPatientDialogOpen(true)}>
                        <CircleUserRound className="size-4" aria-hidden />
                        {selected.patientId ? t("changePatient") : t("linkPatient")}
                      </DropdownMenuItem>
                      {/*
                        P12 — the patient's visits, one click from the thread.

                        Offered only when `patient_id` is actually set on the
                        conversation. An unlinked thread (NEW_CONTACT) has no
                        authoritative history: the control is disabled and says
                        why, rather than disappearing and leaving staff
                        wondering where it went on the one row where they most
                        expect it.
                      */}
                      <DropdownMenuItem
                        disabled={!selected.patientId}
                        data-testid="past-appointments-trigger"
                        onSelect={() => setPastAppointmentsOpen(true)}
                      >
                        <CalendarClock className="size-4" aria-hidden />
                        {selected.patientId
                          ? t("pastAppointments.title")
                          : t("pastAppointments.linkPatientFirst")}
                      </DropdownMenuItem>
                      {/* P15 (§3): per-conversation exception. See ai-enablement.ts */}
                      {selected.aiEnabledOverride !== undefined ? (
                        <DropdownMenuItem
                          disabled={pending}
                          data-testid="conversation-ai-override-action"
                          onSelect={() =>
                            runAction(
                              () =>
                                setConversationAiEnabled({
                                  conversationId: selected.id,
                                  // One click cycles between "the clinic decides"
                                  // and the opposite of whatever the clinic is
                                  // currently doing. Two buttons for three states
                                  // would be a menu; this is the only exception a
                                  // staff member ever wants to make.
                                  override:
                                    selected.aiEnabledOverride !== null
                                      ? null
                                      : !selected.aiEnabled,
                                }),
                              t("ai.aiOverrideUpdated"),
                            )
                          }
                        >
                          <Sparkles className="size-4" aria-hidden />
                          {selected.aiEnabledOverride !== null
                            ? t("ai.followClinicSetting")
                            : selected.aiEnabled
                              ? t("ai.excludeAiHere")
                              : t("ai.allowAiHere")}
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {/* The exception the override writes, stated on the bar
                      itself: a thread the clinic-wide setting no longer governs
                      must say so where staff read the thread, not only inside a
                      menu they have to open. */}
                  {selected.aiEnabledOverride !== undefined && selected.aiEnabledOverride !== null ? (
                    <span
                      className="text-xs text-muted-foreground"
                      data-testid="conversation-ai-override-note"
                    >
                      {selected.aiEnabledOverride
                        ? t("ai.aiAllowedHere")
                        : t("ai.aiExcludedHere")}
                    </span>
                  ) : null}
                </div>

                <Dialog open={patientDialogOpen} onOpenChange={setPatientDialogOpen}>
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

                <PatientAppointmentsDialog
                  conversationId={selected.id}
                  patientId={selected.patientId}
                  patientName={selected.patientName}
                  open={pastAppointmentsOpen}
                  onOpenChange={setPastAppointmentsOpen}
                />
              </div>

              <div className="relative flex flex-1 flex-col overflow-hidden">
              <div
                ref={threadRef}
                onScroll={handleThreadScroll}
                data-testid="inbox-thread"
                className="flex-1 space-y-3 overflow-y-auto bg-muted/20 p-4"
                aria-live="polite"
              >
                {data.messages.length === 0 ? (
                  <p className="py-12 text-center text-sm text-muted-foreground">{t("noMessages")}</p>
                ) : (
                  <>
                  {/* M6: an imported thread can be a year of messages. Only the
                      newest page is serialized into this payload, and staff are
                      told rather than left to assume they are seeing all of it. */}
                  {data.messagesTruncated ? (
                    <p className="pb-2 text-center text-xs text-muted-foreground">
                      {t("olderMessagesTruncated")}
                    </p>
                  ) : null}
                  {data.messages.map((message) => (
                    <div key={message.id} className={cn("flex", message.direction === "outbound" && "justify-end")}>
                      <div className={cn(
                        "max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-xs sm:max-w-[70%]",
                        message.direction === "outbound" ? "rounded-ee-sm bg-primary text-primary-foreground" : "rounded-es-sm border bg-card",
                      )}>
                        {/* P8: the whole message, never a preview and never
                            clamped. `whitespace-pre-wrap` keeps the paragraph
                            breaks a long AI answer relies on, `wrap-anywhere`
                            breaks an unspaced string (a URL, a long Arabic word)
                            instead of letting it widen the bubble, and `dir=auto`
                            lets each message pick its own direction so an Arabic
                            reply reads right-to-left inside an English interface
                            and vice versa. */}
                        {/* P11P: `[image]` is the worker's placeholder for an
                            uncaptioned media message, not something the patient
                            typed. It earns the conversation list its preview
                            line and has no business in the thread, where the
                            media itself is rendered immediately below. When the
                            media is genuinely gone — an imported history row
                            that never carried bytes — the attachment renderer
                            says so specifically, so the placeholder is dropped
                            there too rather than doubling up on the bad news. */}
                        {message.body && !isMediaPlaceholderBody(message.body) ? (
                          <p className="whitespace-pre-wrap break-words wrap-anywhere" dir="auto">
                            {message.body}
                          </p>
                        ) : message.attachments.length === 0 ? (
                          // P16: the media row could not be read or does not
                          // exist. Naming the kind is still the truth of the
                          // message ("a photo arrived") and is strictly more
                          // useful than the blank last-resort line.
                          <p>{conversationPreviewLine(message.body, t)}</p>
                        ) : null}
                        <MessageAttachments
                          attachments={message.attachments}
                          tone={message.direction === "outbound" ? "outbound" : "inbound"}
                        />
                        <div className={cn("mt-1 flex items-center justify-end gap-1 text-[10px]", message.direction === "outbound" ? "text-primary-foreground/70" : "text-muted-foreground")}>
                          <span>{formatInboxTimestamp(new Date(message.occurredAt), locale)}</span>
                          {message.status ? <CheckCheck className="size-3" aria-label={messageStatusLabel(message.status)} /> : null}
                        </div>
                      </div>
                    </div>
                  ))}
                  </>
                )}
              </div>

              {/* The other half of the rule: when the reader is scrolled up,
                  their position is left alone and this is how they learn there
                  is something new — one affordance, dismissed by using it. */}
              {hasNewBelow ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="inbox-new-messages"
                    className="pointer-events-auto shadow-md"
                    onClick={() => scrollToNewest()}
                  >
                    <ArrowDown className="size-4" aria-hidden />
                    {t("newMessagesBelow")}
                  </Button>
                </div>
              ) : null}
              </div>

              <div className="space-y-3 border-t p-3">
                {selected.aiPausedAt ? (
                  <div
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3 text-sm text-sky-900 dark:text-sky-200"
                    data-testid="ai-paused-banner"
                  >
                    <span className="flex items-center gap-2">
                      <BotOff className="size-4 shrink-0" aria-hidden />
                      {selected.aiPausedByName
                        ? t("ai.pausedBannerBy", { name: selected.aiPausedByName })
                        : t("ai.pausedBanner")}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        runAction(
                          () =>
                            setConversationHumanTakeover({
                              conversationId: selected.id,
                              paused: false,
                            }),
                          t("ai.resumed"),
                        )
                      }
                    >
                      {t("ai.resumeAi")}
                    </Button>
                  </div>
                ) : null}

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
                      {suggestion.escalate
                        ? t("ai.suggestionEscalationTitle")
                        : selected.aiPausedAt
                          ? t("ai.suggestionPausedTitle")
                          : t("ai.suggestionTitle")}
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
                      <p className="whitespace-pre-wrap break-words wrap-anywhere text-sm" dir="auto">
                        {suggestion.body}
                      </p>
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
                ) : (
                  <InboxComposer
                    key={selected.id}
                    conversation={selected}
                    templates={data.templates}
                    documents={data.documents}
                    provider={data.whatsappProvider}
                    windowOpen={windowOpen}
                  />
                )}
              </div>
            </section>
          ) : null}
        </div>
      )}
      <BulkSendDialog
        open={bulkOpen}
        onOpenChange={(next) => {
          setBulkOpen(next);
          if (!next) {
            setSelecting(false);
            setSelectedIds([]);
          }
        }}
        recipients={bulkRecipients}
        initialSelectedKeys={initialBulkKeys}
        onSent={() => router.refresh()}
      />
    </div>
  );
}
