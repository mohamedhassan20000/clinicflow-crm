import { describe, expect, it } from "vitest";
import {
  CONVERSATION_BADGE_CLASSES,
  conversationBadgeState,
} from "@/lib/messaging/conversation-status";

/**
 * An unknown WhatsApp number is the ordinary way a conversation starts. It is
 * not a review condition, and the Inbox must not say it is.
 */
describe("NEW_CONTACT — an unlinked live thread is a new contact, not a review", () => {
  const live = {
    status: "open" as const,
    hasActiveEpisode: true,
    lastMessageAt: "2026-08-17T09:00:00.000Z",
    lastInboundAt: "2026-08-17T09:00:00.000Z",
  };

  it("reads the first inbound from an unknown number as newContact", () => {
    expect(conversationBadgeState({ ...live, patientId: null })).toBe("newContact");
  });

  it("does not escalate merely because no patient is linked", () => {
    expect(conversationBadgeState({ ...live, patientId: null })).not.toBe("needsReview");
  });

  it("keeps newContact while the clinic has spoken last", () => {
    expect(
      conversationBadgeState({
        ...live,
        patientId: null,
        lastMessageAt: "2026-08-17T10:00:00.000Z",
      }),
    ).toBe("newContact");
  });

  it("disappears the moment a patient record is linked", () => {
    expect(
      conversationBadgeState({ ...live, patientId: "11111111-1111-4111-8111-111111111111" }),
    ).toBe("aiHandling");
  });

  it("still reports a genuine escalation on a stranger's thread", () => {
    expect(
      conversationBadgeState({
        ...live,
        patientId: null,
        escalatedAt: "2026-08-17T09:05:00.000Z",
      }),
    ).toBe("needsReview");
  });

  it("still reports a delivery failure and a closed thread ahead of it", () => {
    expect(
      conversationBadgeState({ ...live, patientId: null, hasDeliveryFailure: true }),
    ).toBe("problem");
    expect(
      conversationBadgeState({ ...live, patientId: null, status: "closed" }),
    ).toBe("done");
    expect(
      conversationBadgeState({ ...live, patientId: null, hasActiveEpisode: false }),
    ).toBe("done");
  });

  it("does not invent newContact for a caller that never read the column", () => {
    expect(conversationBadgeState(live)).toBe("aiHandling");
  });

  /**
   * P15 moved `done` down two places. The reasoning is in
   * `conversation-status.ts`: a technical failure and an unreviewed staged file
   * both *end* the episode, so anything that outranks them is erased by the
   * very thing it is supposed to report.
   */
  it("keeps the whole precedence order deterministic", () => {
    // problem > needsReview > done > newContact > humanHandling > waitingPatient > aiHandling
    const everything = {
      ...live,
      status: "closed" as const,
      hasDeliveryFailure: true,
      escalatedAt: "2026-08-17T09:05:00.000Z",
      patientId: null,
      lastMessageAt: "2026-08-17T10:00:00.000Z",
    };
    expect(conversationBadgeState(everything)).toBe("problem");
    expect(conversationBadgeState({ ...everything, hasDeliveryFailure: false })).toBe(
      "needsReview",
    );
    expect(
      conversationBadgeState({
        ...everything,
        hasDeliveryFailure: false,
        escalatedAt: null,
      }),
    ).toBe("done");
    expect(
      conversationBadgeState({
        ...everything,
        status: "open",
        hasDeliveryFailure: false,
        escalatedAt: null,
      }),
    ).toBe("newContact");
    expect(
      conversationBadgeState({
        ...everything,
        status: "open",
        hasDeliveryFailure: false,
        escalatedAt: null,
        // Linked, and the assistant has already answered inside this episode:
        // no longer a new contact, and the assistant still owns the thread.
        patientId: "11111111-1111-4111-8111-111111111111",
        lastAssistantReplyAt: "2026-08-17T10:00:00.000Z",
      }),
    ).toBe("aiHandling");
  });

  it("wears the active informational family, distinct from every other state", () => {
    expect(CONVERSATION_BADGE_CLASSES.newContact).toContain("primary");
    const values = Object.values(CONVERSATION_BADGE_CLASSES);
    expect(new Set(values).size).toBe(values.length);
  });
});
