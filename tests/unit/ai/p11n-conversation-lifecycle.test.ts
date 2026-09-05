import { describe, expect, it } from "vitest";

import {
  ANYTHING_ELSE_PROMPT,
  CONVERSATION_CLOSING_REPLY,
  askedAnythingElse,
  detectNegativeReply,
  resolveConversationLifecycle,
} from "@/lib/ai/conversation-lifecycle";
import { detectConversationClosure } from "@/lib/ai/conversation-closure";
import {
  containsInternalFieldName,
  scrubInternalFieldNames,
} from "@/lib/ai/patient-intake-contract";

/**
 * P11N — the conversation lifecycle, as a table.
 *
 * Everything here is a pure function of its arguments, which is the point: when
 * a conversation ends must not depend on what the model felt like writing, and
 * it must be checkable without a database or a provider.
 */

function decide(overrides: {
  latestPatientText?: string | null;
  lastAssistantText?: string | null;
  replyText?: string;
  outstanding?: boolean | null;
  goalCompleted?: boolean;
  locale?: "ar" | "en";
}) {
  return resolveConversationLifecycle({
    locale: overrides.locale ?? "ar",
    latestPatientText: overrides.latestPatientText ?? null,
    lastAssistantText: overrides.lastAssistantText ?? null,
    replyText: overrides.replyText ?? "تم إرسال طلب الحجز وهيتواصل معاك فريق العيادة.",
    outstanding: overrides.outstanding === undefined ? false : overrides.outstanding,
    // The default case for this helper is a finished booking; the FAQ case is
    // the one that has to say so.
    goalCompleted: overrides.goalCompleted ?? true,
  });
}

describe("P11N — a completed request offers to keep going", () => {
  it("appends the offer once the turn leaves nothing outstanding", () => {
    const decision = decide({ latestPatientText: "تمام احجزلي", outstanding: false });
    expect(decision.kind).toBe("offer_end");
    if (decision.kind !== "offer_end") return;
    expect(decision.text).toContain(ANYTHING_ELSE_PROMPT.ar);
    // The assistant's own answer is kept; the offer is added to it.
    expect(decision.text).toContain("تم إرسال طلب الحجز");
  });

  it("asks in the language the turn resolved to", () => {
    const decision = decide({
      locale: "en",
      latestPatientText: "book me in",
      replyText: "Your appointment request has been submitted.",
    });
    expect(decision.kind).toBe("offer_end");
    if (decision.kind !== "offer_end") return;
    expect(decision.text).toContain(ANYTHING_ELSE_PROMPT.en);
    expect(decision.text).not.toContain(ANYTHING_ELSE_PROMPT.ar);
  });

  it("never asks while a booking or intake is unfinished", () => {
    // The whole precondition, stated as a test: an unfinished workflow is the
    // one situation where "anything else?" is actively wrong.
    const decision = decide({
      latestPatientText: "احمد محمد",
      replyText: "ممكن تاريخ الميلاد؟",
      outstanding: true,
    });
    expect(decision.kind).toBe("continue");
    if (decision.kind !== "continue") return;
    expect(decision.reason).toBe("outstanding_work");
  });

  it("never asks when the stage could not be resolved at all", () => {
    const decision = decide({ latestPatientText: "عايز احجز", outstanding: null });
    expect(decision).toMatchObject({ kind: "continue", reason: "unknown_state" });
  });

  it("does not stack a second question onto a reply that already asks one", () => {
    const decision = decide({
      latestPatientText: "عايز اعرف المواعيد",
      replyText: "العيادة فاتحة من ٩ لـ٥. تحب أحجزلك؟",
    });
    expect(decision).toMatchObject({ kind: "continue", reason: "reply_is_question" });
  });

  it("does not repeat the offer the model already made itself", () => {
    const decision = decide({
      latestPatientText: "عايز اعرف العنوان",
      replyText: "العيادة في شارع النيل. أقدر أساعدك في حاجة تانية",
    });
    expect(decision).toMatchObject({ kind: "continue", reason: "already_offered" });
  });
});

