/**
 * P11S — a finished inquiry gets an ending it can be closed on.
 *
 * P11N deliberately withheld "هل تحتاج أي مساعدة أخرى؟" from a one-shot
 * informational turn, reasoning that a follow-up prompt after a one-line answer
 * reads as a script. In real threads the opposite held: without the prompt an
 * answered inquiry has no ending, so the thread sits open forever and the
 * patient is never handed the one-word exit that closes it — and the five-minute
 * idle close has nothing to arm on. This supersedes that decision for exactly
 * one case and leaves the other precondition untouched: an unfinished workflow
 * is still never interrupted with it.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  ANYTHING_ELSE_PROMPT,
  resolveConversationLifecycle,
} from "@/lib/ai/conversation-lifecycle";

const base = {
  locale: "ar" as const,
  lastAssistantText: null,
  outstanding: false,
  goalCompleted: false,
};

describe("P11S — the closing question after a completed inquiry", () => {
  it("is appended when the turn answered an informational request", () => {
    const decision = resolveConversationLifecycle({
      ...base,
      latestPatientText: "عندكم أنهي أقسام؟",
      replyText: "الأقسام المتاحة: الجلدية، الأسنان، العلاج الطبيعي.",
      informationAnswered: true,
    });
    expect(decision.kind).toBe("offer_end");
    if (decision.kind === "offer_end") {
      expect(decision.text).toContain(ANYTHING_ELSE_PROMPT.ar);
      expect(decision.text).toContain("الجلدية");
    }
  });

  it("is not appended while the booking still owes the patient something", () => {
    const decision = resolveConversationLifecycle({
      ...base,
      outstanding: true,
      latestPatientText: "عندكم أنهي أقسام؟",
      replyText: "الأقسام المتاحة: الجلدية، الأسنان.",
      informationAnswered: true,
    });
    expect(decision).toEqual({ kind: "continue", reason: "outstanding_work" });
  });

  it("is not appended to a reply that is itself a question", () => {
    const decision = resolveConversationLifecycle({
      ...base,
      latestPatientText: "عايز دكتور",
      replyText: "في أنهي قسم تحب؟",
      informationAnswered: true,
    });
    expect(decision).toEqual({ kind: "continue", reason: "reply_is_question" });
  });

  it("still says nothing on a turn that neither finished a goal nor answered an inquiry", () => {
    const decision = resolveConversationLifecycle({
      ...base,
      latestPatientText: "تمام هكمل بعدين",
      replyText: "تحت أمرك.",
      informationAnswered: false,
    });
    expect(decision).toEqual({ kind: "continue", reason: "no_completed_goal" });
  });

  it("ends the episode when the patient answers that offer with a plain no", () => {
    const decision = resolveConversationLifecycle({
      ...base,
      latestPatientText: "لا",
      lastAssistantText: `العنوان: ١٢ كورنيش النيل.\n\n${ANYTHING_ELSE_PROMPT.ar}`,
      replyText: "تمام.",
      informationAnswered: false,
    });
    expect(decision.kind).toBe("close");
    if (decision.kind === "close") expect(decision.reason).toBe("negative_answer");
  });

  it("ends it on خلاص / شكراً too, which need no context", () => {
    for (const message of ["خلاص", "شكراً", "كده تمام"]) {
      const decision = resolveConversationLifecycle({
        ...base,
        latestPatientText: message,
        replyText: "تحت أمرك.",
      });
      expect(decision.kind).toBe("close");
    }
  });

  it("does not end it when the 'no' opens a new request", () => {
    const decision = resolveConversationLifecycle({
      ...base,
      latestPatientText: "لا، عايز أعرف الأسعار",
      lastAssistantText: ANYTHING_ELSE_PROMPT.ar,
      replyText: "تمام.",
    });
    expect(decision.kind).toBe("continue");
  });
});
