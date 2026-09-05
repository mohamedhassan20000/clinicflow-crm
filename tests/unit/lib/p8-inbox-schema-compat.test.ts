import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  /** Which table/column selections the code under test issued, in order. */
  selects: [] as Array<{ table: string; columns: string }>,
  /** `table::columns` prefixes that should answer with a PostgREST error. */
  failures: new Map<string, { code: string; message: string }>(),
  activeProvider: vi.fn(),
  linkedAccount: vi.fn(),
  templates: [] as Array<{
    id: string;
    name: string;
    language: string;
    body: string;
    variables: string[];
    approval_status: "draft" | "submitted" | "approved" | "rejected";
  }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/messaging/account-boundary", () => ({
  resolveWhatsAppAccountBoundary: async () => ({
    account: "+201111111111",
    required: true,
  }),
  boundaryFailsClosed: (value: { account: string | null; required: boolean }) =>
    value.required && value.account === null,
  LEGACY_ACCOUNT_BOUNDARY: { account: null, required: false },
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock("@/lib/messaging/attachments", () => ({
  createSignedAttachmentUrls: async () => new Map<string, string>(),
}));
vi.mock("@/lib/messaging/channel-management", () => ({
  getActiveWhatsAppProvider: mocks.activeProvider,
  getCurrentLinkedWhatsAppAccount: mocks.linkedAccount,
}));
vi.mock("@/lib/messaging/inbox-thread", () => ({
  loadAccountScopedInboxThread: async () => {
    const read = (table: string, columns: string) => {
      mocks.selects.push({ table, columns });
      const key = `${table}::${columns}`;
      const error = [...mocks.failures.entries()].find(([prefix]) =>
        key.startsWith(prefix),
      )?.[1] ?? null;
      return { data: error ? null : rowsFor(table, columns), error };
    };
    return {
      inboundResult: read(
        "inbound_messages",
        "id, conversation_id, body, sender, received_at",
      ),
      outboundResult: read(
        "outbound_messages",
        "id, related_id, body_preview, created_at, status, template_id",
      ),
      outboundBodyResult: read("outbound_messages", "id, body"),
      // P16: the thread's media rows are read through the same account-scoped
      // boundary as its messages, so the compatibility behaviour this suite
      // pins — degrade, never fail — is exercised through this reader.
      readThreadMedia: async () => {
        const attachmentResult = read(
          "inbound_message_attachments",
          "id, inbound_message_id, media_kind, mime_type, original_filename, byte_size, status, failure_reason, storage_path",
        );
        const audioMetadataResult = attachmentResult.error
          ? { data: [], error: null }
          : read("inbound_message_attachments", "id, voice_note, duration_seconds");
        return {
          attachmentResult,
          audioMetadataResult,
          outboundMediaResult: read(
            "outbound_message_media",
            "id, outbound_message_id, media_kind, mime_type, file_name, byte_size, bucket, storage_path, status, failure_reason",
          ),
        };
      },
      error: null,
    };
  },
}));

/**
 * A PostgREST query builder thin enough to be honest about what matters here:
 * which columns were asked for, and what came back.
 */
function builder(table: string, columns: string) {
  const key = `${table}::${columns}`;
  const failure = [...mocks.failures.entries()].find(([prefix]) => key.startsWith(prefix))?.[1];
  const result = failure
    ? { data: null, error: failure }
    : { data: rowsFor(table, columns), error: null };
  const chain: Record<string, unknown> = {};
  for (const method of ["eq", "in", "is", "not", "order", "limit", "neq"]) {
    chain[method] = () => chain;
  }
  chain.maybeSingle = async () => ({ data: null, error: result.error });
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";

function rowsFor(table: string, columns: string): unknown[] {
  if (table === "conversations") {
    return columns.includes("display_name")
      ? [{ id: CONVERSATION, display_name: "Fatima", ai_paused_at: "2026-08-01T00:00:00Z", ai_paused_by: null }]
      : [
          {
            id: CONVERSATION,
            identity_verified_at: null,
            ai_escalated_at: null,
            ai_escalation_reason: null,
          },
        ];
  }
  if (table === "inbound_messages") {
    return [
      {
        id: "in-1",
        conversation_id: CONVERSATION,
        body: "مرحبا",
        sender: "+201111111111",
        received_at: "2026-06-01T10:00:00.000Z",
      },
    ];
  }
  if (table === "outbound_messages") {
    return columns.trim() === "id, body"
      ? [{ id: "out-1", body: "the whole message as it was sent" }]
      : [
          {
            id: "out-1",
            related_id: CONVERSATION,
            body_preview: "the whole message…",
            created_at: "2026-06-01T10:05:00.000Z",
            status: "sent",
            template_id: null,
          },
        ];
  }
  if (table === "message_templates") return mocks.templates;
  if (table === "inbound_message_attachments") {
    return columns.includes("voice_note")
      ? [{ id: "attachment-1", voice_note: false, duration_seconds: null }]
      : [{
          id: "attachment-1",
          inbound_message_id: "in-1",
          media_kind: "image",
          mime_type: "image/jpeg",
          original_filename: "photo.jpg",
          byte_size: 1024,
          status: "stored",
          failure_reason: null,
          storage_path: `${CLINIC}/photo.jpg`,
        }];
  }
  return [];
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async () => ({
      data: [
        {
          id: CONVERSATION,
          channel: "whatsapp",
          status: "open",
          patient_id: null,
          participant_address: "+201111111111",
          assigned_to: null,
          last_message_at: "2026-06-01T10:05:00.000Z",
          last_inbound_at: "2026-06-01T10:00:00.000Z",
          window_expires_at: null,
          preview: "مرحبا",
          unread_count: 0,
        },
      ],
      error: null,
    }),
    from: (table: string) => ({
      select: (columns: string) => {
        mocks.selects.push({ table, columns });
        return builder(table, columns);
      },
    }),
  }),
}));

