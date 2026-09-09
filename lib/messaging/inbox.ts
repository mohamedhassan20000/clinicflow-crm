import "server-only";
import * as Sentry from "@sentry/nextjs";
import { createSignedAttachmentUrls } from "@/lib/messaging/attachments";
import { getActiveWhatsAppProvider } from "@/lib/messaging/channel-management";
import {
  EMPTY_CONTACT_DIRECTORY,
  loadInboxContactDirectory,
  type InboxContactDirectory,
  type InboxContactOption,
} from "@/lib/messaging/inbox-contacts";
import { effectiveConversationAiEnabled } from "@/lib/messaging/ai-enablement";
import {
  normalizeClinicAiReplyMode,
  type ClinicAiReplyMode,
} from "@/lib/ai/patient-reply-mode";
import { isTemplateUsableForWhatsAppProvider } from "@/lib/messaging/provider-policy";
import { loadAccountScopedInboxThread } from "@/lib/messaging/inbox-thread";
import { signSendableMediaUrls } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { AuthedUser } from "@/lib/rbac";
import type { Database, Json } from "@/types/database";

export type InboxConversation = {
  id: string;
  channel: Database["public"]["Enums"]["message_channel"];
  status: Database["public"]["Enums"]["conversation_status"];
  patientId: string | null;
  patientName: string | null;
  patientPhone: string | null;
  patientFileNumber: string | null;
  /**
   * P8: the name WhatsApp reports for this contact. Shown when no patient is
   * linked, and kept as secondary context once one is — it is a label the
   * contact chose, never evidence of who they are.
   */
  displayName: string | null;
  sender: string | null;
  assignedTo: string | null;
  assignedName: string | null;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  windowExpiresAt: string | null;
  identityVerifiedAt: string | null;
  escalatedAt: string | null;
  escalationReason: string | null;
  /**
   * P11P: true when an outbound message on this thread is recorded as failed.
   * The single input to the "Problem" badge — a real delivery failure, never an
   * inference about how the AI behaved.
   */
  hasDeliveryFailure?: boolean;
  /**
   * P11T: true when the thread has an active conversation episode, false when
   * it is resting, and `undefined` when the column could not be read (the
   * window between this deploy and its migration). `undefined` is *not* false:
   * the badge falls back to its pre-P11T derivation rather than relabelling
   * every open thread Done.
   */
  hasActiveEpisode?: boolean;
  /**
   * `conversations.status_updated_at` and `conversations.ai_context_reset_at`.
   *
   * The pair that dates the explicit Open/Closed column against the last
   * episode ending, so an absent episode pointer cannot overrule a thread a
   * staff member has just reopened — or a clinic whose assistant never opened
   * an episode in the first place. `undefined` on either means the column was
   * not readable and the pre-existing derivation stands unchanged. See
   * `lib/messaging/conversation-status.ts`.
   */
  statusUpdatedAt?: string | null;
  contextResetAt?: string | null;
  /** P8: non-null while a staff member has taken this thread over from the AI. */
  aiPausedAt: string | null;
  aiPausedByName: string | null;
  /**
   * P15: `conversations.ai_technical_failure_at` — the assistant hit a genuine
   * technical fault on a live turn. The second input to the "Problem" status.
   */
  aiTechnicalFailureAt?: string | null;
  /**
   * P15: the per-conversation exception to the clinic-wide AI setting.
   * `null` follows the clinic; `undefined` means the column was not readable.
   */
  aiEnabledOverride?: boolean | null;
  /**
   * P15: whether the assistant may answer this thread right now — the clinic
   * setting resolved against the exception and the takeover. Derived once,
   * server-side, by `lib/messaging/ai-enablement.ts`.
   */
  aiEnabled?: boolean;
  /**
   * P15: the episode created a staged patient file, a booking request, or
   * both, and a person at the clinic has not reviewed it yet. One boolean
   * because one badge — "both" is not twice as reviewable.
   */
  hasOutstandingReview?: boolean;
  /**
   * P15: when the assistant last spoke inside the current episode. Null means
   * it has not spoken yet, which is what keeps an unlinked thread on "New
   * contact" only until the assistant actually answers it.
   */
  lastAssistantReplyAt?: string | null;
  /**
   * P15: when a person at this clinic last replied, live. A reply sent from
   * ClinicFlow and the live echo of one typed on the clinic's handset both
   * count; a message replayed by the history import never does.
   */
  lastHumanReplyAt?: string | null;
  preview: string;
  unreadCount: number;
};

export type InboxSuggestion = {
  id: string;
  conversationId: string;
  body: string;
  escalate: boolean;
  escalationReason: string | null;
  createdAt: string;
};

/**
 * P8: one file a patient sent, as the Inbox needs it.
 *
 * `url` is a short-lived signed link minted server-side for the viewer's own
 * clinic; it is null for anything that was refused, failed, or whose bytes are no
 * longer retrievable, and the UI shows the reason instead of a broken image.
 */
export type InboxAttachment = {
  id: string;
  mediaKind: "image" | "document" | "audio" | "video" | "unsupported";
  voiceNote: boolean;
  durationSeconds: number | null;
  mimeType: string;
  fileName: string | null;
  byteSize: number;
  status: "stored" | "rejected" | "failed";
  failureReason: string | null;
  url: string | null;
};

export type InboxThreadMessage = {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  occurredAt: string;
  status: Database["public"]["Enums"]["outbound_message_status"] | null;
  templateId: string | null;
  attachments: InboxAttachment[];
};

export type InboxPersonOption = {
  id: string;
  name: string;
};

