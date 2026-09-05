import "server-only";

import { authorizeAccountScopedConversation } from "@/lib/messaging/conversation-scope";
import type { Database } from "@/types/database";

type ThreadReadError = { code: string; message: string };

/**
 * A read of the media rows belonging to one already-authorized thread page.
 *
 * Only produced by {@link loadAccountScopedInboxThread}, and only after that
 * function has proved the conversation belongs to the clinic's current WhatsApp
 * account — which is the whole reason it is a closure rather than an exported
 * function. There is no way to obtain one for a conversation the account scope
 * has not admitted.
 */
export type ThreadMediaReader = (input: {
  inboundMessageIds: readonly string[];
  outboundMessageIds: readonly string[];
}) => Promise<{
  attachmentResult: {
    data: AttachmentRow[] | null;
    error: ThreadReadError | null;
  };
  audioMetadataResult: {
    data: AudioMetadataRow[] | null;
    error: ThreadReadError | null;
  };
  outboundMediaResult: {
    data: OutboundMediaRow[] | null;
    error: ThreadReadError | null;
  };
}>;

type AttachmentRow = {
  id: string;
  inbound_message_id: string | null;
  media_kind: string;
  mime_type: string;
  original_filename: string | null;
  byte_size: number;
  status: string;
  failure_reason: string | null;
  storage_path: string | null;
};

type AudioMetadataRow = {
  id: string;
  voice_note: boolean | null;
  duration_seconds: number | null;
};

type OutboundMediaRow = {
  id: string;
  outbound_message_id: string | null;
  media_kind: string;
  mime_type: string;
  file_name: string | null;
  byte_size: number;
  bucket: string;
  storage_path: string;
  status: string;
  failure_reason: string | null;
};

/**
 * Reads one Inbox thread only after proving it belongs to the clinic's current
 * WhatsApp account.
 *
 * The list summary is a security-definer RPC, while the old thread read went
 * directly through authenticated table RLS. Production exposed a split-brain
 * result: the summary could see a correctly persisted inbound row but the
 * direct table read returned an empty set. This boundary keeps one source of
 * truth for account ownership and then performs the already-authorized server
 * read with the clinic-scoped service client.
 *
 * No legacy NULL row is ever adopted. A linked-device channel requires an
 * exact `whatsapp_account_id`; non-linked transports require the legacy NULL
 * scope. Any missing identity or mismatch fails closed before a message table
 * is touched.
 */
export async function loadAccountScopedInboxThread(input: {
  clinicId: string;
  conversationId: string;
  provider: Database["public"]["Enums"]["messaging_provider"] | null;
  pageSize: number;
}) {
  const emptyMedia: Awaited<ReturnType<ThreadMediaReader>> = {
    attachmentResult: { data: [], error: null },
    audioMetadataResult: { data: [], error: null },
    outboundMediaResult: { data: [], error: null },
  };
  const refuse = (error: ThreadReadError) => ({
    inboundResult: null,
    outboundResult: null,
    outboundBodyResult: null,
    readThreadMedia: (async () => emptyMedia) as ThreadMediaReader,
    error,
  });

  const scoped = await authorizeAccountScopedConversation({
    clinicId: input.clinicId,
    conversationId: input.conversationId,
    provider: input.provider,
  });
  if (scoped.error) return refuse(scoped.error);
  const client = scoped.client;

  const [inboundResult, outboundResult, outboundBodyResult] = await Promise.all([
    client
      .from("inbound_messages")
      .select("id, conversation_id, body, sender, received_at")
      .eq("clinic_id", input.clinicId)
      .eq("conversation_id", input.conversationId)
      .order("received_at", { ascending: false })
      .limit(input.pageSize + 1),
    client
      .from("outbound_messages")
      .select("id, related_id, body_preview, created_at, status, template_id")
      .eq("clinic_id", input.clinicId)
      .eq("related_type", "manual")
      .eq("related_id", input.conversationId)
      .order("created_at", { ascending: false })
      .limit(input.pageSize + 1),
    client
      .from("outbound_messages")
      .select("id, body")
      .eq("clinic_id", input.clinicId)
      .eq("related_type", "manual")
      .eq("related_id", input.conversationId)
      .order("created_at", { ascending: false })
      .limit(input.pageSize + 1),
  ]);

  /**
   * P16 — the files on the thread, read the same way the thread itself is.
   *
   * These three tables used to be read through the *authenticated* client while
   * the messages beside them came from here, and the split had a consequence
   * nobody could see: `whatsapp_account_isolation_*` (2026-09-07) gates every
   * media row on `exists (select 1 from public.clinic_channels ...)`, and
   * `clinic_channels` has RLS enabled with no policy at all — deny-all for
   * `authenticated` by design, because it holds channel credentials. The probe
   * is therefore always false for a staff session, the predicate falls to its
   * `else whatsapp_account_id is null` branch, and every attachment belonging to
   * the *live* linked account is invisible. Threads rendered; the photo the
   * patient sent, and the image or PDF the clinic sent back, did not.
   *
   * Reading them here fixes that without loosening anything: the conversation
   * has already been proved to be in the current account's scope above, and
   * every read below is bounded to that conversation and to the message ids of
   * the page the caller is about to render.
   */
  const readThreadMedia: ThreadMediaReader = async ({
    inboundMessageIds,
    outboundMessageIds,
  }) => {
    const [attachmentResult, outboundMediaResult] = await Promise.all([
      inboundMessageIds.length
        ? client
            .from("inbound_message_attachments")
            .select(
              "id, inbound_message_id, media_kind, mime_type, original_filename, byte_size, status, failure_reason, storage_path",
            )
            .eq("clinic_id", input.clinicId)
            .eq("conversation_id", input.conversationId)
            .in("inbound_message_id", [...inboundMessageIds])
            .order("created_at", { ascending: true })
        : Promise.resolve({ data: [] as AttachmentRow[], error: null }),
      outboundMessageIds.length
        ? client
            .from("outbound_message_media")
            .select(
              "id, outbound_message_id, media_kind, mime_type, file_name, byte_size, bucket, storage_path, status, failure_reason",
            )
            .eq("clinic_id", input.clinicId)
            .eq("conversation_id", input.conversationId)
            .in("outbound_message_id", [...outboundMessageIds])
            .order("created_at", { ascending: true })
        : Promise.resolve({ data: [] as OutboundMediaRow[], error: null }),
    ]);

    // P8D metadata stays a second, optional read: during a migration rollout an
    // older schema still renders every existing image and document, and only
    // the voice badge and duration are temporarily absent.
    const attachmentIds = (attachmentResult.data ?? []).map((row) => row.id);
    const audioMetadataResult = attachmentIds.length
      ? await client
          .from("inbound_message_attachments")
          .select("id, voice_note, duration_seconds")
          .eq("clinic_id", input.clinicId)
          .in("id", attachmentIds)
      : { data: [] as AudioMetadataRow[], error: null };

    return {
      attachmentResult: attachmentResult as Awaited<
        ReturnType<ThreadMediaReader>
      >["attachmentResult"],
      audioMetadataResult: audioMetadataResult as Awaited<
        ReturnType<ThreadMediaReader>
      >["audioMetadataResult"],
      outboundMediaResult: outboundMediaResult as Awaited<
        ReturnType<ThreadMediaReader>
      >["outboundMediaResult"],
    };
  };

  return { inboundResult, outboundResult, outboundBodyResult, readThreadMedia, error: null };
}
