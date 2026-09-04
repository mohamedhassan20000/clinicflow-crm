/**
 * P10 — knowing when a conversation is over.
 *
 * The observed failure, verbatim:
 *
 * ```
 *   assistant  شكراً
 *   patient    عفوا
 *   assistant  تحب أساعدك في حاجة تانية؟ ...
 * ```
 *
 * "عفوا" is not a request. It is the second half of a two-line goodbye, and
 * answering it with a fresh question restarts a conversation the patient has
 * just politely ended — which on WhatsApp is not merely awkward, it is the
 * clinic's number pinging somebody who is finished.
 *
 * The cause is structural rather than a wording problem: nothing in the system
 * had a representation for "this exchange is closing". Every inbound message was
 * a turn that needed a helpful reply, so the model produced one. This module is
 * that missing representation, and it is deliberately pure — no database, no
 * clock, no I/O — so the interesting property ("which messages are closings?")
 * is a table rather than a conversation.
 *
 * ## What it will and will not claim
 *
 * The bar is high on purpose, because the cost of the two errors is wildly
 * asymmetric. Treating a real question as a goodbye leaves a patient unanswered
 * by a clinic; treating a goodbye as a question sends one extra message. So:
 *
 *   * a closing must be **short** — a closing is a few words, and a paragraph
 *     containing "thanks" is a paragraph, not a goodbye;
 *   * it must contain **no question**, no question mark, and no interrogative;
 *   * it must contain **nothing else of substance** — "thanks, and what time do
 *     you open?" is a question that happens to open with thanks;
 *   * and — the rule the caller enforces, not this module — it only ends the
 *     conversation when **nothing is outstanding**. A patient who says "thanks"
 *     in the middle of an unfinished intake still needs the one question they
 *     have not answered.
 */

import { normalizeHumanText } from "@/lib/ai/human-input";

/** Longer than this is prose, and prose is not a goodbye. */
const MAX_CLOSING_WORDS = 6;

/**
 * The closing phrases themselves, normalized (no diacritics, Arabic digits
 * folded, whitespace collapsed) exactly as `normalizeHumanText` leaves them.
 *
 * Listed rather than inferred, for the same reason the affirmation list in
 * `collected-state.ts` is listed: reading an unrecognised word as "goodbye" is
 * the one direction this must never fail in.
 */
const CLOSING_PHRASES: readonly string[] = [
  // English
  "thanks", "thank you", "thankyou", "thx", "ty", "many thanks",
  "thanks a lot", "thank you so much", "much appreciated", "appreciated",
  "youre welcome", "you are welcome", "no problem", "np", "anytime",
  "bye", "goodbye", "good bye", "see you", "take care", "cheers",
  "ok thanks", "okay thanks", "alright thanks", "great thanks", "perfect thanks",
  "got it", "understood", "noted", "sounds good", "perfect", "great",
  "have a good day", "have a nice day", "good night",
  // Arabic — gratitude
  "شكرا", "شكرا جزيلا", "شكرا ليك", "شكرا لك", "شكرا لكم", "متشكر", "متشكرة",
  "مشكور", "مشكورة", "مشكورين", "تسلم", "تسلمي", "تسلموا", "يعطيك العافية",
  "الله يعطيك العافية", "الله يعافيك", "جزاك الله خيرا", "ربنا يكرمك",
  "الف شكر", "شكرا جدا",
  // Arabic — "you're welcome" / acknowledgement
  "عفوا", "العفو", "ولا يهمك", "تحت امرك", "على الرحب والسعة", "اهلا وسهلا",
  "ما فيش مشكلة", "مافي مشكلة", "ولا يهمك ابدا",
  // Arabic — sign-off
  "مع السلامة", "سلام", "الى اللقاء", "باي", "تصبح على خير", "تصبحي على خير",
  "في امان الله", "الله يبارك فيك", "ربنا يخليك",
  // Arabic — acknowledgement that closes
  "تمام", "تمام شكرا", "تمام كده", "ماشي", "ماشي شكرا", "حاضر", "اوكي",
  "اوكي شكرا", "طيب شكرا", "كويس", "ممتاز", "جميل", "فهمت", "خلاص",
];

const CLOSING_SET = new Set(CLOSING_PHRASES);