export type InboxPatientOption = InboxPersonOption & {
  phone: string;
  fileNumber: string;
};

export type InboxTemplate = {
  id: string;
  name: string;
  language: string;
  body: string;
  variableNames: string[];
  approvalStatus: Database["public"]["Enums"]["template_approval_status"];
};

/**
 * Re-exported so existing importers keep one name for it. The definition, and
 * the linkage rule that fills its patient fields, live in inbox-contacts.ts.
 */
export type { InboxContactDirectory, InboxContactOption };

export type InboxDocumentOption = {
  id: string;
  source: "patient_document" | "clinic_document";
  label: string;
  fileName: string;
  mimeType: string;
  byteSize: number | null;
};

export type InboxData = {
  conversations: InboxConversation[];
  messages: InboxThreadMessage[];
  assignees: InboxPersonOption[];
  patients: InboxPatientOption[];
  templates: InboxTemplate[];
  contacts: InboxContactOption[];
  /**
   * Counts and grouping for the New Conversation directory: how many contacts
   * the authenticated WhatsApp account has synced in total, and how many of
   * them are already a patient file here.
   */
  contactDirectory?: InboxContactDirectory;
  documents: InboxDocumentOption[];
  whatsappProvider: Database["public"]["Enums"]["messaging_provider"] | null;
  /**
   * P17 (§7) — the clinic-wide WhatsApp AI reply setting, so the Inbox header
   * can show and change it without inventing a second source of truth.
   *
   * `mode` is `clinics.ai_reply_mode` exactly as stored and normalized by
   * `normalizeClinicAiReplyMode` — the same value `resolveEffectiveConversationAi`
   * and the Settings card read, and the same value `setPatientAiReplyMode`
   * writes. `overrideCount` is how many of this clinic's conversations carry an
   * explicit `ai_enabled_override`, so a header that says "AI replies: Off"
   * never implies that every single thread is silent when some are not.
   *
   * Optional for the same reason `contactDirectory` is: a caller assembling an
   * `InboxData` by hand must not be forced to state a clinic setting it has no
   * opinion about. Consumers read it through the same `off` / no-overrides
   * default `emptyInbox` writes.
   */
  clinicAi?: { mode: ClinicAiReplyMode; overrideCount: number };
  search: string;
  suggestion: InboxSuggestion | null;
  selectedConversationId: string | null;
  loadedAt: string;
  error: boolean;
  /**
   * P11S: which read produced {@link error}, as a stable label.
   *
   * The Inbox failed for four hours behind a bare boolean. `summaries` is the
   * conversation-list RPC, `thread` the open thread's messages, and so on — no
   * patient content, no SQL, nothing that is not already a name in this file.
   * Null whenever `error` is false.
   */
  errorSource?: InboxErrorSource | null;
  /**
   * P8/M6: the open thread was cut to its newest {@link THREAD_PAGE_SIZE}
   * messages per direction. Before history import a thread was however much
   * traffic had arrived since the clinic joined; after one it can be a year of
   * messages, serialized into the RSC payload on every visit and every refresh.
   */
  messagesTruncated: boolean;
  /**
   * P8/H3: the page loaded, but one or more *optional* P8 columns were not
   * available from the database — the window between a deploy and its migration,
   * or a rollback. Display names and takeover badges are missing; conversations,
   * messages, replies and templates are not.
   */
  degraded: boolean;
};

/** Newest messages kept per direction on the open thread. */
export const THREAD_PAGE_SIZE = 150;

/**
 * P8/H3 — is this error "that column does not exist here (yet)"?
 *
 * The Inbox must survive the minutes between a build landing and its migration
 * applying, because the alternative — what the P8 review caught in production —
 * is a total red-box failure of the page for every clinic over three decorative
 * columns that all have null-safe consumers.
 *
 * Deliberately narrow. `42703` is Postgres' undefined_column; `PGRST204` is
 * PostgREST's schema-cache equivalent for a column it cannot find. Anything else
 * — a permission denied, an RLS refusal, a connection failure, a constraint
 * error — is a real fault and still fails the page loudly, because silently
 * showing an empty Inbox for a security error is its own defect.
 */
function isMissingColumnError(
  error: { code?: string | null; message?: string | null } | null,
): boolean {
  if (!error) return false;
  return error.code === "42703" || error.code === "PGRST204";
}

/**
 * P11S — the reads whose failure takes the whole Inbox down, named.
 *
 * Every one of these is essential: without it there is no conversation list or
 * no thread, and rendering a plausible-looking empty Inbox over a real failure
 * would be worse than saying so. Optional reads set `degraded` instead and are
 * deliberately absent from this union.
 */
export type InboxErrorSource =
  | "summaries"
  | "assignees"
  | "patients"
  | "templates"
  | "contacts"
  | "conversation_meta"
  | "conversation_meta_p8"
  | "thread"
  | "thread_outbound_body"
  | "linked_patients";

type SummaryRow =
  Database["public"]["Functions"]["get_inbox_conversation_summaries"]["Returns"][number];

function variableNames(value: Json): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

/** The Postgres error shape every failing read here reports. */
type ReadError = { code?: string | null; message?: string | null } | null;

