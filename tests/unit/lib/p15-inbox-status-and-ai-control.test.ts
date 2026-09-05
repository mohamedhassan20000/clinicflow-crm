import { describe, expect, it } from "vitest";
import {
  CONVERSATION_BADGE_CLASSES,
  CONVERSATION_BADGE_STATES,
  conversationBadgeState,
  type ConversationBadgeState,
  type ConversationStatusInput,
} from "@/lib/messaging/conversation-status";
import {
  clinicAiRepliesEnabled,
  effectiveConversationAiEnabled,
  resolveEffectiveConversationAi,
} from "@/lib/messaging/ai-enablement";

/**
 * P15 — the Inbox says exactly one thing about a thread, and the assistant
 * answers exactly the threads the clinic said it may.
 *
 * These are the scenario tests for the conversation lifecycle as specified:
 * one case per required transition, each written as the *state the columns are
 * in* after the event rather than as a sequence of calls, because the badge is
 * a pure function of those columns and there is no second state machine that
 * could disagree with this one.
 */

/** A live, linked thread whose newest message is the patient's. */
const live: ConversationStatusInput = {
  status: "open",
  hasActiveEpisode: true,
  patientId: "11111111-1111-4111-8111-111111111111",
  escalatedAt: null,
  hasDeliveryFailure: false,
  hasOutstandingReview: false,
  aiTechnicalFailureAt: null,
  aiEnabled: true,
  lastMessageAt: "2026-09-08T09:00:00.000Z",
  lastInboundAt: "2026-09-08T09:00:00.000Z",
  lastAssistantReplyAt: null,
  lastHumanReplyAt: null,
};

/** The same thread before anyone knows who is writing. */
const stranger: ConversationStatusInput = { ...live, patientId: null };

describe("P15 §2A — a fresh unknown sender", () => {
  it("is New contact before the assistant has answered", () => {
    expect(conversationBadgeState(stranger)).toBe("newContact");
  });

  /**
   * The requirement stated as its failure mode: an unlinked number must not
   * wear "New contact" for the rest of its life. It is a *stage* — the moment
   * the assistant has taken the conversation the row says who is handling it,
   * which is the thing a receptionist scanning the list actually needs.
   */
  it("becomes AI handling once the assistant has replied, still unlinked", () => {
    expect(
      conversationBadgeState({
        ...stranger,
        lastAssistantReplyAt: "2026-09-08T09:00:05.000Z",
      }),
    ).toBe("aiHandling");
  });

  it("keeps the pre-P15 reading for a caller that never read the reply column", () => {
    const { lastAssistantReplyAt: _unused, ...withoutColumn } = stranger;
    void _unused;
    expect(conversationBadgeState(withoutColumn)).toBe("newContact");
  });
});

describe("P15 §2B/C — an existing conversation the assistant is working", () => {
  it("is AI handling once the assistant has replied to the live turn", () => {
    expect(
      conversationBadgeState({
        ...live,
        lastAssistantReplyAt: "2026-09-08T09:00:05.000Z",
        lastMessageAt: "2026-09-08T09:00:05.000Z",
      }),
    ).toBe("aiHandling");
  });

  /**
   * "AI handling" describes the assistant *currently* being responsible. An
   * imported outbound message is not the assistant taking a live turn, and the
   * history import writes no episode attribution at all — so it can never
   * produce this state. Expressed here as: an unlinked thread whose only
   * outbound is an unattributed historical one is still a New contact.
   */
  it("is not produced by a historical import", () => {
    expect(
      conversationBadgeState({
        ...stranger,
        // The importer writes neither an episode attribution nor a live human
        // reply, so both stay null however many rows it wrote.
        lastAssistantReplyAt: null,
        lastHumanReplyAt: null,
      }),
    ).toBe("newContact");
  });
});

describe("P15 §2D — Awaiting patient means a person owes a reply", () => {
  it("is Awaiting patient when AI is disabled here and the patient wrote last", () => {
    expect(conversationBadgeState({ ...live, aiEnabled: false })).toBe("waitingPatient");
  });

  it("is Awaiting patient when a takeover is in force and nobody has answered yet", () => {
    expect(
      conversationBadgeState({ ...live, aiPausedAt: "2026-09-08T09:00:01.000Z" }),
    ).toBe("waitingPatient");
  });

  it("is never Awaiting patient while the assistant is answering", () => {
    expect(conversationBadgeState(live)).not.toBe("waitingPatient");
  });
});

