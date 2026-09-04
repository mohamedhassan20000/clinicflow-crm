import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P11Q — the guarantees that only hold if the claim really works.
 *
 * The fake database below is deliberately not a stub that returns canned rows:
 * it implements the *one* behaviour the whole design rests on — that
 * `claim_bulk_message_recipient` moves a row to `sending` only from `pending` or
 * `failed`, and returns nothing otherwise. Every duplicate-send scenario in this
 * file is a real race against that rule rather than an assertion about a mock.
 */

type Recipient = {
  id: string;
  job_id: string;
  clinic_id: string;
  conversation_id: string;
  status: "pending" | "sending" | "sent" | "failed" | "skipped" | "review";
  failure_code: string | null;
  outbound_message_id: string | null;
  attempts: number;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
};

type State = {
  jobs: Record<string, { id: string; body: string; status: string; total_recipients: number }>;
  recipients: Recipient[];
  conversations: Record<
    string,
    { id: string; channel: string; status: string; participant_address: string | null }
  >;
};

const CLINIC = "clinic-1";

function matches(row: Record<string, unknown>, filters: [string, unknown][], ins: [string, unknown[]][]) {
  return (
    filters.every(([column, value]) => row[column] === value) &&
    ins.every(([column, values]) => values.includes(row[column] as never))
  );
}

function createFakeDb(state: State) {
  class Query {
    filters: [string, unknown][] = [];
    ins: [string, unknown[]][] = [];
    mode: "select" | "update" | "insert" = "select";
    payload: Record<string, unknown> = {};
    constructor(private table: string) {}

    private rows(): Record<string, unknown>[] {
      if (this.table === "bulk_message_recipients") return state.recipients as never;
      if (this.table === "bulk_message_jobs") return Object.values(state.jobs) as never;
      if (this.table === "conversations") return Object.values(state.conversations) as never;
      return [];
    }
    select() {
      return this;
    }
    update(payload: Record<string, unknown>) {
      this.mode = "update";
      this.payload = payload;
      return this;
    }
    eq(column: string, value: unknown) {
      this.filters.push([column, value]);
      return this;
    }
    in(column: string, values: unknown[]) {
      this.ins.push([column, values]);
      return this;
    }
    order() {
      return this;
    }
    private run() {
      const hits = this.rows().filter((row) => matches(row, this.filters, this.ins));
      if (this.mode === "update") {
        for (const row of hits) Object.assign(row, this.payload);
      }
      return { data: hits, error: null };
    }
    async maybeSingle() {
      const { data } = this.run();
      return { data: data[0] ?? null, error: null };
    }
    then(resolve: (value: { data: unknown; error: null }) => unknown) {
      return Promise.resolve(this.run()).then(resolve);
    }
  }

  return {
    from: (table: string) => new Query(table),
    /**
     * The real claim, faithfully: only a pending or failed row is won, and the
     * winner is moved to `sending` in the same step. A `sent` row matches
     * nothing, which is precisely why retry cannot double-send.
     */
    rpc: async (name: string, args: { p_clinic_id: string; p_recipient_id: string }) => {
      if (name !== "claim_bulk_message_recipient") return { data: null, error: null };
      const row = state.recipients.find(
        (recipient) =>
          recipient.id === args.p_recipient_id && recipient.clinic_id === args.p_clinic_id,
      );
      // 'sending' and 'review' are both excluded: an interrupted recipient is
      // never picked up by an ordinary run, only by an explicit human decision.
      if (!row || (row.status !== "pending" && row.status !== "failed")) {
        return { data: [], error: null };
      }
      row.status = "sending";
      row.attempts += 1;
      row.failure_code = null;
      return {
        data: [{ id: row.id, conversation_id: row.conversation_id, attempts: row.attempts }],
        error: null,
      };
    },
  };
}

const state: State = {
  jobs: {},
  recipients: [],
  conversations: {},
};

vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => createFakeDb(state),
}));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: vi.fn() }));

import { runBulkSendJob } from "@/lib/messaging/bulk-send";

function seed(count: number, overrides: Partial<Recipient> = {}) {
  state.jobs = {
    "job-1": { id: "job-1", body: "Clinic is closed tomorrow.", status: "pending", total_recipients: count },
  };
  state.recipients = [];
  state.conversations = {};
  for (let index = 0; index < count; index += 1) {
    const conversationId = `conversation-${index}`;
    state.conversations[conversationId] = {
      id: conversationId,
      channel: "whatsapp",
      status: "open",
      participant_address: `+2011111111${index}`,
    };
    state.recipients.push({
      id: `recipient-${index}`,
      job_id: "job-1",
      clinic_id: CLINIC,
      conversation_id: conversationId,
      status: "pending",
      failure_code: null,
      outbound_message_id: null,
      attempts: 0,
      sent_at: null,
      created_at: `2026-08-17T09:0${index}:00.000Z`,
      updated_at: "2026-08-17T09:00:00.000Z",
      ...overrides,
    });
  }
}

const noDelay = async () => {};