function emptyInbox(
  error: boolean,
  source: InboxErrorSource | null = null,
  cause: ReadError = null,
): InboxData {
  if (error && source) {
    // Labels only. The Inbox is the one page a clinic runs its day from, and
    // "it could not be loaded" with no recorded reason is how P11S went four
    // hours before anyone could name the statement timeout underneath it.
    //
    // P11T adds the SQLSTATE, because the source label alone was not enough a
    // second time: P11S recorded `summaries` and left the next investigation to
    // guess between a timeout, a permission refusal and a schema drift — three
    // different faults with three different fixes. `57014` says "starved",
    // `42501` says "authorization", `42703` says "the migration has not landed".
    // The code is a five-character enum from Postgres and carries no patient
    // content, no SQL and no identifiers.
    Sentry.captureMessage("inbox_load_failed", {
      level: "error",
      tags: { area: "inbox", source, sqlstate: cause?.code ?? "unknown" },
    });
  }
  return {
    conversations: [],
    messages: [],
    assignees: [],
    patients: [],
    templates: [],
    contacts: [],
    contactDirectory: EMPTY_CONTACT_DIRECTORY,
    documents: [],
    whatsappProvider: null,
    // An Inbox that failed to load makes no claim about the clinic's AI
    // setting. `off` with no overrides is the honest, least-surprising reading,
    // and the header renders the control disabled in this state anyway.
    clinicAi: { mode: "off", overrideCount: 0 },
    search: "",
    suggestion: null,
    selectedConversationId: null,
    loadedAt: new Date().toISOString(),
    error,
    errorSource: error ? source : null,
    messagesTruncated: false,
    degraded: false,
  };
}

