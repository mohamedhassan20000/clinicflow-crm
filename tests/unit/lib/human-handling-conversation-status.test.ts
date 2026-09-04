import { describe, expect, it } from "vitest";
import {
  CONVERSATION_BADGE_CLASSES,
  conversationBadgeState,
  type ConversationBadgeState,
  type ConversationStatusInput,
} from "@/lib/messaging/conversation-status";

/**
 * P12 — "the AI is handling this" was being said about threads a colleague had
 * personally taken over.
 *
 * `ai_paused_at` is set by the Pause AI control and cleared by Resume AI. It is
 * the only fact these tests read, because it is the only fact the product has:
 * there is no second takeover flag to keep in sync with it.
 */
const live = {
  status: "open" as const,
  hasActiveEpisode: true,
  patientId: "11111111-1111-4111-8111-111111111111",
  lastMessageAt: "2026-08-17T09:00:00.000Z",
  lastInboundAt: "2026-08-17T09:00:00.000Z",
};

describe("HUMAN_HANDLING — a thread a person is holding", () => {
  /**
   * P15 refined what a takeover *shows*. Pausing the AI says a colleague owns
   * this thread; it does not say they have answered it yet. So a paused thread
   * whose newest message is the patient's now reads "Awaiting patient" — a
   * patient message sitting unanswered in front of a person is exactly what
   * that status means — and becomes "Active conversation" the moment the
   * colleague actually replies. Both readings are true of a taken-over thread
   * and neither of them is ever "AI handling", which is the property P12 was
   * written to guarantee and which the test below still pins.
   */
  it("reads a paused thread the colleague has answered as humanHandling", () => {
    expect(
      conversationBadgeState({
        ...live,
        aiPausedAt: "2026-08-17T09:05:00.000Z",
        lastHumanReplyAt: "2026-08-17T09:06:00.000Z",
      }),
    ).toBe("humanHandling");
  });

  it("reads a paused thread with an unanswered patient message as waitingPatient", () => {
    expect(
      conversationBadgeState({ ...live, aiPausedAt: "2026-08-17T09:05:00.000Z" }),
    ).toBe("waitingPatient");
  });

  it("never labels a human-handled thread as the AI's", () => {
    expect(
      conversationBadgeState({ ...live, aiPausedAt: "2026-08-17T09:05:00.000Z" }),
    ).not.toBe("aiHandling");
  });

  it("still says humanHandling when the clinic spoke last", () => {
    // Nobody is waiting on the clinic and the assistant is not answering, so
    // the thread belongs to the person holding it.
    expect(
      conversationBadgeState({
        ...live,
        aiPausedAt: "2026-08-17T09:05:00.000Z",
        lastMessageAt: "2026-08-17T10:00:00.000Z",
      }),
    ).toBe("humanHandling");
  });

  it("hands the thread back the moment the AI is resumed", () => {
    // Resume AI clears `ai_paused_at`; nothing else has to be written for the
    // badge to go back to describing the assistant.
    expect(conversationBadgeState({ ...live, aiPausedAt: null })).toBe("aiHandling");
    expect(
      conversationBadgeState({
        ...live,
        aiPausedAt: null,
        lastMessageAt: "2026-08-17T10:00:00.000Z",
      }),
    ).toBe("aiHandling");
  });

  it("is outranked by every state that means something is wrong or unknown", () => {
    const takenOver = {
      ...live,
      aiPausedAt: "2026-08-17T09:05:00.000Z",
      lastHumanReplyAt: "2026-08-17T09:06:00.000Z",
    };
    expect(conversationBadgeState({ ...takenOver, status: "closed" })).toBe("done");
    expect(conversationBadgeState({ ...takenOver, hasActiveEpisode: false })).toBe("done");
    expect(conversationBadgeState({ ...takenOver, hasDeliveryFailure: true })).toBe("problem");
    expect(
      conversationBadgeState({ ...takenOver, escalatedAt: "2026-08-17T09:06:00.000Z" }),
    ).toBe("needsReview");
    // A stranger a colleague is talking to is still, first, a stranger: one
    // badge, and it is the one that says we do not know who this is.
    expect(conversationBadgeState({ ...takenOver, patientId: null })).toBe("newContact");
  });

  /**
   * P15's precedence, peeled one condition at a time.
   *
   * The order changed at the top: `problem` and `needsReview` now outrank
   * `done`, because both are obligations that *survive* the episode ending and
   * the old order let the ending erase them. `done` is still the resting state
   * and is still what a thread reads once it owes nothing.
   */
  it("keeps the whole seven-state precedence deterministic", () => {
    // problem > needsReview > done > newContact > humanHandling > waitingPatient > aiHandling
    const everything: ConversationStatusInput = {
      ...live,
      status: "closed",
      hasDeliveryFailure: true,
      escalatedAt: "2026-08-17T09:05:00.000Z",
      patientId: null,
      aiPausedAt: "2026-08-17T09:05:00.000Z",
      lastHumanReplyAt: "2026-08-17T09:06:00.000Z",
      lastMessageAt: "2026-08-17T10:00:00.000Z",
    };
    const peeled: ConversationBadgeState[] = [];
    let input: ConversationStatusInput = { ...everything };
    peeled.push(conversationBadgeState(input));
    input = { ...input, hasDeliveryFailure: false };
    peeled.push(conversationBadgeState(input));
    input = { ...input, escalatedAt: null };
    peeled.push(conversationBadgeState(input));
    input = { ...input, status: "open" };
    peeled.push(conversationBadgeState(input));
    input = { ...input, patientId: live.patientId, lastAssistantReplyAt: "2026-08-17T09:04:00.000Z" };
    peeled.push(conversationBadgeState(input));
    // Take away the colleague's reply and the patient's message is the newest
    // thing on the thread again: somebody at the clinic owes them an answer.
    input = { ...input, lastHumanReplyAt: null, lastMessageAt: live.lastMessageAt };
    peeled.push(conversationBadgeState(input));
    input = { ...input, aiPausedAt: null };
    peeled.push(conversationBadgeState(input));

    expect(peeled).toEqual([
      "problem",
      "needsReview",
      "done",
      "newContact",
      "humanHandling",
      "waitingPatient",
      "aiHandling",
    ]);
  });

  it("wears a colour no other state wears", () => {
    const values = Object.values(CONVERSATION_BADGE_CLASSES);
    expect(new Set(values).size).toBe(values.length);
    expect(CONVERSATION_BADGE_CLASSES.humanHandling).not.toBe(
      CONVERSATION_BADGE_CLASSES.aiHandling,
    );
  });

  it("stays out of the way of callers that never read the column", () => {
    // `aiPausedAt` absent is "not taken over", not "unknown": the derivation
    // must be unchanged for any caller predating this state.
    expect(conversationBadgeState(live)).toBe("aiHandling");
  });
});