function okSend(id = "outbound-1") {
  return vi.fn(async (_input: { clinicId: string; conversationId?: string | null; relatedType: string; channelPreference?: readonly string[]; body: string }) => ({
    ok: true as const,
    outboundMessageId: id,
    channel: "whatsapp" as const,
    provider: "whatsapp_linked_device" as never,
    providerMessageId: "wamid.1",
  }));
}

beforeEach(() => {
  state.jobs = {};
  state.recipients = [];
  state.conversations = {};
});

describe("P11Q — a normal bulk send", () => {
  it("sends once per recipient, through the ordinary send path", async () => {
    seed(3);
    const send = okSend();
    const counts = await runBulkSendJob({ clinicId: CLINIC, jobId: "job-1", send, delay: noDelay });
    expect(counts).toEqual({ sent: 3, failed: 0, skipped: 0 });
    expect(send).toHaveBeenCalledTimes(3);
    // Every send is an ordinary manual WhatsApp message on its own conversation.
    for (const call of send.mock.calls) {
      expect(call[0]).toMatchObject({
        clinicId: CLINIC,
        relatedType: "manual",
        channelPreference: ["whatsapp"],
        body: "Clinic is closed tomorrow.",
      });
      expect(call[0].conversationId).toBeTruthy();
    }
    expect(state.jobs["job-1"]!.status).toBe("completed");
  });

  it("handles a job with exactly one recipient", async () => {
    seed(1);
    const counts = await runBulkSendJob({
      clinicId: CLINIC,
      jobId: "job-1",
      send: okSend(),
      delay: noDelay,
    });
    expect(counts).toEqual({ sent: 1, failed: 0, skipped: 0 });
  });

  it("handles a larger batch without exceeding the concurrency bound", async () => {
    seed(25);
    let inFlight = 0;
    let peak = 0;
    const send = vi.fn(async (_input: { clinicId: string }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return {
        ok: true as const,
        outboundMessageId: "outbound-1",
        channel: "whatsapp" as const,
        provider: "whatsapp_linked_device" as never,
        providerMessageId: null,
      };
    });
    const counts = await runBulkSendJob({ clinicId: CLINIC, jobId: "job-1", send, delay: noDelay });
    expect(counts.sent).toBe(25);
    // Backpressure: never a fan-out of twenty-five simultaneous sends.
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe("P11Q — partial success is reported as partial", () => {
  it("records per-recipient outcomes and refuses to call the job completed", async () => {
    seed(3);
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        outboundMessageId: "outbound-1",
        channel: "whatsapp",
        provider: "whatsapp_linked_device",
        providerMessageId: null,
      })
      .mockResolvedValueOnce({ ok: false, code: "SERVICE_WINDOW_CLOSED" })
      .mockResolvedValueOnce({
        ok: true,
        outboundMessageId: "outbound-3",
        channel: "whatsapp",
        provider: "whatsapp_linked_device",
        providerMessageId: null,
      });
    const counts = await runBulkSendJob({
      clinicId: CLINIC,
      jobId: "job-1",
      send: send as never,
      delay: noDelay,
    });
    expect(counts).toEqual({ sent: 2, failed: 1, skipped: 0 });
    expect(state.jobs["job-1"]!.status).toBe("completed_with_failures");
    // The reason is kept, so staff are told what went wrong per recipient.
    const failedRow = state.recipients.find((row) => row.status === "failed");
    expect(failedRow!.failure_code).toBe("SERVICE_WINDOW_CLOSED");
  });

  it("skips an invalid recipient with a reason instead of sending", async () => {
    seed(2);
    state.conversations["conversation-1"]!.participant_address = null;
    const send = okSend();
    const counts = await runBulkSendJob({ clinicId: CLINIC, jobId: "job-1", send, delay: noDelay });
    expect(counts).toEqual({ sent: 1, failed: 0, skipped: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    const skipped = state.recipients.find((row) => row.status === "skipped");
    expect(skipped!.failure_code).toBe("no_address");
  });

  it("re-checks a conversation that closed after it was selected", async () => {
    seed(1);
    state.conversations["conversation-0"]!.status = "closed";
    const send = okSend();
    const counts = await runBulkSendJob({ clinicId: CLINIC, jobId: "job-1", send, delay: noDelay });
    expect(send).not.toHaveBeenCalled();
    expect(counts.skipped).toBe(1);
    expect(state.recipients[0]!.failure_code).toBe("conversation_closed");
  });
});

describe("P11Q — idempotency", () => {
  /** The headline guarantee: retry touches failures only. */
  it("retries only failed recipients and never resends a successful one", async () => {
    seed(3);
    const first = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        outboundMessageId: "outbound-1",
        channel: "whatsapp",
        provider: "whatsapp_linked_device",
        providerMessageId: null,
      })
      .mockResolvedValueOnce({ ok: false, code: "PROVIDER_SEND_FAILED" })
      .mockResolvedValueOnce({
        ok: true,
        outboundMessageId: "outbound-3",
        channel: "whatsapp",
        provider: "whatsapp_linked_device",
        providerMessageId: null,
      });
    await runBulkSendJob({ clinicId: CLINIC, jobId: "job-1", send: first as never, delay: noDelay });
    expect(state.recipients.filter((row) => row.status === "sent")).toHaveLength(2);

    const retry = okSend("outbound-retry");
    const counts = await runBulkSendJob({
      clinicId: CLINIC,
      jobId: "job-1",
      send: retry,
      delay: noDelay,
    });
    // Exactly one send: the failure. The two successes were never offered.
    expect(retry).toHaveBeenCalledTimes(1);
    expect(counts).toEqual({ sent: 3, failed: 0, skipped: 0 });
    expect(state.jobs["job-1"]!.status).toBe("completed");
  });

  it("is a no-op when every recipient already succeeded", async () => {
    seed(2);
    await runBulkSendJob({ clinicId: CLINIC, jobId: "job-1", send: okSend(), delay: noDelay });
    const again = okSend();
    await runBulkSendJob({ clinicId: CLINIC, jobId: "job-1", send: again, delay: noDelay });
    expect(again).not.toHaveBeenCalled();
  });

  /**
   * Double submit: two runs of the same job racing each other. The claim is the
   * only thing standing between this and every patient getting the message
   * twice.
   */
  it("sends once per recipient when the same job is run twice concurrently", async () => {
    seed(5);
    const send = okSend();
    await Promise.all([
      runBulkSendJob({ clinicId: CLINIC, jobId: "job-1", send, delay: noDelay }),
      runBulkSendJob({ clinicId: CLINIC, jobId: "job-1", send, delay: noDelay }),
    ]);
    expect(send).toHaveBeenCalledTimes(5);
    const conversationsSentTo = send.mock.calls.map((call) => (call[0] as never as { conversationId: string }).conversationId);
    expect(new Set(conversationsSentTo).size).toBe(5);
  });

  /**
   * Restart mid-job: rows left `sent` survive, and a fresh process resuming the
   * same job picks up only what was never sent.
   */
  it("resumes after a restart without resending what already went out", async () => {
    seed(4);
    // Simulate a process that got through two recipients before dying.
    state.recipients[0]!.status = "sent";
    state.recipients[0]!.outbound_message_id = "outbound-1";
    state.recipients[1]!.status = "sent";
    state.recipients[1]!.outbound_message_id = "outbound-2";

    const send = okSend("outbound-resume");
    const counts = await runBulkSendJob({ clinicId: CLINIC, jobId: "job-1", send, delay: noDelay });
    expect(send).toHaveBeenCalledTimes(2);
    expect(counts).toEqual({ sent: 4, failed: 0, skipped: 0 });
  });

  /**
   * An ambiguous provider result may already have reached the patient, so it is
   * recorded as sent and never retried. A duplicate WhatsApp message cannot be
   * withdrawn; an uncertain record can still be repaired by the delivery
   * callback.
   */
  it("never retries an ambiguous send", async () => {
    seed(1);
    const send = vi.fn().mockResolvedValue({
      ok: false,
      code: "PROVIDER_SEND_AMBIGUOUS",
      outboundMessageId: "outbound-ambiguous",
    });
    await runBulkSendJob({ clinicId: CLINIC, jobId: "job-1", send: send as never, delay: noDelay });
    expect(state.recipients[0]!.status).toBe("sent");
    expect(state.recipients[0]!.failure_code).toBe("PROVIDER_SEND_AMBIGUOUS");

    const retry = okSend();
    await runBulkSendJob({ clinicId: CLINIC, jobId: "job-1", send: retry, delay: noDelay });
    expect(retry).not.toHaveBeenCalled();
  });
});


describe("P11Q.1 — an interrupted recipient is never picked up automatically", () => {
  it("leaves a row stuck in 'sending' alone", async () => {
    seed(2);
    // Exactly the state a process death leaves behind: claimed, never resolved.
    state.recipients[0]!.status = "sending";
    const send = okSend();
    await runBulkSendJob({ clinicId: CLINIC, jobId: "job-1", send, delay: noDelay });
    expect(send).toHaveBeenCalledTimes(1);
    expect(state.recipients[0]!.status).toBe("sending");
  });

  it("leaves a row awaiting review alone, even on an explicit retry", async () => {
    seed(2);
    state.recipients[0]!.status = "review";
    state.recipients[0]!.failure_code = "interrupted";
    const send = okSend();
    await runBulkSendJob({ clinicId: CLINIC, jobId: "job-1", send, delay: noDelay });
    // Only the healthy recipient is sent to; the reviewed one needs a decision.
    expect(send).toHaveBeenCalledTimes(1);
    expect(state.recipients[0]!.status).toBe("review");
  });

  it("does not count an unresolved interruption as a success", async () => {
    seed(2);
    state.recipients[0]!.status = "sending";
    const counts = await runBulkSendJob({
      clinicId: CLINIC,
      jobId: "job-1",
      send: okSend(),
      delay: noDelay,
    });
    expect(counts.sent).toBe(1);
    expect(state.jobs["job-1"]!.status).not.toBe("completed");
  });
});
