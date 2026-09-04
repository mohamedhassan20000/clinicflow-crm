/**
 * P11N — the deterministic end of a patient conversation.
 *
 * ## The defect
 *
 * `conversation-closure.ts` knows what a goodbye looks like, but everything it
 * knows is handed to the *model* as a paragraph of guidance. Nothing in the
 * system ever ended a thread, and nothing ever forgot what a finished thread
 * had been in the middle of. Two consequences, both observed in production:
 *
 *   1. A patient whose booking finished was never asked whether they needed
 *      anything else, and a patient who said "لا" was answered as though "لا"
 *      were the answer to whatever question the workflow still had open.
 *   2. Closing a thread from the Inbox flipped `conversations.status` and
 *      nothing else. `ai_collected_data`, `ai_pending_clarification` and
 *      `ai_booking_stage` survived, so the next message from that number
 *      reopened the thread *and* resumed a half-finished intake — which is how
 *      the same "I still need these details" prompt came back days later.
 *
 * This module is the missing decision, and it is pure on purpose: whether a
 * turn ends the conversation is a table of inputs, not a database question and
 * not a model judgement. `conversation-reset.ts` owns the effects.
 *
 * ## The rule, stated once
 *
 * The assistant may only propose an ending when **nothing is outstanding** —
 * no pending clarification, no unfinished booking or intake rung. That single
 * precondition is what stops "أقدر أساعدك في حاجة تانية؟" from interrupting a
 * patient who still owes us a date of birth, and it is checked by the caller
 * from server-owned stage state, never inferred from the sentence.
 *
 * Offering to help further needs a **second** precondition, and it is the one
 * that keeps the assistant from sounding like a phone menu. So the offer is
 * made only when the turn actually *finished* something:
 *
 *   * a goal concluded — an authoritative write committed (a booking request
 *     created, an intake filed, an appointment cancelled), or a multi-step
 *     exchange the conversation had been working through reached its end; or
 *   * **P11S** — an informational request was answered from authoritative
 *     clinic data and needs nothing further. Departments, the doctors in a
 *     department, a service price, the address, the phone: the patient asked
 *     one thing, got it, and the exchange is over unless they say otherwise.
 *
 * P11N deliberately excluded the second case, on the reasoning that a one-line
 * FAQ answer followed by a prompt reads as a script. Running it against real
 * threads showed the opposite: without the prompt a finished inquiry has no
 * ending at all, so the thread sits open forever and the patient is never given
 * the one-word exit ("لا، شكراً") that ends it. The offer is what makes an
 * inquiry closable — and what arms the five-minute idle close in
 * `conversation-auto-close.ts` when they say nothing at all.
 *
 * The precondition that has *not* moved is the first one: nothing outstanding.
 * An informational side question asked in the middle of an unfinished booking
 * still gets no prompt, because the booking is still owed an answer.
 *
 * Ending is deliberately *not* gated on that second precondition. A patient who
 * says "شكراً" after a one-line answer has still ended the conversation, and
 * whether we thought their goal was substantial has no bearing on it.
 *
 * Given that, a turn ends the conversation when the patient's message is:
 *
 *   * a bare closing — `detectConversationClosure` already decides this, with a
 *     deliberately conservative table ("شكراً", "تمام", "bye"); or
 *   * a clear negative **that is answering our own "anything else?"** — a bare
 *     "لا" is only an ending when we just asked a yes/no question whose "no"
 *     means "nothing else". Out of that context "لا" is an ordinary answer and
 *     is left alone; or
 *   * a negative that carries its own gratitude ("لا شكرا", "no thanks"), which
 *     needs no context to read as an ending.
 *
 * Anything else — a question, a new request, "أيوه" — keeps the thread open.
 */

import {
  detectConversationClosure,
  type ClosureDetection,
} from "@/lib/ai/conversation-closure";
import { normalizeHumanText } from "@/lib/ai/human-input";

export type LifecycleLocale = "ar" | "en";

/**
 * The one sentence that offers to keep going, and the marker that recognises it
 * again on the next turn.
 *
 * Fixed copy rather than something the model writes, because the *next* turn's
 * reading of "لا" depends on having asked exactly this. A prompt the model
 * paraphrases is a prompt we cannot detect afterwards.
 */
export const ANYTHING_ELSE_PROMPT: Record<LifecycleLocale, string> = {
  ar: "أقدر أساعدك في حاجة تانية؟",
  en: "Can I help you with anything else?",
};

/** The short courtesy line that ends a thread. One sentence, never a question. */
export const CONVERSATION_CLOSING_REPLY: Record<LifecycleLocale, string> = {
  ar: "تمام، شكرًا لتواصلك مع العيادة. تحت أمرك في أي وقت.",
  en: "Of course — thank you for contacting the clinic. We are here whenever you need us.",
};

/**
 * Substrings that identify our own offer in a previous outbound message,
 * normalized the way `normalizeHumanText` leaves text.
 *
 * Deliberately several: the register enforcer and the clinic's configured style
 * can reword the surrounding sentence, and older threads carry the phrasings
 * the model used to produce before this prompt was deterministic.
 */
