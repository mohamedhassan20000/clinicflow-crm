import { describe, expect, it } from "vitest";
import {
  conversationBadgeState,
  type ConversationStatusInput,
} from "@/lib/messaging/conversation-status";

/**
 * The reported defect: "changing the conversation status from the Inbox does
 * not work."
 *
 * The mutation always fired, the row always changed and the roles were never
 * the problem. What went wrong is one line of the derivation:
 *
 *     if (input.hasActiveEpisode === false) return "done";
 *
 * `current_episode_id` is written by exactly one thing —
 * `resolve_conversation_episode`, called at the top of an assistant turn — and
 * an assistant turn only happens when the clinic's AI replies are on and this
 * conversation is not excluded. So on a clinic with the assistant off, no
 * episode is ever opened, the pointer is permanently null, and *every* thread
 * reads `Done` no matter what `status` says. Reopening a thread wrote
 * `status = 'open'` and the badge, the filter and the counts all kept saying
 * `Done`, because a derived signal was overruling the explicit one.
 *
 * The fix dates the two against each other: `status_updated_at` against
 * `ai_context_reset_at`, the boundary every episode ending stamps. These pin
 * both directions of it.
 */

/** A live thread the assistant is working. */
const live: ConversationStatusInput = {
  status: "open",
  escalatedAt: null,
  hasDeliveryFailure: false,
  hasOutstandingReview: false,
  lastMessageAt: "2026-09-01T09:00:00.000Z",
  lastInboundAt: "2026-09-01T09:00:00.000Z",
  patientId: "patient-1",
};

describe("the explicit Open/Closed column is not overruled by an absent episode", () => {
  it("keeps a reopened thread out of Done", () => {
    // Closed at 09:10 (which stamped the boundary), reopened by staff at 09:20.
    expect(
      conversationBadgeState({
        ...live,
        status: "open",
        hasActiveEpisode: false,
        contextResetAt: "2026-09-01T09:10:00.000Z",
        statusUpdatedAt: "2026-09-01T09:20:00.000Z",
      }),
    ).not.toBe("done");
  });

  it("does not call every thread Done on a clinic whose assistant never runs", () => {
    // No episode was ever opened here, so no boundary was ever drawn. The
    // thread is open and the patient's message is unanswered.
    expect(
      conversationBadgeState({
        ...live,
        aiEnabled: false,
        hasActiveEpisode: false,
        contextResetAt: null,
        statusUpdatedAt: "2026-09-01T08:00:00.000Z",
        lastHumanReplyAt: null,
      }),
    ).toBe("waitingPatient");
  });

  it("still reads Done for a thread whose episode genuinely ended", () => {
    // The close path writes `status`, `status_updated_at` and
    // `ai_context_reset_at` at the same instant, so a real ending never looks
    // like a reopen.
    expect(
      conversationBadgeState({
        ...live,
        status: "closed",
        hasActiveEpisode: false,
        contextResetAt: "2026-09-01T09:10:00.000Z",
        statusUpdatedAt: "2026-09-01T09:10:00.000Z",
      }),
    ).toBe("done");
  });

  it("still reads Done for an open row the assistant closed just before the flip", () => {
    // P11T's original case, unchanged: the episode ended and the row has not
    // been flipped yet, so nothing is newer than the boundary.
    expect(
      conversationBadgeState({
        ...live,
        status: "open",
        hasActiveEpisode: false,
        contextResetAt: "2026-09-01T09:10:00.000Z",
        statusUpdatedAt: "2026-09-01T09:00:00.000Z",
      }),
    ).toBe("done");
  });

  it("leaves the pre-existing reading alone when the columns were not read", () => {
    // A build ahead of its migration, or any caller that does not select the
    // pair. `undefined` must not silently change every badge in the list.
    expect(
      conversationBadgeState({ ...live, hasActiveEpisode: false }),
    ).toBe("done");
    expect(
      conversationBadgeState({
        ...live,
        hasActiveEpisode: false,
        statusUpdatedAt: "2026-09-01T09:20:00.000Z",
      }),
    ).toBe("done");
  });

  it("does not let a reopen erase a problem or an outstanding review", () => {
    // The two states that outrank Done still outrank everything the reopen
    // changes; this fix moves nothing in the precedence order.
    const reopened = {
      ...live,
      hasActiveEpisode: false,
      contextResetAt: "2026-09-01T09:10:00.000Z",
      statusUpdatedAt: "2026-09-01T09:20:00.000Z",
    };
    expect(conversationBadgeState({ ...reopened, hasDeliveryFailure: true })).toBe("problem");
    expect(conversationBadgeState({ ...reopened, hasOutstandingReview: true })).toBe("needsReview");
  });

  it("does not reopen a closed row just because it was touched more recently", () => {
    // `status = 'closed'` is decided before any of this and cannot be undone
    // by a timestamp comparison.
    expect(
      conversationBadgeState({
        ...live,
        status: "closed",
        hasActiveEpisode: false,
        contextResetAt: "2026-09-01T09:00:00.000Z",
        statusUpdatedAt: "2026-09-01T09:30:00.000Z",
      }),
    ).toBe("done");
  });
});