describe("P11N — a trivial answer is not a finished goal", () => {
  it("does not prompt after a one-line FAQ answer", () => {
    // Nothing is outstanding — the question was asked and answered in one turn
    // — and that is exactly why the offer would be noise here.
    const decision = decide({
      latestPatientText: "العيادة بتفتح إمتى؟",
      replyText: "العيادة فاتحة من ٩ الصبح لـ٥ المسا.",
      goalCompleted: false,
    });
    expect(decision).toMatchObject({ kind: "continue", reason: "no_completed_goal" });
  });

  it.each([
    ["a single price", "الكشف بكام؟", "الكشف ٣٠٠ جنيه."],
    ["one doctor's name", "مين دكتور الجلدية؟", "دكتور أحمد سامي."],
    ["the address", "العيادة فين؟", "في شارع النيل، الدور التاني."],
  ])("leaves %s alone", (_label, question, answer) => {
    expect(
      decide({ latestPatientText: question, replyText: answer, goalCompleted: false }),
    ).toMatchObject({ kind: "continue", reason: "no_completed_goal" });
  });

  it("still prompts when a goal actually concluded", () => {
    const decision = decide({
      latestPatientText: "أيوه أكد الحجز",
      replyText: "تم إرسال طلب الحجز وهيتواصل معاك فريق العيادة.",
      goalCompleted: true,
    });
    expect(decision.kind).toBe("offer_end");
  });

  it("checks outstanding work before it checks whether anything finished", () => {
    // An unfinished workflow is refused on its own terms, so the reason stays
    // legible in the audit rather than collapsing into "nothing finished".
    const decision = decide({
      latestPatientText: "عمر حسن",
      replyText: "ممكن تاريخ الميلاد؟",
      outstanding: true,
      goalCompleted: false,
    });
    expect(decision).toMatchObject({ kind: "continue", reason: "outstanding_work" });
  });

  it("ends a conversation on a goodbye even after a trivial answer", () => {
    // Ending is not gated on the goal having been substantial: a patient who
    // says "شكراً" after a one-line answer has still finished.
    const decision = decide({
      latestPatientText: "شكرا",
      replyText: "العفو.",
      goalCompleted: false,
    });
    expect(decision).toMatchObject({ kind: "close", reason: "closing_message" });
  });

  it("ends a conversation on a negative after a trivial answer too", () => {
    const decision = decide({
      latestPatientText: "لا شكرا",
      replyText: "تمام.",
      goalCompleted: false,
    });
    expect(decision).toMatchObject({ kind: "close", reason: "negative_answer" });
  });
});

