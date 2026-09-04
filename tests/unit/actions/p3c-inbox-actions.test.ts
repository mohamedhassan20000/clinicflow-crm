import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMutationRole: vi.fn(),
  requireRole: vi.fn(),
  sendMessage: vi.fn(),
  getActiveWhatsAppProvider: vi.fn(),
  getCurrentLinkedWhatsAppAccount: vi.fn(),
  setInboxConversationPatient: vi.fn(),
  claimOutboundMedia: vi.fn(),
  finalizeOutboundMedia: vi.fn(),
  releaseOutboundMedia: vi.fn(),
  holdOutboundMedia: vi.fn(),
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
  getActiveWhatsAppProvider: mocks.getActiveWhatsAppProvider,
  getCurrentLinkedWhatsAppAccount: mocks.getCurrentLinkedWhatsAppAccount,
  getWhatsAppChannelStatus: vi.fn(),
}));
vi.mock("@/lib/messaging/crypto", () => ({ decryptChannelCredentials: vi.fn() }));
vi.mock("@/lib/messaging/whatsapp-dialog360", () => ({ submitDialog360Template: vi.fn() }));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: mocks.sendMessage }));
vi.mock("@/lib/messaging/outbound-media-diagnostics", () => ({
  logOutboundMediaDiagnostic: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  setInboxConversationPatient: mocks.setInboxConversationPatient,
  claimOutboundMedia: mocks.claimOutboundMedia,
  finalizeOutboundMedia: mocks.finalizeOutboundMedia,
  releaseOutboundMedia: mocks.releaseOutboundMedia,
  holdOutboundMedia: mocks.holdOutboundMedia,
  isSendableStoragePath: () => true,
  WHATSAPP_OUTBOUND_BUCKET: "whatsapp-outbound",
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
  mocks.getActiveWhatsAppProvider.mockResolvedValue("dialog360");
  mocks.getCurrentLinkedWhatsAppAccount.mockResolvedValue(null);
  mocks.setInboxConversationPatient.mockResolvedValue({ data: true, error: null });
  mocks.releaseOutboundMedia.mockResolvedValue({ data: { id: "media-1" }, error: null });
  mocks.holdOutboundMedia.mockResolvedValue({ data: { id: "media-1" }, error: null });
  mocks.finalizeOutboundMedia.mockResolvedValue({ data: true, error: null });
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

  it("manually replies to an unlinked history-only conversation without a patient", async () => {
    mocks.state.results.conversations = {
      data: {
        id: "11111111-1111-4111-8111-111111111111",
        patient_id: null,
        channel: "whatsapp",
        status: "open",
        assigned_to: null,
        participant_address: "+201111111111",
      },
      error: null,
    };
    // A history_chat row can exist without any imported inbound message.
    mocks.state.results.inbound_messages = { data: null, error: null };
    mocks.state.results["conversations.update"] = { data: null, error: null };

    await expect(sendInboxReply({
      conversationId: "11111111-1111-4111-8111-111111111111",
      body: "Manual reply to the WhatsApp contact",
    })).resolves.toEqual({ success: true, outboundMessageId: "out-1" });

    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      recipient: "+201111111111",
      conversationId: "11111111-1111-4111-8111-111111111111",
      body: "Manual reply to the WhatsApp contact",
    }));
  });

  it("allows only the currently authenticated linked account's conversation", async () => {
    mocks.getActiveWhatsAppProvider.mockResolvedValue("linked_device");
    mocks.getCurrentLinkedWhatsAppAccount.mockResolvedValue("+201111111111");
    mocks.state.results.conversations = {
      data: {
        id: "11111111-1111-4111-8111-111111111111",
        channel: "whatsapp",
        status: "open",
        assigned_to: null,
        participant_address: "+209999999999",
        whatsapp_account_id: "+202222222222",
      },
      error: null,
    };
    mocks.state.results.inbound_messages = { data: null, error: null };

    await expect(sendInboxReply({
      conversationId: "11111111-1111-4111-8111-111111111111",
      body: "Must stay in account B",
    })).resolves.toEqual({ error: "messaging.conversationNotFound" });
    expect(mocks.sendMessage).not.toHaveBeenCalled();

    mocks.state.results.conversations = {
      ...mocks.state.results.conversations,
      data: {
        ...(mocks.state.results.conversations.data as Record<string, unknown>),
        whatsapp_account_id: "+201111111111",
      },
    };
    await expect(sendInboxReply({
      conversationId: "11111111-1111-4111-8111-111111111111",
      body: "Account A reply",
    })).resolves.toEqual({ success: true, outboundMessageId: "out-1" });
  });

  it("releases a deterministic media refusal back to draft for the same-object retry", async () => {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const mediaId = "22222222-2222-4222-8222-222222222222";
    mocks.state.results.conversations = {
      data: {
        id: conversationId,
        patient_id: null,
        channel: "whatsapp",
        status: "open",
        assigned_to: null,
        participant_address: "+201111111111",
      },
      error: null,
    };
    mocks.state.results.inbound_messages = { data: null, error: null };
    mocks.claimOutboundMedia.mockResolvedValue({
      data: [{
        media_id: mediaId,
        source: "upload",
        source_record_id: null,
        media_kind: "image",
        mime_type: "image/jpeg",
        file_name: "photo.jpg",
        byte_size: 1024,
        bucket: "whatsapp-outbound",
        storage_path: "clinic-1/2026-08/media.jpg",
        caption: null,
      }],
      error: null,
    });
    mocks.sendMessage.mockResolvedValue({
      ok: false,
      code: "MEDIA_REQUEST_REJECTED",
      outboundMessageId: "out-1",
    });

    await expect(sendInboxReply({
      conversationId,
      body: "",
      mediaId,
    })).resolves.toEqual({
      error: "messaging.mediaRequestRejected",
      mediaRetryable: true,
    });

    expect(mocks.releaseOutboundMedia).toHaveBeenCalledWith({
      clinicId: "clinic-1",
      mediaId,
      failureReason: "media_request_rejected",
    });
    expect(mocks.holdOutboundMedia).not.toHaveBeenCalled();
    expect(mocks.finalizeOutboundMedia).not.toHaveBeenCalled();
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
