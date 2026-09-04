import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11Q — the gates that sit in front of a bulk send.
 *
 * Three things are checked here because all three are refusals that must happen
 * *before* anything is written: the caller's role, the clinic's entitlement, and
 * whether WhatsApp can actually carry the message right now. A job created while
 * the phone is offline would fail fifty times and tell staff nothing they could
 * act on.
 */

const mocks = vi.hoisted(() => ({
  requireMutationRole: vi.fn(async () => ({ clinicId: "clinic-1", id: "user-1" })),
  hasFeature: vi.fn(() => true),
  getEntitlements: vi.fn(async () => ({})),
  getActiveWhatsAppProvider: vi.fn(async () => "linked_device" as string | null),
  readLinkedDeviceSession: vi.fn(async () => ({ status: "connected" })),
  runBulkSendJob: vi.fn(async () => ({ sent: 1, failed: 0, skipped: 0 })),
  inserted: [] as Record<string, unknown>[],
  insertedJobs: [] as Record<string, unknown>[],
  conversations: [] as Record<string, unknown>[],
  logMessagingEvent: vi.fn(async () => ({ error: null })),
}));

vi.mock("@/lib/rbac", () => ({ requireMutationRole: mocks.requireMutationRole, requireRole: vi.fn() }));
vi.mock("@/lib/entitlements", () => ({
  hasFeature: mocks.hasFeature,
  getEntitlements: mocks.getEntitlements,
}));
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
        maybeSingle: async () => ({ data: { id: "job-1", status: "pending" }, error: null }),
        single: async () => ({ data: { id: "job-1" }, error: null }),
        insert(values: Record<string, unknown> | Record<string, unknown>[]) {
          if (table === "bulk_message_jobs") mocks.insertedJobs.push(values as Record<string, unknown>);
          else mocks.inserted.push(...(Array.isArray(values) ? values : [values]));
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve(
            table === "conversations"
              ? { data: mocks.conversations, error: null }
              : { data: [], error: null },
          ).then(resolve),
      };
      return builder;
    },
  }),
}));

import { createBulkSend, runBulkSend } from "@/actions/bulk-messaging";

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inserted = [];
  mocks.insertedJobs = [];
  mocks.requireMutationRole.mockResolvedValue({ clinicId: "clinic-1", id: "user-1" });
  mocks.hasFeature.mockReturnValue(true);
  mocks.getActiveWhatsAppProvider.mockResolvedValue("linked_device");
  mocks.readLinkedDeviceSession.mockResolvedValue({ status: "connected" });
  mocks.conversations = [
    { id: IDS[0], channel: "whatsapp", status: "open", participant_address: "+201111111111" },
    { id: IDS[1], channel: "whatsapp", status: "open", participant_address: "+201222222222" },
  ];
});

describe("P11Q — permissions", () => {
  it("requires the same role a single Inbox reply requires", async () => {
    await createBulkSend({ body: "Closed tomorrow.", conversationIds: IDS });
    expect(mocks.requireMutationRole).toHaveBeenCalledWith(["admin", "receptionist"]);
  });

  it("records the staff member who initiated the send", async () => {
    await createBulkSend({ body: "Closed tomorrow.", conversationIds: IDS });
    expect(mocks.insertedJobs[0]).toMatchObject({ created_by: "user-1", clinic_id: "clinic-1" });
  });

  it("writes an audit row naming the initiator, with no message body", async () => {
    await createBulkSend({ body: "Closed tomorrow.", conversationIds: IDS });
    expect(mocks.logMessagingEvent).toHaveBeenCalledTimes(1);
    const [entry] = mocks.logMessagingEvent.mock.calls[0] as unknown as [
      { clinicId: string; event: string; recordId: string; summary: Record<string, unknown> },
    ];
    expect(entry.event).toBe("bulk_send_created");
    expect(entry.summary).toMatchObject({ initiatedBy: "user-1", recipientCount: 2 });
    // The audit trail must not carry what was said to patients.
    expect(JSON.stringify(entry.summary)).not.toContain("Closed tomorrow.");
  });

  it("stores no clinical data on the job", async () => {
    await createBulkSend({ body: "Closed tomorrow.", conversationIds: IDS });
    expect(Object.keys(mocks.insertedJobs[0]!)).toEqual(
      expect.not.arrayContaining(["patient_id", "diagnosis", "notes"]),
    );
  });

  it("refuses when the clinic's plan does not include WhatsApp", async () => {
    mocks.hasFeature.mockReturnValue(false);
    const result = await createBulkSend({ body: "Hello", conversationIds: IDS });
    expect(result.error).toBeTruthy();
    expect(mocks.insertedJobs).toHaveLength(0);
  });
});

describe("P11Q — offline WhatsApp", () => {
  it("refuses to create a job when the linked device is not connected", async () => {
    mocks.readLinkedDeviceSession.mockResolvedValue({ status: "disconnected" });
    const result = await createBulkSend({ body: "Hello", conversationIds: IDS });
    expect(result.error).toBe("messaging.bulkWhatsAppOffline");
    // Nothing written: staff get one clear sentence instead of fifty failures.
    expect(mocks.insertedJobs).toHaveLength(0);
    expect(mocks.inserted).toHaveLength(0);
  });

  it("refuses to run an existing job while WhatsApp is offline", async () => {
    mocks.readLinkedDeviceSession.mockResolvedValue({ status: "disconnected" });
    const result = await runBulkSend({ jobId: "11111111-1111-4111-8111-111111111111" });
    expect(result.error).toBe("messaging.bulkWhatsAppOffline");
    expect(mocks.runBulkSendJob).not.toHaveBeenCalled();
  });

  it("refuses when there is no active WhatsApp channel at all", async () => {
    mocks.getActiveWhatsAppProvider.mockResolvedValue(null);
    const result = await createBulkSend({ body: "Hello", conversationIds: IDS });
    expect(result.error).toBe("messaging.bulkWhatsAppOffline");
  });
});

describe("P11Q — creating the plan", () => {
  it("writes a row for every recipient, including the ones it will skip", async () => {
    mocks.conversations = [
      { id: IDS[0], channel: "whatsapp", status: "open", participant_address: "+201111111111" },
      { id: IDS[1], channel: "whatsapp", status: "open", participant_address: null },
    ];
    await createBulkSend({ body: "Closed tomorrow.", conversationIds: IDS });
    expect(mocks.inserted).toHaveLength(2);
    expect(mocks.inserted[0]).toMatchObject({ status: "pending" });
    // The skipped one is written, with its reason, rather than omitted.
    expect(mocks.inserted[1]).toMatchObject({ status: "skipped", failure_code: "no_address" });
  });

  it("creates the job without sending anything", async () => {
    const result = await createBulkSend({ body: "Closed tomorrow.", conversationIds: IDS });
    expect(result.jobId).toBe("job-1");
    expect(mocks.runBulkSendJob).not.toHaveBeenCalled();
  });

  it("rejects an empty message and an empty selection", async () => {
    expect((await createBulkSend({ body: "   ", conversationIds: IDS })).error).toBeTruthy();
    expect((await createBulkSend({ body: "Hello", conversationIds: [] })).error).toBeTruthy();
  });

  it("rejects a selection larger than the operational ceiling", async () => {
    const many = Array.from({ length: 51 }, (_, index) =>
      `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
    );
    const result = await createBulkSend({ body: "Hello", conversationIds: many });
    expect(result.error).toBeTruthy();
    expect(mocks.insertedJobs).toHaveLength(0);
  });
});
