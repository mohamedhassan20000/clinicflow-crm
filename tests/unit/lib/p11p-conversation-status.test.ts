import { describe, expect, it } from "vitest";
import {
  CONVERSATION_BADGE_CLASSES,
  conversationBadgeState,
  type ConversationStatusInput,
} from "@/lib/messaging/conversation-status";

/**
 * P11P — the status badge, and the promise that it never invents a lifecycle.
 *
 * Every state below is a view of a column staff already write through an
 * existing flow (Close thread, AI escalation, the send path). These tests pin
 * the precedence between them, because precedence is the only place a "view"
 * can start lying about the thing it is a view of.
 */

const base: ConversationStatusInput = {
  status: "open",
  escalatedAt: null,
  hasDeliveryFailure: false,
  lastMessageAt: null,
  lastInboundAt: null,
};

describe("P11P — conversation badge state", () => {
  it("is AI handling for an ordinary live conversation whose last word was the patient's", () => {
    expect(
      conversationBadgeState({
        ...base,
        lastMessageAt: "2026-08-17T09:00:00.000Z",
        lastInboundAt: "2026-08-17T09:00:00.000Z",
      }),
    ).toBe("aiHandling");
  });

  it("is Done when a staff member closed the thread", () => {
    expect(conversationBadgeState({ ...base, status: "closed" })).toBe("done");
  });

  it("is AI review when the AI escalated to a human", () => {
    expect(
      conversationBadgeState({ ...base, escalatedAt: "2026-08-17T09:05:00.000Z" }),
    ).toBe("needsReview");
  });

  /**
   * P15 moved this line. "Awaiting patient" used to mean *the clinic spoke
   * last*, which put every thread the assistant had just answered under a
   * heading that reads as "nobody has to do anything" — and, worse, put the
   * threads where the assistant was switched off under "AI handling". It now
   * means *a patient message is sitting unanswered in front of a person*, so
   * it is the assistant's enablement, not the message order, that decides.
   *
   * With the assistant on and working the thread, the clinic speaking last is
   * simply the assistant handling it.
   */
  it("is AI handling when the assistant spoke last and is still answering", () => {
    expect(
      conversationBadgeState({
        ...base,
        lastInboundAt: "2026-08-17T09:00:00.000Z",
        lastMessageAt: "2026-08-17T09:30:00.000Z",
      }),
    ).toBe("aiHandling");
  });

  it("is Awaiting patient when the assistant is off and the patient wrote last", () => {
    expect(
      conversationBadgeState({
        ...base,
        aiEnabled: false,
        lastInboundAt: "2026-08-17T09:30:00.000Z",
        lastMessageAt: "2026-08-17T09:30:00.000Z",
      }),
    ).toBe("waitingPatient");
  });

  it("is Problem only for a real delivery failure", () => {
    expect(conversationBadgeState({ ...base, hasDeliveryFailure: true })).toBe("problem");
  });

  /**
   * The explicit instruction, and the one most easily violated by a helpful
   * heuristic: a thread the AI has simply not answered yet is AI handling. Silence is
   * not a fault, and a red badge that cries wolf is worse than no badge.
   */
  it("does not turn red merely because the AI has not replied", () => {
    expect(
      conversationBadgeState({
        ...base,
        lastMessageAt: "2026-08-17T09:00:00.000Z",
        lastInboundAt: "2026-08-17T09:00:00.000Z",
        hasDeliveryFailure: false,
      }),
    ).toBe("aiHandling");
  });

  describe("precedence", () => {
    /**
     * P15 inverted these two, deliberately, and this is the change with the
     * most blast radius in the whole pass.
     *
     * Before P15 `done` outranked everything, on the reasoning that closing a
     * thread is a human decision nothing should overrule. That reasoning still
     * holds for a thread a person closed and nothing is wrong with — and every
     * such thread still reads Done, because it has no failure and no
     * outstanding review.
     *
     * What it does not survive is the two endings the machine reaches on its
     * own. A technical failure *closes the episode as part of failing*, so
     * "Done outranks Problem" means the badge is erased by the very code path
     * that broke. An episode that staged a patient file closes normally, so
     * "Done outranks Needs review" means the clinic is told the work is
     * finished at the exact moment it starts. Both are the badge lying about
     * the thing it is a view of, which is what these tests exist to prevent.
     */
    it("shows Needs review on a closed thread that still owes a review", () => {
      expect(
        conversationBadgeState({
          ...base,
          status: "closed",
          escalatedAt: "2026-08-17T09:05:00.000Z",
        }),
      ).toBe("needsReview");
    });

    it("shows Problem on a closed thread whose last message never arrived", () => {
      expect(
        conversationBadgeState({ ...base, status: "closed", hasDeliveryFailure: true }),
      ).toBe("problem");
    });

    it("still reads Done for a thread that is closed and owes nothing", () => {
      expect(
        conversationBadgeState({
          ...base,
          status: "closed",
          escalatedAt: null,
          hasDeliveryFailure: false,
          hasOutstandingReview: false,
        }),
      ).toBe("done");
    });

    it("shows Problem ahead of Needs review on a live thread", () => {
      expect(
        conversationBadgeState({
          ...base,
          hasDeliveryFailure: true,
          escalatedAt: "2026-08-17T09:05:00.000Z",
        }),
      ).toBe("problem");
    });

    it("shows Needs review ahead of Awaiting patient", () => {
      expect(
        conversationBadgeState({
          ...base,
          escalatedAt: "2026-08-17T09:05:00.000Z",
          lastInboundAt: "2026-08-17T09:00:00.000Z",
          lastMessageAt: "2026-08-17T09:30:00.000Z",
        }),
      ).toBe("needsReview");
    });
  });

  it("treats a conversation with no messages as AI handling rather than Awaiting patient", () => {
    expect(conversationBadgeState(base)).toBe("aiHandling");
  });

  /**
   * Nobody is waiting on the clinic here — there is no patient message at all.
   * With the assistant on, this is a thread it is working; with the assistant
   * off, it is a thread a person owns.
   */
  it("treats a thread with only outbound messages as AI handling while the assistant is on", () => {
    expect(
      conversationBadgeState({ ...base, lastMessageAt: "2026-08-17T09:30:00.000Z" }),
    ).toBe("aiHandling");
  });

  it("treats a thread with only outbound messages as Active conversation once the assistant is off", () => {
    expect(
      conversationBadgeState({
        ...base,
        aiEnabled: false,
        lastMessageAt: "2026-08-17T09:30:00.000Z",
      }),
    ).toBe("humanHandling");
  });

  it("tolerates the delivery flag being absent, as older callers leave it", () => {
    expect(conversationBadgeState({ status: "open" })).toBe("aiHandling");
  });

  it("dresses every state in design-system tokens, never a raw colour", () => {
    for (const [state, classes] of Object.entries(CONVERSATION_BADGE_CLASSES)) {
      expect(classes, state).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(classes, state).not.toMatch(/\brgb|\bhsl\(/i);
      expect(classes.length, state).toBeGreaterThan(0);
    }
    // Every state must be distinguishable from every other one.
    const values = Object.values(CONVERSATION_BADGE_CLASSES);
    expect(new Set(values).size).toBe(values.length);
  });
});
