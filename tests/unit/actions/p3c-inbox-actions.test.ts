import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMutationRole: vi.fn(),
  requireRole: vi.fn(),
  sendMessage: vi.fn(),
  setInboxConversationPatient: vi.fn(),
  revalidatePath: vi.fn(),
  state: {
    results: {} as Record<string, { data: unknown; error: unknown }>,
    updates: [] as Array<{ table: string; payload: unknown; filters: unknown[] }>,
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/i18n/action-errors", () => ({
  actionError: (key: string) => Promise.resolve(key),
}));
vi.mock("@/lib/rbac", () => ({
  requireMutationRole: mocks.requireMutationRole,
  requireRole: mocks.requireRole,
}));
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: vi.fn(),
  hasFeature: vi.fn(),
}));
vi.mock("@/lib/messaging/channel-management", () => ({
  connectDialog360Channel: vi.fn(),
  getWhatsAppChannelStatus: vi.fn(),
}));
vi.mock("@/lib/messaging/crypto", () => ({ decryptChannelCredentials: vi.fn() }));
vi.mock("@/lib/messaging/whatsapp-dialog360", () => ({ submitDialog360Template: vi.fn() }));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: mocks.sendMessage }));

vi.mock("@/lib/supabase/admin", () => ({
  setInboxConversationPatient: mocks.setInboxConversationPatient,
  createClinicScopedAdminClient: () => ({
    from: (table: string) => {
      const filters: unknown[] = [];
      const chain = {
        select: () => chain,
        eq: (...args: unknown[]) => {
          filters.push(["eq", ...args]);
          return chain;
        },
        is: (...args: unknown[]) => {
          filters.push(["is", ...args]);
          return chain;
        },
        order: (...args: unknown[]) => {
          filters.push(["order", ...args]);
          return chain;
        },
        limit: (...args: unknown[]) => {
          filters.push(["limit", ...args]);
          return chain;
        },
        maybeSingle: () => Promise.resolve(mocks.state.results[table] ?? { data: null, error: null }),
        update: (payload: unknown) => {
          mocks.state.updates.push({ table, payload, filters });
          return chain;
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(mocks.state.results[`${table}.update`] ?? { data: null, error: null }).then(resolve),
      };
      return chain;
    },
  }),
}));

import {
  linkConversationPatient,
  sendInboxReply,
  updateConversationAssignment,
} from "@/actions/messaging";

beforeEach(() => {
  mocks.state.results = {};
  mocks.state.updates = [];
  mocks.requireMutationRole.mockResolvedValue({
    id: "receptionist-1",
    clinicId: "clinic-1",
    role: "receptionist",
  });
  mocks.sendMessage.mockResolvedValue({
    ok: true,
    outboundMessageId: "out-1",
    channel: "whatsapp",
    provider: "dialog360",
    providerMessageId: "wamid.out-1",
  });
  mocks.setInboxConversationPatient.mockResolvedValue({ data: true, error: null });
  vi.clearAllMocks();
});

describe("P3C inbox actions", () => {
  it("sends through the shared messaging boundary and claims an unassigned thread", async () => {
    mocks.state.results.conversations = {
      data: { id: "11111111-1111-4111-8111-111111111111", channel: "whatsapp", status: "open", assigned_to: null },
      error: null,
    };
    mocks.state.results.inbound_messages = { data: { sender: "+96551111111" }, error: null };
    mocks.state.results["conversations.update"] = { data: null, error: null };

    const result = await sendInboxReply({
      conversationId: "11111111-1111-4111-8111-111111111111",
      body: "Hello",
    });

    expect(result).toEqual({ success: true, outboundMessageId: "out-1" });
    expect(mocks.requireMutationRole).toHaveBeenCalledWith(["admin", "receptionist"]);
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      clinicId: "clinic-1",
      recipient: "+96551111111",
      conversationId: "11111111-1111-4111-8111-111111111111",
      relatedType: "manual",
      channelPreference: ["whatsapp"],
    }));
    expect(mocks.state.updates).toContainEqual(expect.objectContaining({
      table: "conversations",
      payload: { assigned_to: "receptionist-1" },
    }));
  });

  it("rejects assigning a thread to a role that cannot own the inbox", async () => {
    mocks.state.results.profiles = { data: { id: "doctor-1", role: "doctor" }, error: null };
    await expect(updateConversationAssignment({
      conversationId: "11111111-1111-4111-8111-111111111111",
      assignedTo: "22222222-2222-4222-8222-222222222222",
    })).resolves.toEqual({ error: "messaging.inboxOwnerNotFound" });
    expect(mocks.state.updates).toHaveLength(0);
  });

  it("links a patient through the atomic triage boundary", async () => {
    await expect(linkConversationPatient({
      conversationId: "11111111-1111-4111-8111-111111111111",
      patientId: "22222222-2222-4222-8222-222222222222",
    })).resolves.toEqual({ success: true });
    expect(mocks.setInboxConversationPatient).toHaveBeenCalledWith({
      clinicId: "clinic-1",
      conversationId: "11111111-1111-4111-8111-111111111111",
      patientId: "22222222-2222-4222-8222-222222222222",
    });
  });
});
