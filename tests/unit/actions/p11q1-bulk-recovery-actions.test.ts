import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11Q.1 — resolving an interrupted recipient.
 *
 * The guarantee under test is narrow and absolute: `resolveInterruptedBulkRecipient`
 * must never release a recipient for resending when an ordinary outbound record
 * exists for it since the claim, because that record is the evidence that
 * WhatsApp may already have delivered the message.
 */

const mocks = vi.hoisted(() => ({
  requireMutationRole: vi.fn(async () => ({ clinicId: "clinic-1", id: "user-1" })),
  getActiveWhatsAppProvider: vi.fn(async () => "linked_device" as string | null),
  readLinkedDeviceSession: vi.fn(async () => ({ status: "connected" })),
  runBulkSendJob: vi.fn(async () => ({ sent: 1, failed: 0, skipped: 0 })),
  logMessagingEvent: vi.fn(async () => ({ error: null })),
  recipient: null as Record<string, unknown> | null,
  outbound: [] as { created_at: string }[],
  rpcCalls: [] as { name: string; args: unknown }[],
  releaseResult: [{ id: "recipient-1" }] as unknown[],
  updates: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/rbac", () => ({ requireMutationRole: mocks.requireMutationRole, requireRole: vi.fn() }));
vi.mock("@/lib/entitlements", () => ({ hasFeature: () => true, getEntitlements: async () => ({}) }));
vi.mock("@/lib/messaging/channel-management", () => ({
  getActiveWhatsAppProvider: mocks.getActiveWhatsAppProvider,
}));
vi.mock("@/lib/messaging/linked-device", () => ({
  readLinkedDeviceSession: mocks.readLinkedDeviceSession,
}));
vi.mock("@/lib/messaging/bulk-send", () => ({ runBulkSendJob: mocks.runBulkSendJob }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/i18n/action-errors", () => ({ actionError: async (key: string) => key }));
vi.mock("@/lib/supabase/admin", () => ({
  logMessagingEvent: mocks.logMessagingEvent,
  createClinicScopedAdminClient: () => ({
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        update(values: Record<string, unknown>) {
          mocks.updates.push({ table, ...values });
          return builder;
        },
        insert: () => builder,
        maybeSingle: async () => ({ data: mocks.recipient, error: null }),
        single: async () => ({ data: { id: "job-1" }, error: null }),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(
            table === "outbound_messages"
              ? { data: mocks.outbound, error: null }
              : { data: [], error: null },
          ).then(resolve),
      };
      return builder;
    },
    rpc: async (name: string, args: unknown) => {
      mocks.rpcCalls.push({ name, args });
      if (name === "release_bulk_recipient_for_retry") {
        return { data: mocks.releaseResult, error: null };
      }
      return { data: [], error: null };
    },
  }),
}));

import { resolveInterruptedBulkRecipient } from "@/actions/bulk-messaging";

const RECIPIENT_ID = "44444444-4444-4444-8444-444444444444";
const CLAIMED = "2026-08-17T09:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpcCalls = [];
  mocks.updates = [];
  mocks.outbound = [];
  mocks.releaseResult = [{ id: RECIPIENT_ID }];
  mocks.recipient = {
    id: RECIPIENT_ID,
    job_id: "job-1",
    conversation_id: "conversation-1",
    status: "review",
    claimed_at: CLAIMED,
  };
  mocks.readLinkedDeviceSession.mockResolvedValue({ status: "connected" });
});

describe("P11Q.1 — the resend guard", () => {
  it("refuses to resend when an outbound message exists since the claim", async () => {
    mocks.outbound = [{ created_at: "2026-08-17T09:00:05.000Z" }];
    const result = await resolveInterruptedBulkRecipient({
      recipientId: RECIPIENT_ID,
      decision: "resend",
    });
    expect(result.error).toBe("messaging.bulkResendWouldDuplicate");
    // Nothing released, nothing sent.
    expect(mocks.rpcCalls.some((call) => call.name === "release_bulk_recipient_for_retry")).toBe(false);
    expect(mocks.runBulkSendJob).not.toHaveBeenCalled();
  });

  it("allows a resend when no outbound record was ever written", async () => {
    mocks.outbound = [];
    const result = await resolveInterruptedBulkRecipient({
      recipientId: RECIPIENT_ID,
      decision: "resend",
    });
    expect(result.success).toBe(true);
    expect(mocks.rpcCalls.some((call) => call.name === "release_bulk_recipient_for_retry")).toBe(true);
    expect(mocks.runBulkSendJob).toHaveBeenCalledTimes(1);
  });

  it("refuses when the claim anchor is missing, rather than guessing", async () => {
    mocks.recipient = { ...mocks.recipient!, claimed_at: null };
    const result = await resolveInterruptedBulkRecipient({
      recipientId: RECIPIENT_ID,
      decision: "resend",
    });
    expect(result.error).toBe("messaging.bulkResendWouldDuplicate");
    expect(mocks.runBulkSendJob).not.toHaveBeenCalled();
  });

  it("refuses to resend while WhatsApp is offline", async () => {
    mocks.readLinkedDeviceSession.mockResolvedValue({ status: "disconnected" });
    const result = await resolveInterruptedBulkRecipient({
      recipientId: RECIPIENT_ID,
      decision: "resend",
    });
    expect(result.error).toBe("messaging.bulkWhatsAppOffline");
    expect(mocks.runBulkSendJob).not.toHaveBeenCalled();
  });
});

describe("P11Q.1 — only a reviewed recipient is resolvable", () => {
  for (const status of ["pending", "sending", "sent", "failed", "skipped"]) {
    it(`refuses to resolve a recipient in '${status}'`, async () => {
      mocks.recipient = { ...mocks.recipient!, status };
      const result = await resolveInterruptedBulkRecipient({
        recipientId: RECIPIENT_ID,
        decision: "resend",
      });
      expect(result.error).toBe("messaging.bulkRecipientNotInReview");
      expect(mocks.runBulkSendJob).not.toHaveBeenCalled();
    });
  }

  /**
   * Two staff resolving the same interrupted recipient at once. The release is
   * conditional on the row still being in review, so the loser sends nothing.
   */
  it("does not send when another request already resolved the recipient", async () => {
    mocks.releaseResult = [];
    const result = await resolveInterruptedBulkRecipient({
      recipientId: RECIPIENT_ID,
      decision: "resend",
    });
    expect(result.error).toBe("messaging.bulkRecipientNotInReview");
    expect(mocks.runBulkSendJob).not.toHaveBeenCalled();
  });
});

describe("P11Q.1 — dismissing an interrupted recipient", () => {
  it("resolves it without sending anything", async () => {
    const result = await resolveInterruptedBulkRecipient({
      recipientId: RECIPIENT_ID,
      decision: "dismiss",
    });
    expect(result.success).toBe(true);
    expect(mocks.runBulkSendJob).not.toHaveBeenCalled();
    expect(mocks.updates[0]).toMatchObject({
      status: "skipped",
      failure_code: "interrupted_dismissed",
    });
  });

  it("requires the same role as sending", async () => {
    await resolveInterruptedBulkRecipient({ recipientId: RECIPIENT_ID, decision: "dismiss" });
    expect(mocks.requireMutationRole).toHaveBeenCalledWith(["admin", "receptionist"]);
  });
});

describe("P11Q.1 — stalled recipients are surfaced, not auto-recovered", () => {
  it("flags stale rows when the job is read, without sending", async () => {
    const { readBulkSendJob } = await import("@/actions/bulk-messaging");
    mocks.recipient = { id: "job-1", status: "running", total_recipients: 2 };
    await readBulkSendJob({ jobId: "11111111-1111-4111-8111-111111111111" });
    const flag = mocks.rpcCalls.find((call) => call.name === "flag_stalled_bulk_recipients");
    expect(flag).toBeTruthy();
    expect(mocks.runBulkSendJob).not.toHaveBeenCalled();
  });
});