import { loadInboxData } from "@/lib/messaging/inbox";

const user = { id: "user-1", clinicId: CLINIC, role: "admin" } as never;

/** PostgREST's two ways of saying "there is no such column here". */
const UNDEFINED_COLUMN = { code: "42703", message: 'column conversations.display_name does not exist' };
const SCHEMA_CACHE_MISS = { code: "PGRST204", message: "Could not find the 'body' column" };

beforeEach(() => {
  mocks.selects.length = 0;
  mocks.failures.clear();
  mocks.templates = [];
  mocks.activeProvider.mockResolvedValue("linked_device");
  mocks.linkedAccount.mockResolvedValue("+201111111111");
});

/**
 * P8 review · H3 — the Inbox must degrade, not die, when a P8-only column is
 * missing.
 *
 * The failure this pins: `loadInboxData` fanned out its reads and returned
 * `error: true` if *any* of them failed. P8 added three decorative columns to
 * the conversation metadata read and one to the outbound read — a display name,
 * a pause badge, a fuller body, every one of them already null-coalesced by its
 * consumer — and their absence took the whole page down. That is what happens
 * for the minutes between a build being promoted and its migration applying, and
 * it is what the review caught in production: every clinic's Inbox a red box.
 *
 * The other half of the requirement is just as important: this must not become a
 * blanket catch. A permission error, an RLS refusal or a connection failure has
 * to keep failing loudly, because quietly rendering an empty Inbox over a
 * security error is its own defect.
 */
