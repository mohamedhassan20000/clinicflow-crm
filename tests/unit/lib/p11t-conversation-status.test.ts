import { describe, expect, it } from "vitest";
import {
  CONVERSATION_BADGE_CLASSES,
  conversationBadgeState,
  type ConversationBadgeState,
  type ConversationStatusInput,
} from "@/lib/messaging/conversation-status";

/**
 * P11T — Done is the resting state, and the episode is what says so.
 *
 * P11P derived the badge from `conversations.status` alone, which meant a
 * thread whose episode had ended but whose row had not yet been flipped — the
 * window inside the close path, and any thread that never had an episode —
 * read as "the assistant is working on it". These pin the episode half of the
 * derivation, and the rule that makes it safe to deploy: `undefined` is *not*
 * false.
 */

const live: ConversationStatusInput = {
  status: "open",
  escalatedAt: null,
  hasDeliveryFailure: false,
  lastMessageAt: "2026-09-01T09:00:00.000Z",
  lastInboundAt: "2026-09-01T09:00:00.000Z",
};

describe("P11T — the episode decides Done", () => {
  it("is Done when the thread has no active episode, even while the row says open", () => {
    expect(conversationBadgeState({ ...live, hasActiveEpisode: false })).toBe("done");
  });

  it("is AI handling when an episode is active", () => {
    expect(conversationBadgeState({ ...live, hasActiveEpisode: true })).toBe("aiHandling");
  });

  /**
   * The deploy-window rule. A build that ships before its migration cannot read
   * `current_episode_id`, and the Inbox must not respond by declaring every
   * live conversation in the clinic finished.
   */
  it("falls back to the pre-P11T derivation when the episode is unknown", () => {
    expect(conversationBadgeState({ ...live, hasActiveEpisode: undefined })).toBe("aiHandling");
    expect(conversationBadgeState({ ...live, hasActiveEpisode: null })).toBe("aiHandling");
  });

  it("keeps a closed row Done regardless of what the episode pointer says", () => {
    expect(
      conversationBadgeState({ ...live, status: "closed", hasActiveEpisode: true }),
    ).toBe("done");
  });

  /**
   * P15 reversed this. P11T's reasoning — a finished thread must not be dragged
   * back into the queue — was right about the *stale* flags it was written
   * against and wrong as a general rule, because P15 gives the machine two
   * endings that close the episode *because* something needs attention: a
   * technical failure ends the episode as part of failing, and an episode that
   * staged a patient file ends normally while the clinic still owes a review.
   * Under the old order both were erased by the ending they caused.
   *
   * A resting thread with nothing outstanding still reads Done, which is the
   * case P11T actually cared about.
   */
  it("still reads Done when a resting thread owes nothing", () => {
    expect(
      conversationBadgeState({
        ...live,
        hasActiveEpisode: false,
        escalatedAt: null,
        hasDeliveryFailure: false,
        hasOutstandingReview: false,
      }),
    ).toBe("done");
  });

  it("keeps a resting thread in the queue while it still owes a review", () => {
    expect(
      conversationBadgeState({
        ...live,
        hasActiveEpisode: false,
        escalatedAt: "2026-09-01T08:00:00.000Z",
      }),
    ).toBe("needsReview");
  });

  it("keeps a resting thread red while its last message never arrived", () => {
    expect(
      conversationBadgeState({
        ...live,
        hasActiveEpisode: false,
        hasDeliveryFailure: true,
      }),
    ).toBe("problem");
  });
});

