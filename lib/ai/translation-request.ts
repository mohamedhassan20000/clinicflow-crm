/**
 * "مش فاهم قولها بالعربي" — a request to say the *last thing again*, in another
 * language.
 *
 * ## The defect this exists for
 *
 * Manual QA: the assistant answered in English mid-booking, the patient replied
 * «مش فاهم قولها بالعربي», and nothing in the system had a representation for
 * that message. The classifier found no booking topic in it, so it fell through
 * to the model as an ordinary turn — which read it as a fresh request, restated
 * something adjacent, and in one thread treated it as an answer to the question
 * that was open at the time.
 *
 * It is neither. It is a request about the *previous assistant message*: repeat
 * that meaning, in this language, and change nothing else. In particular it
 * settles nothing about the booking, answers no outstanding question, and must
 * leave every collected field and the stage exactly where they were.
 *
 * ## What this module is
 *
 * A reader, and only that. It looks at one patient message and says whether it
 * asks for a restatement and in which language. It performs no translation,
 * touches no state, and can never move a booking forward.
 *
 * ## What it will not claim
 *
 * The bar is the same asymmetry the closure lexicon uses: reading a real
 * question as a translation request answers the wrong thing, so a message must
 * be **short** and must be *about* language. "بالعربي عايز أحجز يوم 9" names a
 * language and is still a booking instruction — the day marker and the booking
 * verb are request markers, and a message carrying one is not claimed here.
 */

import { normalizeHumanText } from "@/lib/ai/human-input";

export type TranslationRequest = {
  /** The language the patient wants the previous message restated in. */
  target: "ar" | "en";
};

/** Longer than this is a sentence with a topic, not "say that again". */
const MAX_WORDS = 8;

/** «بالعربي», «عربي», "in Arabic". */
const AR_TARGET =
  /(?:بالعرب[يى]|بالعربية|بالعربيه|عرب[يى](?![ء-ي])|بلعرب[يى]|\bin\s+arabic\b|\barabic\b)/iu;
/** «بالانجليزي», "in English". */
const EN_TARGET =
  /(?:بالانجليز[يى]|بالإنجليز[يى]|بالانجليزية|بالإنجليزية|انجليز[يى]|إنجليز[يى]|\bin\s+english\b|\benglish\b)/iu;

/**
 * The asking half: either an explicit "say it" verb, or an admission of not
 * understanding. One of the two is required, so a bare "عربي" — which is as
 * often an answer to "which language?" as it is a request — claims nothing.
 */
const SAY_IT =
  /(?:قول(?:ها|هالي|هالى|لي|لى|يها)?|اكتب(?:ها|هالي)?|ترجم(?:ها|لي)?|رددها|اعد(?:ها)?|كلمن[يى]|\bsay\s+(?:that|it|this)\b|\brepeat\b|\btranslate\b|\bwrite\s+(?:that|it)\b|\btell\s+me\s+(?:that|it)\b)/iu;
const NOT_UNDERSTOOD =
  /(?:مش\s*فاهم|مش\s*فاهمة|مش\s*فاهمه|م(?:ا)?\s*فهمت|لم\s*أفهم|مش\s*واضح|مو\s*فاهم|\bi\s*(?:do\s*not|don'?t)\s*understand\b|\bdidn'?t\s*understand\b|\bnot\s*clear\b)/iu;

/**
 * Anything that makes the message a request of its own rather than a request
 * about the previous message. Same shape as the closure module's markers.
 */
const CARRIES_ITS_OWN_TOPIC: readonly RegExp[] = [
  /\d/u,
  /(?:احجز|أحجز|حجز|ميعاد|موعد|دكتور|دكتورة|طبيب|قسم|سعر|كام|الغاء|إلغاء|غير|عايز|عاوز|اريد|أريد)/u,
  /\b(?:book|appointment|doctor|department|price|cost|cancel|change|want|need)\b/i,
];

/**
 * The restatement this message asks for, or null.
 *
 * Null is the overwhelmingly common answer, and deliberately so: this is only
 * ever true for a message that is *about* the previous reply's language and
 * carries nothing else.
 */
export function readTranslationRequest(
  input: string | null | undefined,
): TranslationRequest | null {
  const text = normalizeHumanText(input ?? "");
  if (!text) return null;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > MAX_WORDS) return null;
  if (CARRIES_ITS_OWN_TOPIC.some((pattern) => pattern.test(text))) return null;

  const asks = SAY_IT.test(text) || NOT_UNDERSTOOD.test(text);
  if (!asks) return null;
  // English is tested first: «بالانجليزي» contains no Arabic-target substring,
  // but "in English" and "arabic" can co-occur in a bilingual clinic's thread,
  // and the more specific claim should win.
  if (EN_TARGET.test(text)) return { target: "en" };
  if (AR_TARGET.test(text)) return { target: "ar" };
  return null;
}

/**
 * The instruction handed to the model on a restatement turn.
 *
 * Deliberately prescriptive about what must *not* happen: the booking state is
 * untouched, so the reply must not advance a step, must not re-ask anything
 * settled, and must not read the request as an answer to whatever question was
 * open. It restates one message and stops.
 */
export function translationGuidance(input: {
  request: TranslationRequest;
  locale: "ar" | "en";
}): string {
  const language =
    input.request.target === "ar"
      ? input.locale === "ar"
        ? "العربية"
        : "Arabic"
      : input.locale === "ar"
        ? "الإنجليزية"
        : "English";
  return input.locale === "ar"
    ? `المريض لم يفهم رسالتك السابقة وطلب إعادتها ب${language}. أعد صياغة **رسالتك السابقة مباشرة** ` +
        `ب${language} بنفس المعنى ونفس التفاصيل ونفس السؤال، ولا تضف معلومة جديدة. ` +
        "هذه الرسالة ليست إجابة على أي سؤال في الحجز: لا تعتبرها اختيارًا لقسم أو طبيب أو يوم أو وقت، " +
        "ولا تتقدّم خطوة في الحجز، ولا تعيد سؤالًا سبق الرد عليه. حالة الحجز كما هي تمامًا."
    : `The patient did not understand your previous message and asked for it in ${language}. ` +
        `Restate **your immediately previous message** in ${language} with the same meaning, the ` +
        "same details and the same question. Add nothing new. This message is not an answer to " +
        "any booking question: do not read it as a department, doctor, day or time selection, do " +
        "not advance the booking a step, and do not re-ask anything already answered. The booking " +
        "state is exactly as it was.";
}
