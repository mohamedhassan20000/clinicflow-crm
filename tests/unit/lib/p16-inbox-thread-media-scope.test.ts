import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  boundary: vi.fn(),
  createAdmin: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/messaging/account-boundary", () => ({
  resolveWhatsAppAccountBoundary: mocks.boundary,
  boundaryFailsClosed: (value: { account: string | null; required: boolean }) =>
    value.required && value.account === null,
  LEGACY_ACCOUNT_BOUNDARY: { account: null, required: false },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: mocks.createAdmin,
}));

import { loadAccountScopedInboxThread } from "@/lib/messaging/inbox-thread";

/**
 * P16 — the media rows of a thread are read where the thread is read.
 *
 * They were not. `inbound_message_attachments` and `outbound_message_media`
 * came off the *authenticated* client while the messages beside them came off
 * the account-scoped service client, and the restrictive isolation policies
 * added in 2026-09 probe `clinic_channels` — a table `authenticated` is denied
 * outright. The probe is therefore always empty for a staff session, the
 * predicate falls to "legacy NULL account only", and every attachment on a live
 * linked account became invisible: the patient's photo, and the image or PDF
 * the clinic sent back, all rendered as "No message preview".
 */

type Filter = [kind: "eq" | "in", column: string, value: unknown];
type Query = { table: string; columns: string; filters: Filter[] };

function fakeAdmin(input: {
  authorized?: boolean;
  rows?: Record<string, Record<string, unknown>[]>;
}) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const query: Query = { table, columns: "", filters: [] };
      queries.push(query);
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = (columns: string) => {
        query.columns = columns;
        return builder;
      };
      builder.eq = (column: string, value: unknown) => {
        query.filters.push(["eq", column, value]);
        return builder;
      };
      builder.in = (column: string, value: unknown) => {
        query.filters.push(["in", column, value]);
        return builder;
      };
      builder.is = chain;
      builder.order = chain;
      builder.limit = chain;
      builder.maybeSingle = () => Promise.resolve({
        data: input.authorized === false ? null : { id: "conversation-1" },
        error: null,
      });
      builder.then = (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve({
        data: input.rows?.[table] ?? [],
        error: null,
      }).then(resolve, reject);
      return builder;
    },
  };
  return { client, queries };
}

const STORED_IMAGE = {
  id: "attachment-1",
  inbound_message_id: "inbound-1",
  media_kind: "image",
  mime_type: "image/jpeg",
  original_filename: null,
  byte_size: 295_703,
  status: "stored",
  failure_reason: null,
  storage_path: "clinic-1/2026-09/photo.jpg",
};

const SENT_PDF = {
  id: "media-1",
  outbound_message_id: "outbound-1",
  media_kind: "document",
  mime_type: "application/pdf",
  file_name: "referral.pdf",
  byte_size: 676_968,
  bucket: "whatsapp-outbound",
  storage_path: "clinic-1/2026-09/referral.pdf",
  status: "sent",
  failure_reason: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.boundary.mockResolvedValue({ account: "+96555941330", required: true });
});

async function loadThread(rows: Record<string, Record<string, unknown>[]>) {
  const { client, queries } = fakeAdmin({ rows });
  mocks.createAdmin.mockReturnValue(client);
  const thread = await loadAccountScopedInboxThread({
    clinicId: "clinic-1",
    conversationId: "conversation-1",
    provider: "linked_device",
    pageSize: 50,
  });
  return { thread, queries };
}

describe("P16 — account-scoped thread media", () => {
  it("reads a live inbound image through the same scoped client as the messages", async () => {
    const { thread, queries } = await loadThread({
      inbound_message_attachments: [STORED_IMAGE],
    });
    const media = await thread.readThreadMedia({
      inboundMessageIds: ["inbound-1"],
      outboundMessageIds: [],
    });

    expect(media.attachmentResult.error).toBeNull();
    expect(media.attachmentResult.data).toEqual([STORED_IMAGE]);
    // One client for the whole thread: nothing here may fall back to the
    // authenticated table read the isolation policies hide.
    expect(mocks.createAdmin).toHaveBeenCalledTimes(1);
    expect(mocks.createAdmin).toHaveBeenCalledWith("clinic-1");

    const attachmentQuery = queries.find(
      (query) =>
        query.table === "inbound_message_attachments" &&
        query.columns.includes("storage_path"),
    );
    expect(attachmentQuery).toBeDefined();
    // Still bounded to this clinic, this conversation and this page.
    expect(attachmentQuery?.filters).toContainEqual(["eq", "clinic_id", "clinic-1"]);
    expect(attachmentQuery?.filters).toContainEqual([
      "eq",
      "conversation_id",
      "conversation-1",
    ]);
    expect(attachmentQuery?.filters).toContainEqual([
      "in",
      "inbound_message_id",
      ["inbound-1"],
    ]);
  });

  it("reads outbound media for the sent image and PDF the same way", async () => {
    const { thread, queries } = await loadThread({
      outbound_message_media: [SENT_PDF],
    });
    const media = await thread.readThreadMedia({
      inboundMessageIds: [],
      outboundMessageIds: ["outbound-1"],
    });

    expect(media.outboundMediaResult.data).toEqual([SENT_PDF]);
    const outboundQuery = queries.find((query) => query.table === "outbound_message_media");
    expect(outboundQuery?.filters).toContainEqual(["eq", "clinic_id", "clinic-1"]);
    expect(outboundQuery?.filters).toContainEqual([
      "eq",
      "conversation_id",
      "conversation-1",
    ]);
    expect(outboundQuery?.filters).toContainEqual([
      "in",
      "outbound_message_id",
      ["outbound-1"],
    ]);
  });

  it("never reads media for a conversation the account scope refused", async () => {
    const { client, queries } = fakeAdmin({ authorized: false });
    mocks.createAdmin.mockReturnValue(client);
    const thread = await loadAccountScopedInboxThread({
      clinicId: "clinic-1",
      conversationId: "conversation-from-another-account",
      provider: "linked_device",
      pageSize: 50,
    });

    expect(thread.error?.code).toBe("ACCOUNT_SCOPE_MISMATCH");
    const media = await thread.readThreadMedia({
      inboundMessageIds: ["inbound-1"],
      outboundMessageIds: ["outbound-1"],
    });
    expect(media.attachmentResult.data).toEqual([]);
    expect(media.outboundMediaResult.data).toEqual([]);
    expect(
      queries.some((query) =>
        query.table === "inbound_message_attachments" ||
        query.table === "outbound_message_media"
      ),
    ).toBe(false);
  });

  it("costs nothing when the page has no messages on one side", async () => {
    const { thread, queries } = await loadThread({});
    await thread.readThreadMedia({ inboundMessageIds: [], outboundMessageIds: [] });
    expect(
      queries.some((query) =>
        query.table === "inbound_message_attachments" ||
        query.table === "outbound_message_media"
      ),
    ).toBe(false);
  });
});
