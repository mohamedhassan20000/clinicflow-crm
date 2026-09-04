/**
 * P11S — when the Inbox does fail, it says which read failed.
 *
 * The bug this closes took four hours to name because the page's only signal
 * was `error: true`. The read that was actually failing was the conversation
 * summaries RPC, cancelled by the `authenticated` role's 8 s
 * `statement_timeout` (SQLSTATE 57014) — a failure mode that is invisible from
 * a service-role probe, since `service_role` has no timeout at all.
 *
 * The migration removes the cause. This pins the diagnosis, so the next time
 * an essential read fails the source is on the record instead of being
 * reconstructed from query plans.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpcError: null as { code: string; message: string } | null,
  captured: [] as Array<{ message: string; source: unknown }>,
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

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
  captureMessage: (message: string, context: { tags?: { source?: unknown } }) => {
    mocks.captured.push({ message, source: context?.tags?.source });
  },
}));
vi.mock("@/lib/messaging/attachments", () => ({
  createSignedAttachmentUrls: async () => new Map<string, string>(),
}));
vi.mock("@/lib/messaging/channel-management", () => ({
  getActiveWhatsAppProvider: async () => "linked_device",
  // The Inbox read is scoped to the currently authenticated WhatsApp account,
  // so this is now part of every load.
  getCurrentLinkedWhatsAppAccount: async () => "+201111111111",
}));
vi.mock("@/lib/messaging/inbox-thread", () => ({
  loadAccountScopedInboxThread: async () => ({
    inboundResult: { data: [], error: null },
    outboundResult: { data: [], error: null },
    outboundBodyResult: { data: [], error: null },
    readThreadMedia: async () => ({
      attachmentResult: { data: [], error: null },
      audioMetadataResult: { data: [], error: null },
      outboundMediaResult: { data: [], error: null },
    }),
    error: null,
  }),
}));

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";

function builder() {
  const chain: Record<string, unknown> = {};
  for (const method of ["eq", "in", "is", "order", "limit", "neq", "not"]) {
    chain[method] = () => chain;
  }
  const result = { data: [], error: null };
  chain.maybeSingle = async () => ({ data: null, error: null });
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async () =>
      mocks.rpcError
        ? { data: null, error: mocks.rpcError }
        : {
            data: [
              {
                id: CONVERSATION,
                channel: "whatsapp",
                status: "open",
                patient_id: null,
                participant_address: "+201111111111",
                assigned_to: null,
                last_message_at: "2026-09-01T10:05:00.000Z",
                last_inbound_at: "2026-09-01T10:00:00.000Z",
                window_expires_at: null,
                preview: "مرحبا",
                unread_count: 0,
              },
            ],
            error: null,
          },
    from: () => ({ select: () => builder() }),
  }),
}));

import { loadInboxData } from "@/lib/messaging/inbox";

const user = { id: "user-1", clinicId: CLINIC, role: "admin" } as never;

beforeEach(() => {
  mocks.rpcError = null;
  mocks.captured.length = 0;
});

describe("P11S — Inbox load failure reporting", () => {
  it("names the summaries RPC when the statement timeout cancels it", async () => {
    // Exactly what PostgREST returns when the authenticated role's 8s
    // statement_timeout fires: the shape the Inbox saw in production.
    mocks.rpcError = {
      code: "57014",
      message: "canceling statement due to statement timeout",
    };
    const data = await loadInboxData(user, CONVERSATION);
    expect(data.error).toBe(true);
    expect(data.errorSource).toBe("summaries");
    expect(mocks.captured).toEqual([
      { message: "inbox_load_failed", source: "summaries" },
    ]);
  });

  it("reports no source and raises nothing when the Inbox loads", async () => {
    const data = await loadInboxData(user, CONVERSATION);
    expect(data.error).toBe(false);
    expect(data.errorSource).toBeNull();
    expect(mocks.captured).toEqual([]);
  });
});