describe("P11T — the documented transition table", () => {
  /**
   * Each row is a transition from section 8 of the specification, expressed as
   * the state of the conversation *after* the event. The point is that the
   * badge is a pure function of the columns the flows already write, so every
   * transition is reachable by describing its end state — there is no separate
   * state machine that could disagree with this one.
   */
  const transitions: Array<{
    from: ConversationBadgeState;
    event: string;
    after: ConversationStatusInput;
    to: ConversationBadgeState;
  }> = [
    {
      from: "done",
      event: "a real new inbound opens a fresh episode",
      after: { ...live, hasActiveEpisode: true, lastInboundAt: "2026-09-01T09:00:00.000Z" },
      to: "aiHandling",
    },
    {
      from: "aiHandling",
      event: "the assistant escalates to a human",
      after: { ...live, hasActiveEpisode: true, escalatedAt: "2026-09-01T09:05:00.000Z" },
      to: "needsReview",
    },
    {
      // P15: the assistant asking "anything else?" is the assistant handling
      // the thread. Awaiting patient now means a patient message is unanswered
      // in front of a *person*, which is not what this is.
      from: "aiHandling",
      event: "the goal completes and the assistant asks if anything else is needed",
      after: { ...live, hasActiveEpisode: true, lastMessageAt: "2026-09-01T09:10:00.000Z" },
      to: "aiHandling",
    },
    {
      from: "aiHandling",
      event: "the clinic switches the assistant off and the patient writes again",
      after: {
        ...live,
        hasActiveEpisode: true,
        aiEnabled: false,
        lastMessageAt: "2026-09-01T09:15:00.000Z",
        lastInboundAt: "2026-09-01T09:15:00.000Z",
      },
      to: "waitingPatient",
    },
    {
      from: "waitingPatient",
      event: "a staff member answers from ClinicFlow or the linked handset",
      after: {
        ...live,
        hasActiveEpisode: true,
        aiEnabled: false,
        lastMessageAt: "2026-09-01T09:20:00.000Z",
        lastInboundAt: "2026-09-01T09:15:00.000Z",
        lastHumanReplyAt: "2026-09-01T09:20:00.000Z",
      },
      to: "humanHandling",
    },
    {
      from: "aiHandling",
      event: "the patient comes back with a new request",
      after: {
        ...live,
        hasActiveEpisode: true,
        lastMessageAt: "2026-09-01T09:15:00.000Z",
        lastInboundAt: "2026-09-01T09:15:00.000Z",
      },
      to: "aiHandling",
    },
    {
      from: "waitingPatient",
      event: "the patient says they need nothing more",
      after: { ...live, status: "closed", hasActiveEpisode: false },
      to: "done",
    },
    {
      from: "waitingPatient",
      event: "five minutes pass with no reply and the idle sweep fires",
      after: { ...live, status: "closed", hasActiveEpisode: false },
      to: "done",
    },
    {
      from: "aiHandling",
      event: "a staff member closes the thread",
      after: { ...live, status: "closed", hasActiveEpisode: false },
      to: "done",
    },
    {
      from: "needsReview",
      event: "a staff member resolves the escalation and resumes the AI",
      after: { ...live, hasActiveEpisode: true, escalatedAt: null },
      to: "aiHandling",
    },
    {
      // P15: closing a thread does not discharge the escalation on it. The
      // thread stops being live; the obligation does not stop existing.
      from: "needsReview",
      event: "a staff member closes the thread without resolving the escalation",
      after: {
        ...live,
        status: "closed",
        hasActiveEpisode: false,
        escalatedAt: "2026-09-01T09:05:00.000Z",
      },
      to: "needsReview",
    },
    {
      from: "needsReview",
      event: "the staged file and booking are both reviewed, and the episode has ended",
      after: {
        ...live,
        status: "closed",
        hasActiveEpisode: false,
        escalatedAt: null,
        hasOutstandingReview: false,
      },
      to: "done",
    },
    {
      from: "aiHandling",
      event: "a message to the patient fails to deliver",
      after: { ...live, hasActiveEpisode: true, hasDeliveryFailure: true },
      to: "problem",
    },
  ];

  for (const row of transitions) {
    it(`${row.from} + ${row.event} → ${row.to}`, () => {
      expect(conversationBadgeState(row.after)).toBe(row.to);
    });
  }

  /**
   * PROBLEM is a delivery fact, not a lifecycle state: it must never be the
   * thing that decides a conversation is over, and it must not survive the
   * close as a reason to keep the thread in the queue.
   */
  it("does not let a delivery failure destroy conversation state", () => {
    const failed = { ...live, hasActiveEpisode: true, hasDeliveryFailure: true };
    expect(conversationBadgeState(failed)).toBe("problem");
    // P15: and closing the thread does not make the failure go away. The
    // message still did not reach the patient; only a later successful send
    // clears it, which is what the Inbox's newest-outbound rule already does.
    expect(conversationBadgeState({ ...failed, status: "closed", hasActiveEpisode: false }))
      .toBe("problem");
  });
});

describe("P11T — the badge is readable at a glance", () => {
  const states: ConversationBadgeState[] = [
    "aiHandling",
    "done",
    "needsReview",
    "waitingPatient",
    "problem",
  ];

  it("gives every state a class set of its own", () => {
    const seen = states.map((state) => CONVERSATION_BADGE_CLASSES[state]);
    expect(new Set(seen).size).toBe(states.length);
  });

  it("uses design-system tokens rather than raw colour values", () => {
    for (const state of states) {
      const classes = CONVERSATION_BADGE_CLASSES[state];
      expect(classes, state).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(classes, state).not.toMatch(/\b(rgb|hsl)a?\(/i);
      // A border, a fill and a foreground — the construction the rest of this
      // Inbox's badges already use, and what keeps the text legible on both
      // themes rather than only the one the author happened to be looking at.
      expect(classes, state).toMatch(/\bborder-/);
      expect(classes, state).toMatch(/\bbg-/);
      expect(classes, state).toMatch(/\btext-/);
    }
  });

  /**
   * The states that mean "somebody must act" must not share a hue with the
   * states that mean "nothing to do here". This is the accessibility
   * requirement stated as a property rather than as a screenshot: two states
   * that differ only in opacity are two states staff will confuse.
   */
  it("keeps the five hues distinct from one another", () => {
    const hue = (classes: string) => {
      const match = classes.match(/\bbg-([a-z-]+?)(?:-\d+)?\//);
      return match?.[1] ?? classes;
    };
    const hues = states.map((state) => hue(CONVERSATION_BADGE_CLASSES[state]));
    expect(new Set(hues).size, `hues: ${hues.join(", ")}`).toBe(states.length);
  });

  it("reserves the destructive token for a real delivery failure", () => {
    expect(CONVERSATION_BADGE_CLASSES.problem).toMatch(/destructive/);
    for (const state of states.filter((item) => item !== "problem")) {
      expect(CONVERSATION_BADGE_CLASSES[state], state).not.toMatch(/destructive/);
    }
  });

  /** Done is the resting state, so it is the quietest thing in the list. */
  it("paints Done in the neutral register rather than as a success", () => {
    expect(CONVERSATION_BADGE_CLASSES.done).toMatch(/muted/);
    expect(CONVERSATION_BADGE_CLASSES.done).not.toMatch(/emerald|green/);
  });
});