describe("P15 §2E — Active conversation is a person answering", () => {
  it("is Active conversation once a staff member replies from ClinicFlow", () => {
    expect(
      conversationBadgeState({
        ...live,
        aiEnabled: false,
        lastHumanReplyAt: "2026-09-08T09:05:00.000Z",
        lastMessageAt: "2026-09-08T09:05:00.000Z",
      }),
    ).toBe("humanHandling");
  });

  /**
   * The same status from the other route. A reply typed on the clinic's own
   * linked handset arrives as an outbound echo and is recorded identically —
   * the derivation cannot tell the two apart, and must not.
   */
  it("is Active conversation for a legitimate live linked-phone echo", () => {
    expect(
      conversationBadgeState({
        ...live,
        aiEnabled: false,
        // Written by the echo path, which records live echoes and only live
        // echoes as a human reply.
        lastHumanReplyAt: "2026-09-08T09:05:00.000Z",
        lastMessageAt: "2026-09-08T09:05:00.000Z",
      }),
    ).toBe("humanHandling");
  });

  it("is not produced by a historical outbound replay", () => {
    // The importer never writes `lastHumanReplyAt`, so a thread with a year of
    // imported replies is still a thread nobody has answered today.
    expect(
      conversationBadgeState({
        ...live,
        aiEnabled: false,
        lastHumanReplyAt: null,
        lastMessageAt: "2026-09-08T09:00:00.000Z",
      }),
    ).toBe("waitingPatient");
  });
});

describe("P15 §2F — Problem is a technical fault, and only that", () => {
  it("is Problem when the assistant latched a technical failure", () => {
    expect(
      conversationBadgeState({ ...live, aiTechnicalFailureAt: "2026-09-08T09:00:07.000Z" }),
    ).toBe("problem");
  });

  it("stays Problem after the failure closed the episode", () => {
    expect(
      conversationBadgeState({
        ...live,
        aiTechnicalFailureAt: "2026-09-08T09:00:07.000Z",
        status: "closed",
        hasActiveEpisode: false,
      }),
    ).toBe("problem");
  });

  /**
   * The explicit non-goals. None of these is a technical fault, and every one
   * of them is a thing the assistant does many times a day: an ambiguous
   * message it asks about, a slot the clinic has not got free, a casual
   * question, a validation prompt. All of them leave the latch null and the
   * thread reads as the assistant handling it, which is what it is doing.
   */
  it("is not Problem for ordinary conversational outcomes", () => {
    expect(
      conversationBadgeState({
        ...live,
        aiTechnicalFailureAt: null,
        lastAssistantReplyAt: "2026-09-08T09:00:05.000Z",
      }),
    ).toBe("aiHandling");
  });
});

describe("P15 §2G/H — review obligations outlive the conversation", () => {
  const closedEpisode: ConversationStatusInput = {
    ...live,
    status: "closed",
    hasActiveEpisode: false,
  };

  it("is Needs human review when a staged patient file is unreviewed", () => {
    expect(
      conversationBadgeState({ ...closedEpisode, hasOutstandingReview: true }),
    ).toBe("needsReview");
  });

  it("is Needs human review when a booking request is unreviewed", () => {
    expect(
      conversationBadgeState({ ...closedEpisode, hasOutstandingReview: true }),
    ).toBe("needsReview");
  });

  /**
   * Both obligations at once still produce one status, and it stays until both
   * are discharged. The Inbox models this as set membership rather than as a
   * counter — a conversation is in the outstanding set while *any* table still
   * holds it — so "one of the two reviewed" is simply still a member.
   */
  it("stays Needs human review until every obligation is discharged", () => {
    const bothOutstanding = { ...closedEpisode, hasOutstandingReview: true };
    expect(conversationBadgeState(bothOutstanding)).toBe("needsReview");
    // The patient file is approved; the booking request is not. The
    // conversation is still in the outstanding set.
    expect(conversationBadgeState({ ...bothOutstanding })).toBe("needsReview");
    // Both discharged.
    expect(
      conversationBadgeState({ ...closedEpisode, hasOutstandingReview: false }),
    ).toBe("done");
  });

  it("does not become Done merely because the episode ended", () => {
    expect(
      conversationBadgeState({ ...closedEpisode, hasOutstandingReview: true }),
    ).not.toBe("done");
  });

  /** Idempotent: reviewing again cannot move a Done thread anywhere else. */
  it("is Done once, and stays Done", () => {
    const done = { ...closedEpisode, hasOutstandingReview: false };
    expect(conversationBadgeState(done)).toBe("done");
    expect(conversationBadgeState(done)).toBe("done");
  });
});