const ANYTHING_ELSE_MARKERS: readonly string[] = [
  "حاجة تانية",
  "حاجه تانيه",
  "شيء اخر",
  "شيء آخر",
  "خدمة اخرى",
  "anything else",
  "something else",
  "help you with anything",
];

/**
 * Clear negatives. Short, and checked as the *whole* message — "لا, بس عايز
 * اغير الميعاد" is a request that opens with "لا", and it must not end
 * anything.
 */
const NEGATIVE_PHRASES: readonly string[] = [
  // Arabic
  "لا", "لأ", "لاء", "لاا", "لالا", "لا لا",
  "لا شكرا", "لأ شكرا", "لا شكرا ليك", "لا متشكر", "لأ متشكر",
  "لا مش محتاج", "مش محتاج", "مش محتاجة", "مش محتاج حاجة", "مفيش حاجة",
  "مفيش", "مافي شي", "ما في شي", "لا مفيش", "خلاص", "خلاص كده", "بس كده",
  "كده تمام", "كفاية كده", "كفاية", "ولا حاجة", "لا حاجة", "لا يوجد",
  "هذا كل شيء", "دا كل حاجة", "بس", "لا خلاص", "لأ خلاص", "لا تمام", "لأ تمام",
  // English
  "no", "nope", "nah", "no thanks", "no thank you", "nothing", "nothing else",
  "that is all", "thats all", "that is it", "thats it", "all good",
  "im good", "i am good", "we are good", "were good", "not right now",
  "no im good", "no i am good", "nothing more", "no more",
];

const NEGATIVE_SET = new Set(NEGATIVE_PHRASES);

/** Gratitude inside a negative, which makes it an ending on its own. */
const GRATITUDE = /شكر|متشكر|مشكور|تسلم|thank|thx|\bty\b/;

/**
 * Anything that turns "no" into the first word of a request rather than the
 * whole of an answer. Same asymmetry as `conversation-closure.ts`: closing a
 * thread on a patient who was still asking is the expensive mistake.
 */
const REQUEST_MARKERS: readonly RegExp[] = [
  /[?؟]/,
  /\b(?:what|when|where|which|who|why|how|can|could|would|will|please|want|need|book|cancel|change|appointment|available|price|cost|open|another|other)\b/i,
  /(^|[^\p{L}])(?:ايه|امتى|فين|مين|ليه|ازاي|كام|هل|ممكن|عايز|عاوز|اريد|ابغى|احجز|حجز|ميعاد|موعد|الغاء|سعر|متاح|فاضي|عندكم|عندكو|تاني|اخرى|اخر)([^\p{L}]|$)/u,
];