/**
 * F-3 — the words that are an *acknowledgement* before they are a goodbye.
 *
 * "تمام", "ماشي", "حاضر", "ok" are the literal answer to «طبيبك المعالج هو
 * د. أحمد نبيل. تحب أشوف المواعيد المتاحة معاه؟». Read as closings they did two
 * things, both observed in the acceptance pass: `resolveBookingAuthority`
 * short-circuited to `NONE("closing")` so the acknowledgement turn was stripped
 * of its authority and the booking stalled where it stood, and — with nothing
 * else outstanding — `resolveConversationLifecycle` closed the thread and wiped
 * the episode on a patient saying "OK".
 *
 * The fix is *not* to delete them from the lexicon. "تمام" at the end of a
 * finished exchange really is a goodbye, and `أيوه`/`اه`/`زين` are correctly not
 * closings, so this was never a design decision — it was a lexicon that had no
 * way to ask what the conversation was in the middle of.
 *
 * So the rule is contextual and it is stated in one line: **a message made of
 * nothing but acknowledgement words is not a closing while the clinic is still
 * waiting on the patient for something.** Add a gratitude marker ("تمام شكرا")
 * or a farewell ("تمام، مع السلامة") and it is a closing again in any context,
 * because those say something an acknowledgement does not.
 */
const ACKNOWLEDGEMENT_WORDS: ReadonlySet<string> = new Set([
  "ok", "okay", "k", "kk", "alright", "right", "sure", "fine", "cool", "nice",
  "good", "great", "perfect", "noted", "understood", "got", "it", "sounds",
  "تمام", "ماشي", "حاضر", "اوكي", "اوك", "طيب", "كويس", "ممتاز", "جميل",
  "فهمت", "كده", "زين", "اه", "ايوه", "حلو",
]);

/** Gratitude or a farewell: either one keeps a short message a closing. */
const CLOSING_INTENT_RE =
  /شكر|متشكر|مشكور|تسلم|عافي|يعافي|جزاك|السلامة|سلام|باي|امان\s*الله|تصبح|اللقاء|عفوا|العفو|thank|thx|\bty\b|appreciat|\bbye\b|goodbye|see\s*you|take\s*care|cheers|good\s*(?:night|day)|welcome/;

/**
 * What the caller knows about the conversation that this module must not guess.
 *
 * `outstandingWork` is the caller's server-owned answer to "is the clinic still
 * waiting on this patient for something?" — an unfinished booking rung, a
 * pending clarification, an intake half collected. Omitted, it defaults to
 * `false`, which is exactly the pre-F-3 behaviour for every caller that has not
 * been taught to supply it.
 */
export type ClosureContext = {
  outstandingWork?: boolean;
};

/**
 * Words that, on their own, are the whole of a closing. Used to accept
 * combinations the phrase list cannot enumerate — "تمام تسلم شكرا" is three
 * closing words and nothing else, and listing every permutation of them is not
 * a maintainable way to say that.
 */
const CLOSING_WORDS: ReadonlySet<string> = new Set([
  "thanks", "thank", "you", "thx", "ty", "ok", "okay", "alright", "great",
  "perfect", "cool", "nice", "good", "fine", "welcome", "bye", "goodbye",
  "cheers", "noted", "understood", "appreciated", "much", "a", "lot", "so",
  "شكرا", "جزيلا", "جدا", "ليك", "لك", "لكم", "متشكر", "متشكرة", "مشكور",
  "مشكورة", "تسلم", "تسلمي", "تسلموا", "عفوا", "العفو", "تمام", "ماشي",
  "حاضر", "اوكي", "طيب", "كويس", "ممتاز", "جميل", "خلاص", "سلام", "باي",
  "الله", "يعطيك", "العافية", "يعافيك", "يبارك", "فيك", "يخليك", "ربنا",
  "كده", "الف", "جزاك", "خيرا", "مع", "السلامة", "امان",
]);

/**
 * Anything that makes a message a request rather than a goodbye.
 *
 * Interrogatives in both languages, plus the verbs a patient uses to ask for
 * something. "شكرا، عايز احجز" is not a closing, and neither is "thanks, can I
 * book?".
 */
const REQUEST_MARKERS: readonly RegExp[] = [
  /[?؟]/,
  /\b(?:what|when|where|which|who|why|how|can|could|would|will|do|does|did|is|are|please|want|need|book|cancel|change|appointment|available|price|cost|open)\b/i,
  /(^|[^\p{L}])(?:ايه|إيه|امتى|إمتى|فين|مين|ليه|ازاي|إزاي|كام|هل|ممكن|عايز|عاوز|اريد|أريد|ابغى|أبغى|احجز|أحجز|حجز|ميعاد|موعد|الغاء|إلغاء|سعر|كام|متاح|فاضي|عندكم|عندكو)([^\p{L}]|$)/u,
];