function requestedUuid(value: string | undefined): string | null {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

/** Conversation rows fetched for the list. Bounded by the RPC at 300. */
export const CONVERSATION_PAGE_SIZE = 100;

/**
 * P11P: how many recent outbound rows are scanned to decide the "Problem" badge
 * for a page of conversations.
 *
 * The scan only needs the newest row per conversation, so this is a bound on
 * how lopsided a page may be before the quietest threads at the bottom stop
 * being classified — they fall back to their non-failure state, which is the
 * safe direction to be wrong in. Comfortably above CONVERSATION_PAGE_SIZE so an
 * ordinary page is covered several times over.
 */
export const OUTBOUND_STATUS_SCAN_LIMIT = 600;

/**
 * The optional per-conversation columns, read as wide as the schema allows.
 *
 * P8/H3 established that these columns must never take the Inbox down: they
 * feed a contact label and a takeover badge, and every consumer null-coalesces.
 * P11T adds `current_episode_id` to the same read, which reintroduces the
 * original hazard in a new place — a build that ships before its migration
 * would ask for a column that does not exist yet and lose the P8 columns along
 * with it, so every clinic would lose display names over a badge.
 *
 * So the wide read is attempted, and a *missing column* — and only that — falls
 * back to the P8 column list. One extra round trip, taken solely in the window
 * between a deploy and its migration, and never again afterwards. Any other
 * error is returned as-is for the caller's existing handling.
 */
async function readOptionalConversationMeta(
  supabase: Awaited<ReturnType<typeof createClient>>,
  clinicId: string,
  conversationIds: string[],
) {
  // P15 widens this read again, for the same reason and with the same
  // discipline: three progressively narrower column lists, each falling back
  // only on a *missing column*. A build ahead of its migration loses the newest
  // badge inputs, never the conversations.
  // The widest tier adds the two columns that date the explicit Open/Closed
  // decision against the last episode ending. Same discipline as every tier
  // below it: a build ahead of its migration loses the pair and the badge falls
  // back to reading the episode pointer alone, never to losing conversations.
  const widest = await supabase
    .from("conversations")
    .select(
      "id, display_name, ai_paused_at, ai_paused_by, current_episode_id, ai_enabled_override, ai_technical_failure_at, status_updated_at, ai_context_reset_at",
    )
    .eq("clinic_id", clinicId)
    .in("id", conversationIds);
  if (!widest.error || !isMissingColumnError(widest.error)) return widest;
  const p15 = await supabase
    .from("conversations")
    .select(
      "id, display_name, ai_paused_at, ai_paused_by, current_episode_id, ai_enabled_override, ai_technical_failure_at",
    )
    .eq("clinic_id", clinicId)
    .in("id", conversationIds);
  if (!p15.error || !isMissingColumnError(p15.error)) return p15;
  const wide = await supabase
    .from("conversations")
    .select("id, display_name, ai_paused_at, ai_paused_by, current_episode_id")
    .eq("clinic_id", clinicId)
    .in("id", conversationIds);
  if (!wide.error || !isMissingColumnError(wide.error)) return wide;
  return supabase
    .from("conversations")
    .select("id, display_name, ai_paused_at, ai_paused_by")
    .eq("clinic_id", clinicId)
    .in("id", conversationIds);
}

/**
 * P15 — which of these threads still owe the clinic a review.
 *
 * Three tables, because the platform genuinely stages three different things
 * and each has its own authoritative review action:
 *
 *   * `ai_patient_intakes` at `pending_review` — a new patient file the
 *     assistant staged and a human has not approved, rejected or dismissed;
 *   * `ai_appointment_requests` at `pending` — a provisional booking for
 *     somebody who has no `patients` row yet, which is how a new or
 *     third-party patient's appointment exists before review;
 *   * `appointments` at `pending` with an `ai_patient_conversation_id` — the
 *     same obligation for a patient the thread is already linked to.
 *
 * A conversation that staged *both* a file and a booking appears in two of
 * these sets and still produces one status, and it keeps producing it until
 * *every* set has let go of it — which is exactly the "do not mark Done until
 * both reviews are satisfied" rule, expressed as set membership rather than as
 * a counter something has to remember to decrement.
 *
 * Read through the caller's own RLS-scoped client: a row this staff member
 * cannot see is a row that cannot put a badge on their Inbox.
 *
 * Never throws. A failure here costs the list one badge, never the list.
 */
async function readOutstandingReviews(
  supabase: Awaited<ReturnType<typeof createClient>>,
  clinicId: string,
  conversationIds: string[],
): Promise<Set<string>> {
  if (conversationIds.length === 0) return new Set();
  const now = new Date().toISOString();
  const [intakes, requests, appointments] = await Promise.all([
    supabase
      .from("ai_patient_intakes")
      .select("conversation_id")
      .eq("clinic_id", clinicId)
      .eq("review_status", "pending_review")
      .in("conversation_id", conversationIds),
    // An expired provisional request is no longer an obligation: nobody can
    // act on it any more, and leaving it as one would pin "Needs human review"
    // to a thread forever.
    supabase
      .from("ai_appointment_requests")
      .select("conversation_id")
      .eq("clinic_id", clinicId)
      .eq("status", "pending")
      .gt("expires_at", now)
      .in("conversation_id", conversationIds),
    supabase
      .from("appointments")
      .select("ai_patient_conversation_id")
      .eq("clinic_id", clinicId)
      .eq("status", "pending")
      .is("deleted_at", null)
      .in("ai_patient_conversation_id", conversationIds),
  ]);
  const outstanding = new Set<string>();
  for (const row of intakes.data ?? []) {
    if (row.conversation_id) outstanding.add(row.conversation_id);
  }
  for (const row of requests.data ?? []) {
    if (row.conversation_id) outstanding.add(row.conversation_id);
  }
  for (const row of appointments.data ?? []) {
    if (row.ai_patient_conversation_id) outstanding.add(row.ai_patient_conversation_id);
  }
  return outstanding;
}

/**
 * P15 — the outbound side of the status derivation, in one read.
 *
 * Rows arrive newest-first, so the first row seen per conversation is that
 * conversation's newest and later rows for it are ignored. Three reductions:
 *
 *   * **delivery failure** — only the *newest* outbound row counts. Any-failure-
 *     ever leaves a red badge on a thread for the rest of its life after one
 *     send that succeeded on retry, which teaches staff to ignore the colour.
 *   * **assistant reply** — an outbound row carrying an `episode_id` was written
 *     by the assistant, because that is the only path that attributes one. The
 *     newest such row *inside the current episode* is what retires "New contact".
 *   * **human reply** — an outbound row with no episode attribution, written
 *     live. Both routes land here identically: a reply typed into ClinicFlow and
 *     the echo of one typed on the clinic's own handset. A row the history
 *     import wrote is excluded by its provenance, which is the whole reason
 *     that column exists.
 *
 * A missing `episode_id`/`ingestion_origin` column (a build ahead of its
 * migration) degrades to the pre-P15 reading rather than to a wrong one: no
 * assistant attribution, and every live-looking outbound treated as ours.
 */
async function readOutboundActivity(
  supabase: Awaited<ReturnType<typeof createClient>>,
  clinicId: string,
  conversationIds: string[],
) {
  const wide = await supabase
    .from("outbound_messages")
    .select("related_id, status, created_at, episode_id, ingestion_origin")
    .eq("clinic_id", clinicId)
    .eq("related_type", "manual")
    .in("related_id", conversationIds)
    .order("created_at", { ascending: false })
    .limit(OUTBOUND_STATUS_SCAN_LIMIT);
  if (!wide.error || !isMissingColumnError(wide.error)) return wide;
  return supabase
    .from("outbound_messages")
    .select("related_id, status, created_at")
    .eq("clinic_id", clinicId)
    .eq("related_type", "manual")
    .in("related_id", conversationIds)
    .order("created_at", { ascending: false })
    .limit(OUTBOUND_STATUS_SCAN_LIMIT);
}

export async function loadInboxData(
  user: AuthedUser,
  requestedConversationId?: string,
  search?: string,
): Promise<InboxData> {
  const supabase = await createClient();
  // Each account-sensitive read resolves and applies the current linked
  // account at its own authorization boundary: the directory for contacts,
  // and the thread loader before its clinic-scoped service read.
  const whatsappProvider = await getActiveWhatsAppProvider(user.clinicId);
  const [
    summaryResult,
    assigneeResult,
    patientResult,
    templateResult,
    contactDirectory,
  ] = await Promise.all([
      supabase.rpc("get_inbox_conversation_summaries", {
        p_requested_conversation_id: requestedUuid(requestedConversationId) ?? undefined,
        // P8B: an imported account brings far more threads than the clinic has
        // ever received live, so the list is both larger and searchable
        // server-side — a thread that scrolls out of the window has to stay
        // reachable.
        p_limit: CONVERSATION_PAGE_SIZE,
        p_search: search?.trim() || undefined,
      }),
      supabase
        .from("profiles")
        .select("id, full_name")
        .eq("clinic_id", user.clinicId)
        .in("role", ["admin", "receptionist"])
        .eq("is_active", true)
        .eq("is_deleted", false)
        .is("deleted_at", null)
        .order("full_name"),
      supabase
        .from("patients")
        .select("id, full_name, phone, file_number")
        .eq("clinic_id", user.clinicId)
        .eq("is_deleted", false)
        .is("deleted_at", null)
        .order("full_name")
        .limit(500),
      supabase
        .from("message_templates")
        .select("id, name, language, body, variables, approval_status")
        .eq("clinic_id", user.clinicId)
        .eq("channel", "whatsapp")
        .order("name"),
      // The directory is its own module because the New Conversation dialog
      // re-fetches it on open — contacts arrive asynchronously from the worker
      // after this page has already rendered — and both entry points must
      // apply the identical account filter and linkage rule.
      loadInboxContactDirectory(user.clinicId),
    ]);

  if (
    summaryResult.error ||
    assigneeResult.error ||
    patientResult.error ||
    templateResult.error ||
    contactDirectory.error
  ) {
    const [source, cause] = summaryResult.error
      ? (["summaries", summaryResult.error] as const)
      : assigneeResult.error
        ? (["assignees", assigneeResult.error] as const)
        : patientResult.error
          ? (["patients", patientResult.error] as const)
          : templateResult.error
            ? (["templates", templateResult.error] as const)
            : (["contacts", null] as const);
    return emptyInbox(true, source, cause);
  }

  const summaryRows = (summaryResult.data ?? []) as SummaryRow[];
  const selectedConversationId =
    (requestedConversationId && summaryRows.some((item) => item.id === requestedConversationId)
      ? requestedConversationId
      : summaryRows[0]?.id) ?? null;

  // P5B (§5.4, §6.2): the summary RPC returns no identity/escalation state, so
  // read those conversation columns directly for the visible threads. RLS keeps
  // this to the caller's clinic and the inbox roles.
  const conversationIds = summaryRows.map((row) => row.id);
  // Two reads, not one, and the split is the whole point (H3). The first asks
  // only for columns that predate P8 — its failure is a real failure. The second
  // asks for the three P8 added, all of which the consumers below already
  // null-coalesce; if the schema does not have them yet the Inbox loses a
  // contact label and a pause badge rather than losing every conversation.
  const [metaResult, p8MetaResult, failureResult] = conversationIds.length
    ? await Promise.all([
        supabase
          .from("conversations")
          .select("id, identity_verified_at, ai_escalated_at, ai_escalation_reason")
          .eq("clinic_id", user.clinicId)
          .in("id", conversationIds),
        // P11T adds `current_episode_id` to this read rather than a fourth
        // query: it is another column of a row already being fetched, and the
        // Inbox's problem is the number of round trips, not their width.
        readOptionalConversationMeta(supabase, user.clinicId, conversationIds),
        // P11P: which of these threads carries a message that never reached the
        // patient — the only input to the "Problem" badge. A third read for the
        // same reason the second one exists: a failure here costs the list one
        // colour, never the list.
        //
        // A conversation is addressed the way the thread query addresses it,
        // through `related_type = 'manual'` + `related_id`; outbound_messages
        // has no conversation column. Automated sends (reminders, invoices)
        // hang off an appointment instead and are correctly out of scope — this
        // badge is about the thread staff are looking at.
        // P15 widens this same scan rather than adding a fourth read. Three
        // facts now come off these rows and all three are per-conversation
        // "newest first" reductions over exactly the rows already being read:
        // whether the newest send failed, when the assistant last spoke inside
        // the current episode, and when a person here last replied live.
        readOutboundActivity(supabase, user.clinicId, conversationIds),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
      ];
  if (metaResult.error) return emptyInbox(true, "conversation_meta", metaResult.error);
  let degraded = false;
  if (p8MetaResult.error) {
    if (!isMissingColumnError(p8MetaResult.error))
      return emptyInbox(true, "conversation_meta_p8", p8MetaResult.error);
    degraded = true;
  }
  const metaById = new Map(
    (metaResult.data ?? []).map((row) => [row.id, row]),
  );
  const p8MetaById = new Map(
    (p8MetaResult.data ?? []).map((row) => [row.id, row]),
  );
  if (failureResult.error) degraded = true;
  /**
   * P11P: a thread is a "Problem" only when its *newest* outbound message
   * failed.
   *
   * Any-failure-ever is the obvious rule and the wrong one: a send that failed
   * once and succeeded on the retry leaves its failed row behind forever, so the
   * thread would wear a red badge for the rest of its life and staff would learn
   * to ignore the colour. Taking the newest row per conversation makes the badge
   * self-healing — the next successful message clears it, which is exactly what
   * a receptionist means when they say the problem is fixed.
   *
   * Rows arrive newest-first, so the first one seen per conversation is that
   * conversation's newest and later rows for it are ignored.
   */
  const conversationsWithFailure = new Set<string>();
  const newestOutboundSeen = new Set<string>();
  /** P15: newest assistant-attributed outbound per conversation. */
  const assistantReplyAt = new Map<string, string>();
  /** P15: newest live, unattributed (i.e. human) outbound per conversation. */
  const humanReplyAt = new Map<string, string>();
  for (const row of failureResult.error ? [] : failureResult.data ?? []) {
    const conversationId = row.related_id;
    if (typeof conversationId !== "string") continue;
    if (!newestOutboundSeen.has(conversationId)) {
      newestOutboundSeen.add(conversationId);
      if (row.status === "failed") conversationsWithFailure.add(conversationId);
    }
    const wide = row as { episode_id?: string | null; ingestion_origin?: string | null };
    const createdAt = typeof row.created_at === "string" ? row.created_at : null;
    if (!createdAt) continue;
    if (wide.episode_id) {
      // The assistant wrote this one. Rows arrive newest-first, so the first
      // attributed row per conversation is the newest and the rest are older.
      if (!assistantReplyAt.has(conversationId)) {
        assistantReplyAt.set(conversationId, createdAt);
      }
      continue;
    }
    // Unattributed. A person wrote it — unless the history import did, in
    // which case it is somebody's reply from months ago and says nothing about
    // who is handling the thread now.
    if (wide.ingestion_origin === "history_sync") continue;
    if (!humanReplyAt.has(conversationId)) humanReplyAt.set(conversationId, createdAt);
  }

  // P15 — the two remaining status inputs. Both are best-effort and neither is
  // allowed to take the Inbox down: a failure costs one badge its precision,
  // which is strictly better than an empty list.
  const [outstandingReviews, clinicAiResult, aiOverrideResult] = await Promise.all([
    readOutstandingReviews(supabase, user.clinicId, conversationIds).catch(
      () => new Set<string>(),
    ),
    supabase.from("clinics").select("ai_reply_mode").eq("id", user.clinicId).maybeSingle(),
    // P17 (§7) — how many threads override the clinic-wide default. Counted
    // over the whole clinic rather than over the visible page, because the
    // header's claim is about the clinic. Head-only, so it costs a count and
    // carries no conversation content. A database without the column answers
    // an error, which reads as zero — the truthful pre-P15 count.
    supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("clinic_id", user.clinicId)
      .not("ai_enabled_override", "is", null),
  ]);
  const clinicAiMode = normalizeClinicAiReplyMode(clinicAiResult.data?.ai_reply_mode);
  const aiOverrideCount = aiOverrideResult.error ? 0 : aiOverrideResult.count ?? 0;

  // M6: newest-first with a bound, then reversed for display. An imported thread
  // can carry a year of messages and this payload is re-serialized on every
  // visit and every realtime refresh.
  const thread = selectedConversationId
    ? await loadAccountScopedInboxThread({
        clinicId: user.clinicId,
        conversationId: selectedConversationId,
        provider: whatsappProvider,
        pageSize: THREAD_PAGE_SIZE,
      })
    : {
        inboundResult: { data: [], error: null },
        outboundResult: { data: [], error: null },
        outboundBodyResult: { data: [], error: null },
        readThreadMedia: async () => ({
          attachmentResult: { data: [], error: null },
          audioMetadataResult: { data: [], error: null },
          outboundMediaResult: { data: [], error: null },
        }),
        error: null,
      };
  if (thread.error || !thread.inboundResult || !thread.outboundResult || !thread.outboundBodyResult) {
    return emptyInbox(true, "thread", thread.error);
  }
  const { inboundResult, outboundResult, outboundBodyResult, readThreadMedia } = thread;

  if (inboundResult.error || outboundResult.error) {
    return emptyInbox(true, "thread", inboundResult.error ?? outboundResult.error);
  }
  if (outboundBodyResult.error) {
    if (!isMissingColumnError(outboundBodyResult.error))
      return emptyInbox(true, "thread_outbound_body", outboundBodyResult.error);
    degraded = true;
  }
  const outboundBodyById = new Map(
    (outboundBodyResult.data ?? []).map((row) => [row.id, row.body]),
  );

  const inboundRows = (inboundResult.data ?? []).slice(0, THREAD_PAGE_SIZE).reverse();
  const outboundRows = (outboundResult.data ?? []).slice(0, THREAD_PAGE_SIZE).reverse();
  const messagesTruncated =
    (inboundResult.data?.length ?? 0) > THREAD_PAGE_SIZE ||
    (outboundResult.data?.length ?? 0) > THREAD_PAGE_SIZE;

  const optionPatients = patientResult.data ?? [];
  const optionPatientIds = new Set(optionPatients.map((patient) => patient.id));
  const missingLinkedPatientIds = [...new Set(
    summaryRows
      .map((row) => row.patient_id)
      .filter((id): id is string => Boolean(id) && !optionPatientIds.has(id!)),
  )];
  const linkedPatientResult = missingLinkedPatientIds.length
    ? await supabase
        .from("patients")
        .select("id, full_name, phone, file_number")
        .eq("clinic_id", user.clinicId)
        .in("id", missingLinkedPatientIds)
    : { data: [], error: null };
  if (linkedPatientResult.error)
    return emptyInbox(true, "linked_patients", linkedPatientResult.error);

  const patientsById = new Map(
    [...optionPatients, ...(linkedPatientResult.data ?? [])].map((patient) => [patient.id, patient]),
  );
  const assigneesById = new Map(
    (assigneeResult.data ?? []).map((assignee) => [assignee.id, assignee.full_name]),
  );

  const conversations = summaryRows.map((row) => {
    const patient = row.patient_id ? patientsById.get(row.patient_id) : null;
    const meta = metaById.get(row.id);
    const p8Meta = p8MetaById.get(row.id);
    return {
      id: row.id,
      channel: row.channel,
      status: row.status,
      patientId: row.patient_id,
      patientName: patient?.full_name ?? null,
      patientPhone: patient?.phone ?? null,
      patientFileNumber: patient?.file_number ?? null,
      sender: row.participant_address,
      assignedTo: row.assigned_to,
      assignedName: row.assigned_to ? assigneesById.get(row.assigned_to) ?? null : null,
      lastMessageAt: row.last_message_at,
      lastInboundAt: row.last_inbound_at,
      windowExpiresAt: row.window_expires_at,
      displayName: p8Meta?.display_name ?? null,
      identityVerifiedAt: meta?.identity_verified_at ?? null,
      escalatedAt: meta?.ai_escalated_at ?? null,
      escalationReason: meta?.ai_escalation_reason ?? null,
      hasDeliveryFailure: conversationsWithFailure.has(row.id),
      hasActiveEpisode:
        p8Meta && "current_episode_id" in p8Meta
          ? p8Meta.current_episode_id !== null
          : undefined,
      statusUpdatedAt:
        p8Meta && "status_updated_at" in p8Meta
          ? (p8Meta.status_updated_at as string | null)
          : undefined,
      contextResetAt:
        p8Meta && "ai_context_reset_at" in p8Meta
          ? (p8Meta.ai_context_reset_at as string | null)
          : undefined,
      aiPausedAt: p8Meta?.ai_paused_at ?? null,
      aiPausedByName: p8Meta?.ai_paused_by
        ? assigneesById.get(p8Meta.ai_paused_by) ?? null
        : null,
      aiTechnicalFailureAt:
        p8Meta && "ai_technical_failure_at" in p8Meta
          ? (p8Meta.ai_technical_failure_at as string | null)
          : undefined,
      aiEnabledOverride:
        p8Meta && "ai_enabled_override" in p8Meta
          ? (p8Meta.ai_enabled_override as boolean | null)
          : undefined,
      // Resolved here, once, by the same module the orchestrator uses. The
      // Inbox never re-derives this from the clinic column and the override
      // itself — that is precisely the duplication P15 exists to remove.
      aiEnabled: effectiveConversationAiEnabled({
        clinicMode: clinicAiMode,
        override:
          p8Meta && "ai_enabled_override" in p8Meta
            ? (p8Meta.ai_enabled_override as boolean | null)
            : null,
        aiPausedAt: p8Meta?.ai_paused_at ?? null,
      }),
      hasOutstandingReview: outstandingReviews.has(row.id),
      lastAssistantReplyAt: assistantReplyAt.get(row.id) ?? null,
      lastHumanReplyAt: humanReplyAt.get(row.id) ?? null,
      preview: row.preview,
      unreadCount: Number(row.unread_count),
    } satisfies InboxConversation;
  });

  const selectedPatientId = conversations.find(
    (conversation) => conversation.id === selectedConversationId,
  )?.patientId;
  const [patientDocumentResult, clinicDocumentResult] = selectedPatientId
    ? await Promise.all([
        supabase
          .from("patient_documents")
          .select("id, label, file_name, mime_type, size_bytes")
          .eq("clinic_id", user.clinicId)
          .eq("patient_id", selectedPatientId)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("documents")
          .select("id, document_number, doc_type")
          .eq("clinic_id", user.clinicId)
          .eq("patient_id", selectedPatientId)
          .eq("status", "issued")
          .not("pdf_storage_path", "is", null)
          .order("issued_at", { ascending: false })
          .limit(100),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
      ];
  // P10 — a document read failure must not empty the Inbox.
  //
  // Both of these are *optional enrichment*: they populate one dropdown. Before
  // this, either failing returned `emptyInbox(true)` — the whole Inbox replaced
  // by an error state, no conversations, no messages, no reply box — because a
  // role whose RLS refuses `documents`, or a transient read failure on one of
  // the two tables, was treated exactly like a failure to load the thread list.
  // The correct degradation is the one the composer already renders: no
  // documents to choose from, with the reason said out loud.
  const documentsUnavailable = Boolean(
    patientDocumentResult.error || clinicDocumentResult.error,
  );
  const documents: InboxDocumentOption[] = documentsUnavailable
    ? []
    : [
    ...(patientDocumentResult.data ?? []).map((document) => ({
      id: document.id,
      source: "patient_document" as const,
      label: document.label || document.file_name,
      fileName: document.file_name,
      mimeType: document.mime_type,
      byteSize: Number(document.size_bytes),
    })),
    ...(clinicDocumentResult.data ?? []).map((document) => ({
      id: document.id,
      source: "clinic_document" as const,
      label: `${document.document_number} · ${document.doc_type}`,
      fileName: `${document.document_number}.pdf`,
      mimeType: "application/pdf",
      byteSize: null,
    })),
  ];

  const suggestionResult = selectedConversationId
    ? await supabase
        .from("ai_suggested_replies")
        .select("id, conversation_id, body, escalate, escalation_reason, created_at")
        .eq("clinic_id", user.clinicId)
        .eq("conversation_id", selectedConversationId)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null, error: null };
  const suggestion: InboxSuggestion | null =
    suggestionResult.data && !suggestionResult.error
      ? {
          id: suggestionResult.data.id,
          conversationId: suggestionResult.data.conversation_id,
          body: suggestionResult.data.body,
          escalate: suggestionResult.data.escalate,
          escalationReason: suggestionResult.data.escalation_reason,
          createdAt: suggestionResult.data.created_at,
        }
      : null;

  // P8: the files on the open thread. Read after the messages so a conversation
  // with no attachments costs nothing extra, and signed one bucket call at a
  // time — the URLs are short-lived and minted for this viewer's clinic only.
  //
  // P16: read through the *account-scoped* reader rather than the authenticated
  // client. Both sides of a thread rendered without their media for the entire
  // life of the linked-account isolation policies, because those policies probe
  // `clinic_channels` — a table `authenticated` may not read at all — and fall
  // back to "legacy NULL account only" when the probe comes back empty. The
  // rows are still bounded to this conversation and to the page of messages
  // being rendered; see `inbox-thread.ts` for why that is the same guarantee.
  const {
    attachmentResult,
    audioMetadataResult,
    outboundMediaResult,
  } = selectedConversationId
    ? await readThreadMedia({
        inboundMessageIds: inboundRows.map((row) => row.id),
        outboundMessageIds: outboundRows.map((row) => row.id),
      })
    : {
        attachmentResult: { data: [], error: null },
        audioMetadataResult: { data: [], error: null },
        outboundMediaResult: { data: [], error: null },
      };
  // H3: the whole table is a P8 addition. Its absence costs the thread its
  // attachment chips, never the thread.
  if (attachmentResult.error) degraded = true;
  const attachmentRows = attachmentResult.error ? [] : attachmentResult.data ?? [];
  if (audioMetadataResult.error) degraded = true;
  const audioMetadataById = new Map(
    (audioMetadataResult.error ? [] : audioMetadataResult.data ?? []).map((row) => [row.id, row]),
  );
  const signedUrls = await createSignedAttachmentUrls(
    user.clinicId,
    // Audio uses the stable, authenticated same-origin endpoint below. Keep
    // short-lived bearer URLs for the existing image/document paths only.
    attachmentRows
      .filter((row) => row.media_kind !== "audio")
      .map((row) => row.storage_path),
  );
  const attachmentsByMessage = new Map<string, InboxAttachment[]>();
  for (const row of attachmentRows) {
    if (!row.inbound_message_id) continue;
    const list = attachmentsByMessage.get(row.inbound_message_id) ?? [];
    const audioMetadata = audioMetadataById.get(row.id);
    list.push({
      id: row.id,
      mediaKind: row.media_kind as InboxAttachment["mediaKind"],
      voiceNote: audioMetadata?.voice_note ?? false,
      durationSeconds: audioMetadata?.duration_seconds ?? null,
      mimeType: row.mime_type,
      fileName: row.original_filename,
      byteSize: row.byte_size,
      status: row.status as InboxAttachment["status"],
      failureReason: row.failure_reason,
      url: row.storage_path
        ? row.media_kind === "audio" && row.status === "stored"
          ? `/api/inbox/voice/${row.id}`
          : signedUrls.get(row.storage_path) ?? null
        : null,
    });
    attachmentsByMessage.set(row.inbound_message_id, list);
  }

  if (outboundMediaResult.error) degraded = true;
  const outboundMediaRows = outboundMediaResult.error ? [] : outboundMediaResult.data ?? [];
  const outboundSignedUrls = await signSendableMediaUrls({
    clinicId: user.clinicId,
    items: outboundMediaRows.map((row) => ({
      bucket: row.bucket,
      storagePath: row.storage_path,
    })),
    // P16 — matched to the inbound TTL in `lib/messaging/attachments.ts`, and
    // for the same reason. `/inbox` is a page staff keep open all day; a
    // ten-minute link meant that the moment outbound media *did* start
    // rendering, every sent photo and PDF on an open tab would 404 a few
    // minutes later with nothing in the UI to explain it.
    expiresInSeconds: 60 * 60,
  });
  const outboundAttachmentsByMessage = new Map<string, InboxAttachment[]>();
  for (const row of outboundMediaRows) {
    if (!row.outbound_message_id) continue;
    const list = outboundAttachmentsByMessage.get(row.outbound_message_id) ?? [];
    list.push({
      id: row.id,
      mediaKind: row.media_kind as InboxAttachment["mediaKind"],
      // P8B only permits audio in this table for voice-note sends.
      voiceNote: row.media_kind === "audio",
      durationSeconds: null,
      mimeType: row.mime_type,
      fileName: row.file_name,
      byteSize: row.byte_size,
      status: row.status === "sent" ? "stored" : "failed",
      failureReason: row.failure_reason,
      url: outboundSignedUrls.get(`${row.bucket}\u0000${row.storage_path}`) ?? null,
    });
    outboundAttachmentsByMessage.set(row.outbound_message_id, list);
  }

  const messages: InboxThreadMessage[] = [
    ...inboundRows
      .filter((message) => message.conversation_id === selectedConversationId)
      .map((message) => ({
        id: message.id,
        direction: "inbound" as const,
        body: message.body,
        occurredAt: message.received_at,
        status: null,
        templateId: null,
        attachments: attachmentsByMessage.get(message.id) ?? [],
      })),
    ...outboundRows
      .filter((message) => message.related_id === selectedConversationId)
      .map((message) => ({
        id: message.id,
        direction: "outbound" as const,
        // P8: the full sent text, with the redacted preview as the fallback —
        // for rows written before this column existed, and (H3) for a schema
        // that does not have the column at all yet.
        body: outboundBodyById.get(message.id) ?? message.body_preview ?? "",
        occurredAt: message.created_at,
        status: message.status,
        templateId: message.template_id,
        attachments: outboundAttachmentsByMessage.get(message.id) ?? [],
      })),
  ].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  return {
    conversations,
    messages,
    assignees: (assigneeResult.data ?? []).map((assignee) => ({
      id: assignee.id,
      name: assignee.full_name,
    })),
    patients: optionPatients.map((patient) => ({
      id: patient.id,
      name: patient.full_name,
      phone: patient.phone,
      fileNumber: patient.file_number,
    })),
    templates: (templateResult.data ?? [])
      .filter((template) =>
        isTemplateUsableForWhatsAppProvider(
          whatsappProvider,
          template.approval_status,
        ),
      )
      .map((template) => ({
        id: template.id,
        name: template.name,
        language: template.language,
        body: template.body,
        variableNames: variableNames(template.variables),
        approvalStatus: template.approval_status,
      })),
    contacts: contactDirectory.contacts,
    contactDirectory,
    documents,
    whatsappProvider,
    clinicAi: { mode: clinicAiMode, overrideCount: aiOverrideCount },
    search: search?.trim() ?? "",
    suggestion,
    selectedConversationId,
    loadedAt: new Date().toISOString(),
    error: false,
    errorSource: null,
    messagesTruncated,
    degraded,
  };
}
