import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  boundary: vi.fn(),
  createAdmin: vi.fn(),
}));

vi.mock("server-only", () => ({}));
/**
 * The account boundary replaced the old `provider` + live-session pair. It is
 * identity state, so it does not move when the linked device drops; the
 * assertions in this file are unchanged, and only the fact's source is.
 */
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

type Filter = [kind: "eq" | "is", column: string, value: unknown];
type Query = { table: string; filters: Filter[] };

function fakeAdmin(input: {
  authorized?: boolean;
  inbound?: Record<string, unknown>[];
  outbound?: Record<string, unknown>[];
}) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const query: Query = { table, filters: [] };
      queries.push(query);
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.select = chain;
      builder.eq = (column: string, value: unknown) => {
        query.filters.push(["eq", column, value]);
        return builder;
      };
      builder.is = (column: string, value: unknown) => {
        query.filters.push(["is", column, value]);
        return builder;
      };
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
        data: table === "inbound_messages" ? input.inbound ?? [] : input.outbound ?? [],
        error: null,
      }).then(resolve, reject);
      return builder;
    },
  };
  return { client, queries };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.boundary.mockResolvedValue({ account: "+201111111111", required: true });
});

describe("account-scoped Inbox thread loading", () => {
  it("returns the persisted linked-device inbound after exact account authorization", async () => {
    const persistedInbound = {
      id: "inbound-live-1",
      conversation_id: "conversation-1",
      body: "first live message",
      sender: "+201000000000",
      received_at: "2026-09-02T15:44:42.000Z",
    };
    const { client, queries } = fakeAdmin({ inbound: [persistedInbound] });
    mocks.createAdmin.mockReturnValue(client);

    const result = await loadAccountScopedInboxThread({
      clinicId: "clinic-1",
      conversationId: "conversation-1",
      provider: "linked_device",
      pageSize: 50,
    });

    expect(result.error).toBeNull();
    expect(result.inboundResult?.data).toEqual([persistedInbound]);
    expect(queries[0]).toEqual({
      table: "conversations",
      filters: [
        ["eq", "clinic_id", "clinic-1"],
        ["eq", "id", "conversation-1"],
        ["eq", "channel", "whatsapp"],
        ["eq", "whatsapp_account_id", "+201111111111"],
      ],
    });
    expect(queries.slice(1).map((query) => query.table)).toEqual([
      "inbound_messages",
      "outbound_messages",
      "outbound_messages",
    ]);
  });

  it("fails closed before creating a service client when the linked account is missing", async () => {
    mocks.boundary.mockResolvedValue({ account: null, required: true });

    const result = await loadAccountScopedInboxThread({
      clinicId: "clinic-1",
      conversationId: "conversation-1",
      provider: "linked_device",
      pageSize: 50,
    });

    expect(result.error?.code).toBe("ACCOUNT_SCOPE_MISMATCH");
    expect(mocks.createAdmin).not.toHaveBeenCalled();
  });

  it("never reads message tables when the conversation is outside the current account", async () => {
    const { client, queries } = fakeAdmin({ authorized: false });
    mocks.createAdmin.mockReturnValue(client);

    const result = await loadAccountScopedInboxThread({
      clinicId: "clinic-1",
      conversationId: "conversation-other-account",
      provider: "linked_device",
      pageSize: 50,
    });

    expect(result.error?.code).toBe("ACCOUNT_SCOPE_MISMATCH");
    expect(queries.map((query) => query.table)).toEqual(["conversations"]);
  });

  it("keeps a clinic with no account boundary at all in the legacy NULL scope", async () => {
    // The only clinic that reads legacy rows: one that has never proved a
    // WhatsApp account and holds no linked-device channel — a Meta Cloud API
    // clinic, or one that has never connected anything.
    mocks.boundary.mockResolvedValue({ account: null, required: false });
    const { client, queries } = fakeAdmin({});
    mocks.createAdmin.mockReturnValue(client);

    await loadAccountScopedInboxThread({
      clinicId: "clinic-1",
      conversationId: "conversation-1",
      provider: "meta",
      pageSize: 50,
    });

    expect(queries[0]?.filters).toContainEqual(["is", "whatsapp_account_id", null]);
  });

  it("keeps the same account scope while the linked device is disconnected", async () => {
    // The reported regression: a dropped socket used to flip the boundary to
    // the legacy NULL scope and fill the Inbox with old imported threads. The
    // boundary is identity, so a disconnected clinic reads exactly the account
    // it read while connected — and never `whatsapp_account_id is null`.
    mocks.boundary.mockResolvedValue({ account: "+201111111111", required: true });
    const { client, queries } = fakeAdmin({});
    mocks.createAdmin.mockReturnValue(client);

    await loadAccountScopedInboxThread({
      clinicId: "clinic-1",
      conversationId: "conversation-1",
      // No transport at all: the linked channel row is gone.
      provider: null,
      pageSize: 50,
    });

    expect(queries[0]?.filters).toContainEqual([
      "eq",
      "whatsapp_account_id",
      "+201111111111",
    ]);
    expect(queries[0]?.filters).not.toContainEqual(["is", "whatsapp_account_id", null]);
  });
});