export type ClosureDetection = {
  /** True when this message is a polite ending and nothing else. */
  isClosing: boolean;
  /**
   * True when the closing also thanks. Used only to decide whether a one-line
   * acknowledgement is warranted at all — a bare "bye" needs no reply.
   */
  isGratitude: boolean;
};

/**
 * Whether the patient's message is a conversational closing.
 *
 * Says nothing about whether the conversation may actually end — that depends on
 * what is still outstanding, which lives in the booking stage and the collected
 * fields, and is the caller's decision. See `closureGuidance`.
 */
export function detectConversationClosure(
  raw: string | null | undefined,
  context: ClosureContext = {},
): ClosureDetection {
  const text = normalizeHumanText(raw ?? "")
    .toLocaleLowerCase("en")
    // Apostrophes close up rather than split: "you're" is one word, and
    // splitting it leaves a stray "re" that matches nothing.
    .replace(/['’]/g, "")
    .replace(/[!.,،؛;:"()\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0) return { isClosing: false, isGratitude: false };
  if (REQUEST_MARKERS.some((pattern) => pattern.test(text))) {
    return { isClosing: false, isGratitude: false };
  }

  const words = text.split(" ").filter(Boolean);
  if (words.length > MAX_CLOSING_WORDS) {
    return { isClosing: false, isGratitude: false };
  }

  const isClosing =
    CLOSING_SET.has(text) || words.every((word) => CLOSING_WORDS.has(word));
  if (!isClosing) return { isClosing: false, isGratitude: false };

  // F-3 — a bare acknowledgement mid-flow is an answer, not an ending.
  if (
    context.outstandingWork === true &&
    !CLOSING_INTENT_RE.test(text) &&
    words.every((word) => ACKNOWLEDGEMENT_WORDS.has(word))
  ) {
    return { isClosing: false, isGratitude: false };
  }

  const isGratitude = /شكر|متشكر|مشكور|تسلم|عافية|thank|thx|\bty\b|appreciat/.test(text);
  return { isClosing: true, isGratitude };
}

/**
 * The instruction handed to the model when the patient has just closed.
 *
 * Two shapes, and the difference between them is the whole point:
 *
 *   * **Nothing outstanding** — reply with at most one short courtesy line, or
 *     nothing at all, and stop. Explicitly: do not ask how else you can help, do
 *     not re-open intake, do not volunteer an FAQ, do not call a tool.
 *   * **Something outstanding** — the conversation is not over, because the
 *     clinic is still waiting on an answer. One brief reminder of the single
 *     outstanding question, and nothing more.
 */
export function closureGuidance(input: {
  detection: ClosureDetection;
  /** The one thing still being waited on, if any. Free of patient content. */
  outstanding: string | null;
  locale: "ar" | "en";
}): string | null {
  if (!input.detection.isClosing) return null;
  if (input.outstanding) {
    return input.locale === "ar"
      ? "المريض أنهى الحديث بأدب، لكن ما زال هناك سؤال واحد لم يُجب عليه: " +
          `${input.outstanding}. ردّ بكلمة مجاملة قصيرة ثم ذكّره بذلك السؤال وحده باختصار. ` +
          "لا تفتح موضوعًا جديدًا ولا تعيد أي سؤال أُجيب عنه بالفعل."
      : "The patient has closed the conversation politely, but one question is still " +
          `unanswered: ${input.outstanding}. Reply with a short courtesy line and then briefly ` +
          "restate that one question only. Do not open a new topic and do not repeat anything " +
          "they have already answered.";
  }
  return input.locale === "ar"
    ? "المريض أنهى المحادثة بأدب ولا يوجد أي سؤال معلّق. " +
        (input.detection.isGratitude
          ? "ردّ بعبارة مجاملة واحدة قصيرة جدًا ثم توقف. "
          : "لا داعي لأي رد إضافي؛ اكتفِ بكلمة وداع قصيرة جدًا أو لا شيء. ") +
        "لا تسأل «تحب أساعدك في حاجة تانية؟» ولا أي سؤال آخر، ولا تفتح التسجيل أو الحجز أو " +
        "الأسئلة الشائعة من جديد، ولا تستدعِ أي أداة."
    : "The patient has closed the conversation politely and nothing is outstanding. " +
        (input.detection.isGratitude
          ? "Reply with one very short courtesy line and stop. "
          : "No further reply is needed; a very short sign-off or nothing at all. ") +
        "Do not ask \"how else can I help?\" or any other question, do not re-open intake, " +
        "booking, or FAQs, and do not call any tool.";
}