describe("P11N — a negative answer ends the conversation", () => {
  it("closes on a bare negative that answers our own offer", () => {
    const decision = decide({
      latestPatientText: "لا",
      lastAssistantText: `تمام.\n\n${ANYTHING_ELSE_PROMPT.ar}`,
    });
    expect(decision).toMatchObject({ kind: "close", reason: "negative_answer" });
    if (decision.kind !== "close") return;
    expect(decision.text).toBe(CONVERSATION_CLOSING_REPLY.ar);
  });

  it.each(["لا", "لأ", "لا شكرا", "خلاص", "بس كده", "no", "no thanks", "nothing else"])(
    "reads %s as a negative",
    (text) => {
      expect(detectNegativeReply(text).isNegative).toBe(true);
    },
  );

  it("closes on a negative that carries its own thanks, with no offer beforehand", () => {
    // "لا شكرا" needs no context: it is an ending on its own terms.
    const decision = decide({ latestPatientText: "لا شكرا", lastAssistantText: null });
    expect(decision).toMatchObject({ kind: "close", reason: "negative_answer" });
  });

  it("closes on a bare closing, with or without an offer beforehand", () => {
    for (const text of ["شكرا", "شكراً", "تمام شكرا", "thanks"]) {
      expect(detectConversationClosure(text).isClosing).toBe(true);
      expect(decide({ latestPatientText: text })).toMatchObject({
        kind: "close",
        reason: "closing_message",
      });
    }
  });

  it("leaves a bare 'لا' alone when we did not ask whether they needed more", () => {
    // Out of that context "لا" is an ordinary answer — to "هل حجزت قبل كده؟",
    // for instance — and ending the thread on it would cut a patient off.
    const decision = decide({ latestPatientText: "لا", lastAssistantText: "هل حجزت عندنا قبل كده؟" });
    expect(decision.kind).not.toBe("close");
  });

  /**
   * P11S superseded the original form of this case, deliberately.
   *
   * It asserted that a negative never closes while work is outstanding, with
   * `lastAssistantText` set to our own "anything else?" — and that pairing
   * cannot legitimately occur. The offer is only ever made when nothing is
   * outstanding, so work outstanding *now*, on the very turn the patient
   * answered it, can only have been created by that turn's own tools reacting
   * to the refusal. The acceptance matrix caught the consequence: "لا شكرا"
   * followed by a `prepare_booking` call left the patient inside a booking
   * funnel they had just declined.
   *
   * The protection the original case was reaching for is the one below it, and
   * it is unchanged: outside our own offer, a negative with work outstanding
   * still continues.
   */
  it("closes on a negative answering our own offer, even if this turn started work", () => {
    const decision = decide({
      latestPatientText: "لا",
      lastAssistantText: ANYTHING_ELSE_PROMPT.ar,
      outstanding: true,
    });
    expect(decision).toMatchObject({ kind: "close", reason: "negative_answer" });
  });

  it("still never closes on a negative we did not solicit, while work is outstanding", () => {
    const decision = decide({
      latestPatientText: "لا",
      lastAssistantText: "هل حجزت عندنا قبل كده؟",
      outstanding: true,
    });
    expect(decision).toMatchObject({ kind: "continue", reason: "outstanding_work" });
  });
});

describe("P11N — a positive answer or a new request keeps the thread open", () => {
  it.each([
    "أيوه",
    "ايوه عايز اغير الميعاد",
    "لا, عايز اغير الميعاد",
    "نعم من فضلك",
    "yes please",
    "no — can I change the appointment?",
  ])("keeps the thread open for %s", (text) => {
    const decision = decide({
      latestPatientText: text,
      lastAssistantText: ANYTHING_ELSE_PROMPT.ar,
      replyText: "تمام، هشوفلك المواعيد المتاحة.",
    });
    expect(decision.kind).not.toBe("close");
  });

  it("recognises our own offer in a prior message, however it was worded", () => {
    expect(askedAnythingElse(ANYTHING_ELSE_PROMPT.ar)).toBe(true);
    expect(askedAnythingElse(ANYTHING_ELSE_PROMPT.en)).toBe(true);
    expect(askedAnythingElse("تحب أساعدك في حاجة تانية؟")).toBe(true);
    expect(askedAnythingElse("Is there anything else I can do?")).toBe(true);
    expect(askedAnythingElse("ممكن تاريخ الميلاد؟")).toBe(false);
    expect(askedAnythingElse(null)).toBe(false);
  });
});

describe("P11N — raw internal identifiers can never reach a patient", () => {
  it("translates the exact list from the production screenshot", () => {
    for (const leak of [
      "أحتاج تصحيح أو استكمال البيانات التالية فقط (national_id, date_of_birth).",
      "أحتاج تصحيح أو استكمال البيانات التالية فقط (phone, date_of_birth).",
    ]) {
      const scrubbed = scrubInternalFieldNames(leak, "ar");
      expect(scrubbed.text).not.toMatch(/national_id|date_of_birth|phone/);
      expect(scrubbed.leaked.length).toBeGreaterThan(0);
      expect(containsInternalFieldName(scrubbed.text, "ar")).toBe(false);
    }
  });

  it("leaves the deterministic lifecycle copy untouched", () => {
    // The two sentences this phase adds are themselves patient-facing copy, so
    // they have to survive the gate they are sent through unchanged.
    for (const locale of ["ar", "en"] as const) {
      for (const copy of [ANYTHING_ELSE_PROMPT[locale], CONVERSATION_CLOSING_REPLY[locale]]) {
        expect(scrubInternalFieldNames(copy, locale).text).toBe(copy);
        expect(containsInternalFieldName(copy, locale)).toBe(false);
      }
    }
  });
});