function normalizeForMatch(raw: string | null | undefined): string {
  return normalizeHumanText(raw ?? "")
    .toLocaleLowerCase("en")
    .replace(/['’]/g, "")
    .replace(/[!.,،؛;:"()\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type NegativeDetection = {
  /** The whole message is a clear "no". */
  isNegative: boolean;
  /** That "no" also thanks, so it reads as an ending without any context. */
  withGratitude: boolean;
};

/** Whether the patient's message is a bare negative and nothing else. */
export function detectNegativeReply(
  raw: string | null | undefined,
): NegativeDetection {
  const text = normalizeForMatch(raw);
  if (!text) return { isNegative: false, withGratitude: false };
  if (REQUEST_MARKERS.some((pattern) => pattern.test(text))) {
    return { isNegative: false, withGratitude: false };
  }
  if (!NEGATIVE_SET.has(text)) return { isNegative: false, withGratitude: false };
  return { isNegative: true, withGratitude: GRATITUDE.test(text) };
}

/** Did our own previous outbound message offer to help with anything else? */
export function askedAnythingElse(lastAssistantText: string | null | undefined): boolean {
  const text = normalizeForMatch(lastAssistantText);
  if (!text) return false;
  return ANYTHING_ELSE_MARKERS.some((marker) => text.includes(normalizeForMatch(marker)));
}

/** Does this reply already put a question to the patient? */
function endsWithQuestion(text: string): boolean {
  return /[?؟]\s*$/.test(text.trim());
}

export type LifecycleDecision =
  /** Nothing to do — the thread stays open exactly as it is. */
  | { kind: "continue"; reason: LifecycleReason }
  /** Append the offer, and remember that we made it. */
  | { kind: "offer_end"; text: string }
  /** Replace the reply with a closing line, then close and reset the thread. */
  | { kind: "close"; text: string; reason: "closing_message" | "negative_answer" };

export type LifecycleReason =
  | "outstanding_work"
  | "unknown_state"
  | "no_completed_goal"
  | "reply_is_question"
  | "already_offered"
  | "ongoing";

export type LifecycleInput = {
  locale: LifecycleLocale;
  /** The patient's newest message. */
  latestPatientText: string | null;
  /** The assistant's previous outbound message on this thread, if any. */
  lastAssistantText: string | null;
  /** The reply this turn produced, before any lifecycle edit. */
  replyText: string;
  /**
   * Whether the workflow is still waiting on the patient for something.
   *
   * `null` means the caller could not resolve stage state at all (tracking off,
   * authorization failed). That is treated as "assume there is work": the
   * assistant proposes no ending it cannot justify.
   */
  outstanding: boolean | null;
  /**
   * P11S — whether this turn answered an informational request and nothing
   * more.
   *
   * Server-computed from the turn's own classification and read receipts, never
   * from the sentence: true only when the turn was classified informational,
   * produced an answer, and left nothing outstanding. Together with
   * {@link goalCompleted} this is what makes an ending offerable.
   */
  informationAnswered?: boolean;
  /**
   * Whether a substantive goal concluded on this turn.
   *
   * Server-computed by the caller from the turn's own evidence — a committed
   * write receipt, a cancellation the database confirmed, or a multi-step
   * workflow that has just reached its end — never from the sentence and never
   * from the model. False for an ordinary question-and-answer turn, which is
   * exactly the case that should not be followed by "anything else?".
   */
  goalCompleted: boolean;
  /**
   * The engine has already decided this turn ends the conversation.
   *
   * Server-owned, like every other field here: it comes from the V2 flow
   * engine's `end_conversation` handler, which cleared the stack, and not from
   * reading the patient's sentence. It therefore outranks the closure
   * heuristics below rather than competing with them — those exist to *infer*
   * an ending, and there is nothing to infer once one has been decided.
   *
   * Optional and false by default, so the legacy path is unchanged.
   */
  endRequested?: boolean;
};

/**
 * The whole decision, as one total function.
 *
 * Order matters and is deliberate: an ending is recognised before an offer is
 * made, so a patient who says "شكراً" at the end of a finished booking is
 * thanked and released rather than asked a fresh question — the exact failure
 * `conversation-closure.ts` was written about.
 */
export function resolveConversationLifecycle(input: LifecycleInput): LifecycleDecision {
  // A decided ending outranks every inference below it. See `endRequested`.
  if (input.endRequested === true) {
    return {
      kind: "close",
      text: CONVERSATION_CLOSING_REPLY[input.locale],
      reason: "closing_message",
    };
  }

  // P11S — an answer to our own "anything else?" outranks `outstanding`.
  //
  // `outstanding` is read *after* the turn's tools have run, and the acceptance
  // matrix caught what that allows: a patient replying "لا شكرا" to the closing
  // offer, a model calling `prepare_booking` on that message anyway, and the
  // freshly-created booking rung then reporting work outstanding — so the
  // conversation the patient had just ended stayed open, in a funnel they had
  // explicitly declined.
  //
  // The asymmetry that makes this safe is that `askedAnythingElse` can only be
  // true because *we* made the offer, and the offer requires that nothing was
  // outstanding when it was made. So any work outstanding now was created by
  // this turn, in response to a message that was a refusal. There is no reading
  // of that state in which the conversation should continue.
  const answeringOurOffer = askedAnythingElse(input.lastAssistantText);
  if (answeringOurOffer) {
    const closingNow = detectConversationClosure(input.latestPatientText, {
      outstandingWork: false,
    });
    const negativeNow = detectNegativeReply(input.latestPatientText);
    if (closingNow.isClosing || negativeNow.isNegative) {
      return {
        kind: "close",
        text: CONVERSATION_CLOSING_REPLY[input.locale],
        reason: closingNow.isClosing ? "closing_message" : "negative_answer",
      };
    }
  }

  if (input.outstanding === null) return { kind: "continue", reason: "unknown_state" };
  if (input.outstanding) return { kind: "continue", reason: "outstanding_work" };

  // F-3 — the same context-aware reading the turn opener uses.
  const closure: ClosureDetection = detectConversationClosure(
    input.latestPatientText,
    // `false` by construction: both branches above have already returned when
    // work is outstanding. Passed explicitly so the two callers of
    // `detectConversationClosure` cannot drift on what "تمام" means.
    { outstandingWork: false },
  );
  const negative = detectNegativeReply(input.latestPatientText);
  const endsConversation =
    closure.isClosing ||
    (negative.isNegative &&
      (negative.withGratitude || askedAnythingElse(input.lastAssistantText)));
  if (endsConversation) {
    return {
      kind: "close",
      text: CONVERSATION_CLOSING_REPLY[input.locale],
      reason: closure.isClosing ? "closing_message" : "negative_answer",
    };
  }

  // Nothing outstanding is not the same as something finished. A turn that
  // asked a question back, or that is mid-way through gathering something, has
  // concluded nothing and gets no prompt.
  if (!input.goalCompleted && !input.informationAnswered) {
    return { kind: "continue", reason: "no_completed_goal" };
  }

  // The offer is only appended to a reply that has actually finished saying
  // something. A reply that already ends in a question is mid-exchange however
  // the stage reads, and two questions in one message is a form.
  const reply = input.replyText.trim();
  if (!reply || endsWithQuestion(reply)) {
    return { kind: "continue", reason: "reply_is_question" };
  }
  if (askedAnythingElse(reply)) return { kind: "continue", reason: "already_offered" };

  return { kind: "offer_end", text: `${reply}\n\n${ANYTHING_ELSE_PROMPT[input.locale]}` };
}
