/**
 * Who the appointment is *for* — as distinct from who is holding the phone.
 *
 * ## The defect this exists for
 *
 * A WhatsApp thread can be authoritatively linked to a ClinicFlow patient. That
 * linkage is a strong fact and it settles exactly one question: **who the sender
 * is**. It settles nothing at all about **who the next appointment is for**.
 *
 * Manual QA found the two silently collapsed. A linked sender typing "عايز
 * احجز" was taken to be booking for themself, because `conversations.patient_id`
 * was there and the identity-confirmation question ("this thread is linked to a
 * file for X — is that you?") was put to them in the same breath as the
 * beneficiary question. A patient answering "أيوه" to that pair has answered the
 * identity question and has never been asked the other one — so a booking for
 * their wife landed on their own record.
 *
 * So the beneficiary is established deterministically and separately, and the
 * sender's linkage stays where it belongs: authorization and privacy.
 *
 * ## What this module is
 *
 * A reader, nothing more. It looks at one patient-authored message and says
 * whether that message *itself* settles the beneficiary. It resolves no
 * identity, touches no database, and can never produce a booking. A null means
 * "this message did not say", which is the cue for the one short question the
 * server owns the wording of.
 *
 * ## What it will not do
 *
 * * It never infers `self` from linkage, from `patient_id`, or from the absence
 *   of a third-party phrase. Only the patient's own words set `self`.
 * * It never guesses from a relationship word alone: "مراتي تعبانة" is not a
 *   booking instruction. A beneficiary preposition — "لـ", "for" — is required.
 */

import { normalizeHumanText } from "@/lib/ai/human-input";

/** Whose appointment this booking draft is for. */
export type BookingBeneficiary = "self" | "other";

const AR_LETTER = "\\u0621-\\u064A\\u0670-\\u06D3";

/**
 * The people a patient books for, after the beneficiary preposition.
 *
 * Listed rather than derived, for the same reason the closing lexicon is: the
 * cost of reading an ordinary sentence as a third-party booking is a new patient
 * file nobody asked for, so the surface is kept small and auditable.
 */
const AR_OTHER_NOUNS = [
  "شخص\\s*(?:تاني|آخر|اخر|تانى)",
  "حد\\s*(?:تاني|آخر|اخر|تانى)?",
  "واحد\\s*(?:تاني|آخر|اخر)?",
  "صاحب[يى]",
  "صاحبت[يى]",
  "صديق[يى]",
  "صديقت[يى]",
  "مرات[يى]",
  "زوجت[يى]",
  "جوز[يى]",
  "زوج[يى]",
  "ابن[يى]",
  "بنت[يى]",
  "ولاد[يى]",
  "ام[يى]",
  "أم[يى]",
  "والدت[يى]",
  "اب[ويى]+ا?",
  "والد[يى]",
  "اخت[يى]",
  "أخت[يى]",
  "اخو?ي?ا",
  "أخ[يى]",
  "حمات[يى]",
  "عمت?[يى]",
  "خالت?[يى]",
  "جدت[يى]",
  "جد[يى]",
  "قريب[يى]",
  "مريض\\s*(?:تاني|آخر)?",
];

/** «لصاحبي», «الحجز لمراتي», «عايز احجز لابني». */
const AR_FOR_OTHER = new RegExp(
  `(?<![${AR_LETTER}])(?:ل|لـ|علشان|عشان|من\\s*اجل|من\\s*أجل)\\s*(?:${AR_OTHER_NOUNS.join("|")})(?![${AR_LETTER}])`,
  "u",
);

const EN_FOR_OTHER =
  /\bfor\s+(?:my\s+(?:friend|wife|husband|son|daughter|mother|mom|mum|father|dad|sister|brother|kid|child|children|aunt|uncle|grandmother|grandfather|cousin|relative|partner)|someone(?:\s+else)?|somebody(?:\s+else)?|another\s+(?:person|patient)|a\s+(?:friend|relative|family\s+member))\b/i;

/** «لشخص تاني» as a bare answer to «ليك ولا لشخص تاني؟». */
const AR_OTHER_ANSWER = new RegExp(
  `(?<![${AR_LETTER}])(?:لشخص|لحد|لواحد|شخص|حد)\\s*(?:تاني|تانى|آخر|اخر|غير[يى])(?![${AR_LETTER}])`,
  "u",
);
const EN_OTHER_ANSWER = /\b(?:someone|somebody)\s+else\b|\banother\s+person\b/i;

/** «ليا», «لنفسي», «الحجز ليا», "for me", "for myself". */
const AR_FOR_SELF = new RegExp(
  `(?<![${AR_LETTER}])(?:ليا|ل[يى]ا|لنفس[يى]|لشخص[يى]|ل[يى](?:\\s|$)|انا|أنا)(?![${AR_LETTER}])`,
  "u",
);
const EN_FOR_SELF = /\bfor\s+(?:me|myself)\b|\bmyself\b|\bit'?s\s+for\s+me\b|\bmy\s+own\b/i;

/** Long enough to be a story is not an answer to a two-way question. */
const MAX_LENGTH = 240;

/**
 * The negated third-party clause — "مش لشخص تاني", "not for someone else".
 *
 * Manual QA: «أنا قصدي أحجز لنفسي مش لشخص تاني» is the sentence a patient
 * writes to *undo* a third-party reading, and it was read as `other`, because
 * the third-party pattern is tested first and the negation in front of it was
 * invisible. Removing the negated clause before anything is matched leaves the
 * sentence saying only what the patient actually meant — "لنفسي" — which is a
 * self answer.
 *
 * Removal, not a separate verdict: a sentence that negates one person and names
 * another ("مش لمراتي، لابني") must still resolve to `other`, and it does,
 * because only the negated half is taken out.
 */
const AR_NEGATED_OTHER = new RegExp(
  `(?<![${AR_LETTER}])(?:مش|مو|ليس|ماهو|مهو|لا)\\s*(?:ل|لـ)?(?:شخص|حد|واحد|مريض)\\s*(?:تاني|تانى|آخر|اخر|غير[يى])?(?![${AR_LETTER}])`,
  "gu",
);
const EN_NEGATED_OTHER =
  /\b(?:not|isn'?t|no)\s+for\s+(?:someone|somebody|anyone|anybody)(?:\s+else)?\b|\bnot\s+(?:for\s+)?another\s+(?:person|patient)\b/gi;

/**
 * The beneficiary this message establishes, or null when it does not say.
 *
 * `other` is tested first: "الحجز ليا ولا لصاحبي" cannot happen in a real
 * answer, but a message that names another person *and* uses a first-person
 * pronoun ("أنا عايز احجز لمراتي") is unambiguously a third-party booking, and
 * reading the "أنا" out of it is exactly the collapse this module prevents.
 */
export function detectBookingBeneficiary(
  input: string | null | undefined,
): BookingBeneficiary | null {
  const raw = normalizeHumanText(input ?? "");
  if (!raw || raw.length > MAX_LENGTH) return null;
  const text = raw
    .replace(AR_NEGATED_OTHER, " ")
    .replace(EN_NEGATED_OTHER, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text) return null;
  if (AR_FOR_OTHER.test(text) || EN_FOR_OTHER.test(text)) return "other";
  if (AR_OTHER_ANSWER.test(text) || EN_OTHER_ANSWER.test(text)) return "other";
  if (AR_FOR_SELF.test(text) || EN_FOR_SELF.test(text)) return "self";
  return null;
}
