import { describe, expect, it } from "vitest";
import {
  BULK_SEND_CONCURRENCY,
  MAX_BULK_RECIPIENTS,
  bulkJobOutcome,
  isRetryableSendFailure,
  planBulkRecipients,
  type BulkPlannableConversation,
} from "@/lib/messaging/bulk-send-plan";

/**
 * P11Q — who gets written to, who does not, and what a finished job is allowed
 * to call itself.
 *
 * These are the decisions that must not need a database to be trusted, because
 * they are the ones a reviewer has to be able to check by reading: a recipient
 * is never silently dropped, an ambiguous send is never retried, and a job that
 * half worked never reports success.
 */

function conversation(
  overrides: Partial<BulkPlannableConversation> = {},
): BulkPlannableConversation {
  return {
    id: "conversation-1",
    channel: "whatsapp",
    status: "open",
    participantAddress: "+201111111111",
    ...overrides,
  };
}

describe("P11Q — planning recipients", () => {
  it("sends to an ordinary open WhatsApp conversation", () => {
    const [plan] = planBulkRecipients([conversation()]);
    expect(plan).toEqual({
      conversationId: "conversation-1",
      send: true,
      recipient: "+201111111111",
    });
  });

  /**
   * The safety requirement, stated as a test: an unreachable recipient produces
   * a *plan entry saying so*, never an absence. A shorter list is
   * indistinguishable from a successful send.
   */
  it("never silently drops a recipient it cannot send to", () => {
    const plans = planBulkRecipients([
      conversation({ id: "a", participantAddress: null }),
      conversation({ id: "b", status: "closed" }),
      conversation({ id: "c", channel: "email" }),
      conversation({ id: "d" }),
    ]);
    expect(plans).toHaveLength(4);
    expect(plans.map((plan) => plan.conversationId)).toEqual(["a", "b", "c", "d"]);
    expect(plans.filter((plan) => !plan.send).map((plan) => plan.send === false && plan.reason))
      .toEqual(["no_address", "conversation_closed", "not_whatsapp"]);
  });

  it("gives every skip an explicit reason", () => {
    for (const conversationRow of [
      conversation({ participantAddress: null }),
      conversation({ participantAddress: "   " }),
      conversation({ status: "closed" }),
      conversation({ channel: "email" }),
    ]) {
      const [plan] = planBulkRecipients([conversationRow]);
      expect(plan!.send).toBe(false);
      expect(plan!.send === false && plan!.reason).toBeTruthy();
    }
  });

  it("collapses a duplicated selection onto one recipient", () => {
    const plans = planBulkRecipients([conversation(), conversation(), conversation()]);
    expect(plans).toHaveLength(1);
  });

  it("keeps the ceiling small enough to be an operations tool, not a campaign tool", () => {
    expect(MAX_BULK_RECIPIENTS).toBeLessThanOrEqual(50);
    expect(BULK_SEND_CONCURRENCY).toBeLessThanOrEqual(5);
  });
});

describe("P11Q — retry eligibility", () => {
  /**
   * The rule that prevents duplicate patient messages. An ambiguous provider
   * result may already have been delivered; a second WhatsApp message cannot be
   * unsent, while an uncertain record can still be repaired by the delivery
   * callback. So ambiguity is never retried.
   */
  it("refuses to retry an ambiguous send", () => {
    expect(isRetryableSendFailure("PROVIDER_SEND_AMBIGUOUS")).toBe(false);
  });

  it("allows retrying ordinary, definite failures", () => {
    for (const code of [
      "PROVIDER_SEND_FAILED",
      "NO_ACTIVE_CHANNEL",
      "RECORD_FAILED",
      "SERVICE_WINDOW_CLOSED",
    ] as const) {
      expect(isRetryableSendFailure(code)).toBe(true);
    }
  });
});

describe("P11Q — what a finished job reports", () => {
  it("reports plain success only when every recipient succeeded", () => {
    expect(bulkJobOutcome({ sent: 5, failed: 0, skipped: 0 })).toBe("completed");
  });

  /** The core honesty guarantee: a partial send is never a success. */
  it("never reports success when some recipients failed", () => {
    expect(bulkJobOutcome({ sent: 4, failed: 1, skipped: 0 })).toBe("completed_with_failures");
    expect(bulkJobOutcome({ sent: 4, failed: 0, skipped: 1 })).toBe("completed_with_failures");
  });

  it("reports outright failure when nothing was sent", () => {
    expect(bulkJobOutcome({ sent: 0, failed: 3, skipped: 0 })).toBe("failed");
    expect(bulkJobOutcome({ sent: 0, failed: 0, skipped: 2 })).toBe("failed");
  });
});
