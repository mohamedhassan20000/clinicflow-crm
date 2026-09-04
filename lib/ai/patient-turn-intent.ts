import { normalizeHumanText } from "@/lib/ai/human-input";
import { isServiceInquiry } from "@/lib/ai/service-intent";

export type PatientTurnTopic =
  | "privacy"
  | "service"
  | "roster"
  | "availability"
  | "reschedule"
  | "booking"
  | "negative_booking"
  | "faq"
  | "other";

export type PatientTurnRelation = "continuation" | "side_question" | "new_intent";

export type PatientTurnClassification = {
  topic: PatientTurnTopic;
  relation: PatientTurnRelation;
  informationalOnly: boolean;
  explicitBookingConfirmation: boolean;
};

const PRIVACY = /(?:بياناتي|ملفي|معلوماتي|خصوصي|الخصوصية|what\s+(?:data|information).*(?:me|my)|my\s+(?:profile|record|data)|privacy)/i;
const NATIONAL_ID_PRIVACY = /(?:(?:إيه|ايه|ماذا|ما\s+هو|وال?)\s*(?:ال)?رقم\s*(?:القومي|الوطني)|(?:ال)?رقم\s*(?:القومي|الوطني)\s*[؟?]|what(?:'s|\s+is)?\s+my\s+(?:national|civil)\s+id|my\s+(?:national|civil)\s+id\s*[?])/i;
// P11S — "عندكم أنهي أقسام؟" is the single most common opening inquiry there
// is, and it fell through to `other`: the singular `قسم\s+\S+` does not match the
// plural, so a patient asking which departments exist was read as an unclassified
// turn, treated as the start of a booking funnel, and never offered an ending.
const SERVICE = /(?:خدمات?|سعر|أسعار|بكام|تكلفة|كشف\s+\S+|قسم\s+\S+|أقسام|اقسام|عندكم\s+(?:قسم|أسنان|اسنان)|service|price|cost|departments?|dent(?:al|ist|istry))/i;
const ROSTER = /(?:دكاترة|اطباء|أطباء|مين\s+(?:الدكاترة|الأطباء)|who\s+(?:are|is).*(?:doctor|physician)|which\s+doctors?)/i;
const AVAILABILITY = /(?:متاح|متاحة|مواعيد|موعد|يوم|الساعة|بعد\s*(?:الساعة\s*)?[٠-٩۰-۹\d]+|availab|slot|tomorrow|بكرة|بكره)/i;
const RESCHEDULE = /(?:أغيره|اغيره|غيّره|لو\s+متاح\s+غيره|غير\s+(?:حجزي|موعدي|الحجز|الموعد)|تعديل\s+(?:حجزي|موعدي)|أجّل|اجل|reschedul|change\s+my\s+(?:booking|appointment)|move\s+my\s+(?:booking|appointment))/i;
const NEGATIVE_BOOKING = /(?:مش|مو|ما)\s*(?:عايز|حابب|ه)\s*(?:أ|ا)?حجز|لا\s*(?:أريد|اريد)\s*(?:الحجز|أحجز|احجز)|don'?t\s+want\s+to\s+book|not\s+booking|won'?t\s+book/i;
/**
 * V2-CONTAINMENT — the English half is a *frame*, not three collocations.
 *
 * It used to accept exactly `book me`, `book a/an appointment` and `i want to
 * book`, so "I would like to book" — an ordinary way to ask — fell through to
 * `other`. That never showed up while the department rung pinned
 * `prepare_booking` for every unclassified message: the booking opened anyway,
 * by the same default that answered «عندي استفسار» with a doctor's calendar.
 * With the default inverted, an unread booking request now costs the patient a
 * turn, so the frame is completed rather than extended one phrase at a time.
 *
 * Deliberately still framed rather than a bare `\bbook\b`: "cancel my booking"
 * and "change my booking" are other people's topics, and `RESCHEDULE` and
 * `NEGATIVE_BOOKING` are matched ahead of this one precisely so they stay so.
 *
 * This whole module is replaced by the V2 interpreter, which reads intent from
 * language instead of from a pattern list. Nothing should be added here.
 */
const BOOKING =
  /(?:عايز|حابب|أريد|اريد|أرغب|ارغب|ممكن)\s*(?:في\s+)?(?:أ|ا)?حجز|احجز|حجز\s+(?:لي|موعد)|(?:i\s+)?(?:want|need|would\s+like|'d\s+like|wanna)\s+to\s+book|(?:can|could|may)\s+i\s+book|book\s+(?:me|an?\s+appointment|a\s+slot)|make\s+an?\s+appointment/i;
const FAQ = /(?:عنوان|مكان|موقع|ساعات|مواعيد\s+العمل|تأمين|تليفون|هاتف|address|location|opening\s+hours|insurance|phone)/i;
/**
 * The words a patient uses to say yes, and nothing else.
 *
 * Listed separately from the pattern because the real defect was never the
 * vocabulary — «اه», «تمام» and «موافق» were all here — it was that the pattern
 * accepted exactly *one* of them. "اه تمام موافق" is the single most natural way
 * an Egyptian patient agrees to a summary, and it matched nothing, so the
 * server re-issued the same confirmation request and the booking never left the
 * review step. See `isExplicitBookingConfirmation`.
 */
const AFFIRMATION_WORD =
  "(?:نعم|ايوه|أيوه|ايوة|أيوة|اه|آه|أه|اوك|أوك|اوكي|أوكي|تمام|ماشي|حاضر|أكيد|اكيد|موافق|موافقة|موافقه|طبعا|طبعًا|يارب|yes|yep|yeah|yup|ok|okay|okey|sure|fine|alright|right|correct|perfect|great|good|agreed|deal)"

/** The explicit "send it" verbs, which may stand alone or follow an agreement. */
const CONFIRM_VERB =
  "(?:أكد|اكد|أكّد|تأكيد|توكّل|توكل|ابعت|ابعته|إبعت|أرسل|ارسل|أرسله|ارسله|كمّل|كمل|confirm(?:ed|\\s+it)?|go\\s+ahead|please\\s+do|send(?:\\s+it)?|do\\s+it|proceed)"

/**
 * A whole message that is agreement and nothing else.
 *
 * Up to three affirmation words in a row, optionally followed by a send verb,
 * with the separators patients actually type. Still anchored to the entire
 * message: "اه بس غيّر الميعاد" agrees *and* asks for a change, and reading it
 * as a confirmation would submit a booking the patient was editing.
 */
const EXPLICIT_CONFIRMATION = new RegExp(
  `^(?:${AFFIRMATION_WORD}(?:\\s*[،,]?\\s*${AFFIRMATION_WORD}){0,2}` +
    `(?:\\s*[،,]?\\s*(?:${CONFIRM_VERB})(?:\\s+الطلب|\\s+الحجز)?)?` +
    `|(?:${CONFIRM_VERB})(?:\\s+الطلب|\\s+الحجز)?)\\s*[.!؟?]*$`,
  "i",
);

/**
 * Whether this message is an unambiguous "yes" to the question just asked.
 *
 * Normalized first — a patient typing "أيوة" with diacritics, Arabic-Indic
 * digits or doubled punctuation is agreeing exactly as much as one who types
 * "ايوه", and the raw `.trim()` this used to run on said otherwise.
 */
export function isExplicitBookingConfirmation(value: string | null | undefined): boolean {
  const text = normalizeHumanText(value ?? "").trim();
  if (!text) return false;
  return EXPLICIT_CONFIRMATION.test(text);
}

/**
 * Pure, conservative turn classifier. It only narrows tool access; it never
 * grants identity, scheduling, or write authority.
 */
export function classifyPatientTurn(
  value: string | null | undefined,
  options: { workflowEngaged?: boolean } = {},
): PatientTurnClassification {
  const text = (value ?? "").trim();
  let topic: PatientTurnTopic = "other";
  if (NEGATIVE_BOOKING.test(text) && AVAILABILITY.test(text)) topic = "availability";
  else if (NEGATIVE_BOOKING.test(text)) topic = "negative_booking";
  else if (PRIVACY.test(text) || NATIONAL_ID_PRIVACY.test(text)) topic = "privacy";
  else if (RESCHEDULE.test(text)) topic = "reschedule";
  else if (BOOKING.test(text)) topic = "booking";
  // Item #2 — the services/prices concept is read by one shared module now.
  // `SERVICE` stays as its second input rather than being deleted: it carries
  // shapes this classifier has always recognised (a bare "قسم X", a lone
  // "dental") that are about a *department* rather than about services, and
  // dropping them here would move turns that already work.
  else if (isServiceInquiry(text) || SERVICE.test(text)) topic = "service";
  else if (ROSTER.test(text)) topic = "roster";
  else if (AVAILABILITY.test(text)) topic = "availability";
  else if (FAQ.test(text)) topic = "faq";

  const informationalOnly =
    topic === "privacy" ||
    topic === "service" ||
    topic === "roster" ||
    topic === "faq" ||
    topic === "negative_booking" ||
    (topic === "availability" && NEGATIVE_BOOKING.test(text));
  const relation: PatientTurnRelation = informationalOnly
    ? options.workflowEngaged
      ? "side_question"
      : "new_intent"
    : topic === "reschedule" || topic === "booking" || topic === "availability"
      ? "continuation"
      : options.workflowEngaged
        ? "continuation"
        : "new_intent";

  return {
    topic,
    relation,
    informationalOnly,
    explicitBookingConfirmation: isExplicitBookingConfirmation(text),
  };
}

export function toolsForInformationalTurn(
  topic: PatientTurnTopic,
): readonly string[] | null {
  switch (topic) {
    case "privacy":
    case "negative_booking":
      return [];
    case "service":
      return ["list_department_services", "list_clinic_departments"];
    case "roster":
      return ["list_doctors", "list_clinic_departments"];
    case "faq":
      return [
        "get_clinic_info",
        "answer_clinic_faq",
        "list_clinic_insurance",
        "list_clinic_departments",
      ];
    case "availability":
      return ["compare_doctor_availability", "check_availability", "list_available_days"];
    default:
      return null;
  }
}