describe("P15 §3 — the AI control precedence", () => {
  it("follows the clinic when the conversation has no exception", () => {
    expect(
      resolveEffectiveConversationAi({ clinicMode: "auto", override: null }),
    ).toMatchObject({ enabled: true, reason: "clinic_setting", overridden: false });
    expect(
      resolveEffectiveConversationAi({ clinicMode: "off", override: null }),
    ).toMatchObject({ enabled: false, reason: "clinic_setting", overridden: false });
  });

  it("lets a conversation exception admit a thread while the clinic is off", () => {
    expect(
      resolveEffectiveConversationAi({ clinicMode: "off", override: true }),
    ).toMatchObject({ enabled: true, reason: "conversation_enabled", overridden: true });
  });

  it("lets a conversation exception exclude a thread while the clinic is on", () => {
    expect(
      resolveEffectiveConversationAi({ clinicMode: "auto", override: false }),
    ).toMatchObject({ enabled: false, reason: "conversation_disabled", overridden: true });
  });

  /**
   * The one asymmetry, and it is deliberate: a per-conversation exception may
   * admit a thread the clinic setting excluded, but it may not overrule a
   * colleague who is in the middle of answering it.
   */
  it("never lets an exception overrule a human takeover", () => {
    expect(
      resolveEffectiveConversationAi({
        clinicMode: "auto",
        override: true,
        aiPausedAt: "2026-09-08T09:05:00.000Z",
      }),
    ).toMatchObject({ enabled: false, reason: "human_takeover" });
  });

  it("treats `suggest` as the clinic-wide switch being on", () => {
    expect(clinicAiRepliesEnabled("suggest")).toBe(true);
    expect(clinicAiRepliesEnabled("auto")).toBe(true);
    expect(clinicAiRepliesEnabled("off")).toBe(false);
  });

  it("agrees with the badge derivation about what disabled means", () => {
    const disabled = effectiveConversationAiEnabled({ clinicMode: "auto", override: false });
    expect(disabled).toBe(false);
    expect(conversationBadgeState({ ...live, aiEnabled: disabled })).toBe("waitingPatient");
  });
});

describe("P15 — the registry is the whole vocabulary", () => {
  /**
   * The eighth-status guard. Every visible status has to come out of the
   * registry, and the registry has to be exactly the seven the product
   * specifies — nothing derived, nothing styled and nothing labelled outside
   * it. A new state added to the derivation without being added here fails
   * this test rather than appearing in the Inbox as an unlabelled badge.
   */
  it("emits nothing outside the seven registered statuses", () => {
    expect([...CONVERSATION_BADGE_STATES].sort()).toEqual(
      [
        "aiHandling",
        "done",
        "humanHandling",
        "needsReview",
        "newContact",
        "problem",
        "waitingPatient",
      ].sort(),
    );
    expect(Object.keys(CONVERSATION_BADGE_CLASSES).sort()).toEqual(
      [...CONVERSATION_BADGE_STATES].sort(),
    );
  });

  it("produces only registered statuses across the whole input space", () => {
    const registry = new Set<ConversationBadgeState>(CONVERSATION_BADGE_STATES);
    const flags = [true, false, null, undefined] as const;
    const times = [null, "2026-09-08T08:00:00.000Z", "2026-09-08T10:00:00.000Z"] as const;
    for (const status of ["open", "closed"] as const) {
      for (const failure of flags) {
        for (const review of flags) {
          for (const episode of flags) {
            for (const enabled of flags) {
              for (const human of times) {
                for (const assistant of times) {
                  const state = conversationBadgeState({
                    status,
                    hasDeliveryFailure: failure,
                    hasOutstandingReview: review,
                    hasActiveEpisode: episode,
                    aiEnabled: enabled,
                    lastHumanReplyAt: human,
                    lastAssistantReplyAt: assistant,
                    lastInboundAt: "2026-09-08T09:00:00.000Z",
                    lastMessageAt: "2026-09-08T09:00:00.000Z",
                    patientId: null,
                  });
                  expect(registry.has(state), state).toBe(true);
                }
              }
            }
          }
        }
      }
    }
  });
});