describe("P8 H3 — Inbox schema compatibility", () => {
  it("loads conversations and messages when the P8 columns are all present", async () => {
    const data = await loadInboxData(user, CONVERSATION);
    expect(data.error).toBe(false);
    expect(data.degraded).toBe(false);
    expect(data.conversations).toHaveLength(1);
    expect(data.conversations[0]?.displayName).toBe("Fatima");
    expect(data.conversations[0]?.aiPausedAt).toBe("2026-08-01T00:00:00Z");
    expect(data.messages.find((message) => message.direction === "outbound")?.body).toBe(
      "the whole message as it was sent",
    );
  });

  it("gets the active provider through the service-role boundary, not the RLS-hidden table", async () => {
    const data = await loadInboxData(user, CONVERSATION);
    expect(mocks.activeProvider).toHaveBeenCalledWith(CLINIC);
    expect(data.whatsappProvider).toBe("linked_device");
    expect(mocks.selects.some((entry) => entry.table === "clinic_channels")).toBe(false);
  });

  it("loads reusable unreviewed templates for linked device but not rejected ones", async () => {
    mocks.templates = [
      { id: "draft", name: "draft", language: "en", body: "Draft", variables: [], approval_status: "draft" },
      { id: "submitted", name: "submitted", language: "en", body: "Submitted", variables: [], approval_status: "submitted" },
      { id: "approved", name: "approved", language: "en", body: "Approved", variables: [], approval_status: "approved" },
      { id: "rejected", name: "rejected", language: "en", body: "Rejected", variables: [], approval_status: "rejected" },
    ];
    const data = await loadInboxData(user, CONVERSATION);
    expect(data.templates.map((template) => template.id)).toEqual([
      "draft",
      "submitted",
      "approved",
    ]);
  });

  it.each(["meta", "dialog360"] as const)(
    "keeps approved-only templates for the %s Cloud API provider",
    async (provider) => {
      mocks.activeProvider.mockResolvedValue(provider);
      mocks.templates = [
        { id: "draft", name: "draft", language: "en", body: "Draft", variables: [], approval_status: "draft" },
        { id: "approved", name: "approved", language: "en", body: "Approved", variables: [], approval_status: "approved" },
      ];
      const data = await loadInboxData(user, CONVERSATION);
      expect(data.templates.map((template) => template.id)).toEqual(["approved"]);
    },
  );

  it("never asks for a P8 column in the same query as a pre-P8 one", async () => {
    await loadInboxData(user, CONVERSATION);
    // The *metadata* reads. P17 added a third `conversations` query — the
    // head-only `count` of clinic-wide AI overrides behind the Inbox header's
    // global switch — which selects no metadata column and cannot participate
    // in the H3 split this test is about. It is excluded by what it asks for
    // rather than by position, so a fourth metadata read would still fail here.
    const conversationReads = mocks.selects.filter(
      (entry) => entry.table === "conversations" && entry.columns.includes(","),
    );
    // The split is the mechanism: one read whose failure is real, one whose
    // failure is cosmetic. Mixing them is what made the page all-or-nothing.
    expect(conversationReads).toHaveLength(2);
    expect(conversationReads.some((entry) => entry.columns.includes("display_name"))).toBe(true);
    expect(
      conversationReads.every(
        (entry) =>
          !(entry.columns.includes("display_name") && entry.columns.includes("identity_verified_at")),
      ),
    ).toBe(true);

    const outboundReads = mocks.selects.filter((entry) => entry.table === "outbound_messages");
    expect(outboundReads.some((entry) => entry.columns.trim() === "id, body")).toBe(true);
    expect(outboundReads.every((entry) => !entry.columns.includes("body_preview, body"))).toBe(true);
  });

  it("still loads the Inbox when the P8 conversation columns do not exist", async () => {
    mocks.failures.set("conversations::id, display_name", UNDEFINED_COLUMN);
    const data = await loadInboxData(user, CONVERSATION);
    expect(data.error).toBe(false);
    expect(data.degraded).toBe(true);
    // The thread, the reply box and the templates all still work.
    expect(data.conversations).toHaveLength(1);
    expect(data.messages.length).toBeGreaterThan(0);
    // Only the decoration is gone.
    expect(data.conversations[0]?.displayName).toBeNull();
    expect(data.conversations[0]?.aiPausedAt).toBeNull();
  });

  it("falls back to the redacted preview when the full outbound body does not exist", async () => {
    mocks.failures.set("outbound_messages::id, body", SCHEMA_CACHE_MISS);
    const data = await loadInboxData(user, CONVERSATION);
    expect(data.error).toBe(false);
    expect(data.degraded).toBe(true);
    // Exactly what the Inbox showed before P8 — not an empty bubble.
    expect(data.messages.find((message) => message.direction === "outbound")?.body).toBe(
      "the whole message…",
    );
  });

  it("degrades when the attachments table itself is missing", async () => {
    mocks.failures.set("inbound_message_attachments::", UNDEFINED_COLUMN);
    const data = await loadInboxData(user, CONVERSATION);
    expect(data.error).toBe(false);
    expect(data.degraded).toBe(true);
    expect(data.messages.length).toBeGreaterThan(0);
  });

  it("keeps existing images when only the P8D audio metadata columns are missing", async () => {
    mocks.failures.set("inbound_message_attachments::id, voice_note", SCHEMA_CACHE_MISS);
    const data = await loadInboxData(user, CONVERSATION);
    expect(data.error).toBe(false);
    expect(data.degraded).toBe(true);
    const inbound = data.messages.find((message) => message.direction === "inbound");
    expect(inbound?.attachments).toEqual([
      expect.objectContaining({
        id: "attachment-1",
        mediaKind: "image",
        voiceNote: false,
        durationSeconds: null,
      }),
    ]);
  });

  it("still fails loudly on a permission error, rather than hiding it", async () => {
    mocks.failures.set("conversations::id, display_name", {
      code: "42501",
      message: "permission denied for table conversations",
    });
    const data = await loadInboxData(user, CONVERSATION);
    // A security error is not a cosmetic one. The page says so.
    expect(data.error).toBe(true);
    expect(data.degraded).toBe(false);
  });

  it("still fails loudly when a pre-P8 read fails", async () => {
    mocks.failures.set("conversations::id, identity_verified_at", UNDEFINED_COLUMN);
    const data = await loadInboxData(user, CONVERSATION);
    expect(data.error).toBe(true);
  });

  it("bounds the thread read and reports when it was cut", async () => {
    const data = await loadInboxData(user, CONVERSATION);
    // The fixture is short, so nothing is truncated — but the flag exists and is
    // wired, which is what the UI's "only the most recent messages" note reads.
    expect(data.messagesTruncated).toBe(false);
  });
});
