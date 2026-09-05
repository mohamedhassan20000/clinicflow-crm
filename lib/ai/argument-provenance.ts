/**
 * F-11 — an entity argument the patient never uttered carries no information.
 *
 * ## The defect this exists for
 *
 * Three of the six failures in the managed live acceptance run
 * (`existing-patient-booking-ar#p1`, `existing-patient-booking-ar#p2`,
 * `doctors-roster#p1`) share one shape. A linked patient opens with an ordinary
 * booking request — "محتاج موعد من فضلك", "ممكن أحجز؟", "I would like to book"
 * — the authority pins `prepare_booking`, and the model, obliged to produce
 * arguments for a tool whose `department` field is described as "the patient's
 * own words", supplies a department the patient never mentioned.
 *
 * From there the funnel is dead. `prepare_booking` treats any `department`
 * argument as an explicit choice: it suppresses the treating-doctor opening
 * (`isBookingOpening` is false the moment a department is supplied), fails to
 * resolve the invented string, and returns `needs_clarification` with the
 * department list. The reply asks which department the patient wants. The
 * patient answers something that is not a department, because they were never
 * asking about departments. The ladder never leaves `department`.
 *
 * The recorded state progression is the fingerprint of exactly this:
 *
 * ```
 *   existing-patient-booking-ar#p2   department → department → department → department
 *   doctors-roster#p1                reply matched /which department/
 * ```
 *
 * ## The rule
 *
 * > A free-text entity argument is honoured only when the patient's own words
 * > this episode contain it. Otherwise it is **absent**, not wrong.
 *
 * "Absent" is the important half. Discarding the argument does not produce an
 * error and does not contradict the model; it produces the call the model
 * should have made, whose outcome is server-owned: the treating-doctor opening
 * for a patient who has a file, the real department list for a stranger, the
 * already-settled department for a booking in progress. A genuine "the patient
 * asked for a department this clinic does not have" is untouched, because those
 * words *are* in the transcript.
 *
 * ## Why not just tell the model
 *
 * The prompt already tells it. The live run is the evidence that a 4.5-class
 * model under a `toolChoice` pin will fill a required-looking argument anyway,
 * and no amount of wording removes the pressure that produces it. This is the
 * server declining to act on a value whose only source is the model.
 *
 * Pure — no `server-only`, no database — so the production tools and the
 * acceptance harness run the identical decision.
 */

import { normalizeEntityText } from "@/lib/ai/entity-resolution";

/**
 * Words that are part of *asking* rather than part of a name.
 *
 * An argument made only of these is not an entity in any language: "احجز",
 * "appointment", "booking with" name nothing. They are removed before the
 * comparison so that an argument which is pure request-frame is treated as
 * absent even in the rare case the patient did type those exact words.
 */
const FRAME_WORDS: readonly string[] = [
  "عايز", "عاوز", "عايزة", "عاوزة", "محتاج", "محتاجة", "اريد", "أريد", "ابغى",
  "أبغى", "أبي", "ابي", "بدي", "ممكن", "احجز", "أحجز", "حجز", "نحجز", "يحجز",
  "موعد", "مواعيد", "ميعاد", "معاد", "مع", "عند", "في", "لو", "سمحت", "من",
  "فضلك", "رجاء", "رجاءً", "دكتور", "دكتورة", "د", "قسم", "القسم", "عيادة",
  "العيادة", "طبيب", "طبيبة", "اي", "أي", "انهي", "أنهي", "كشف", "الكشف",
  "please", "i", "we", "want", "need", "would", "like", "to", "book",
  "booking", "reserve", "an", "a", "the", "appointment", "with", "for",
  "slot", "doctor", "dr", "department", "clinic", "any", "some", "general",
  "visit", "consultation", "check", "checkup", "up",
];

const FRAME_TOKENS: ReadonlySet<string> = new Set(
  FRAME_WORDS.flatMap((word) => variantsOf(word)),
);

/**
 * Every normalized reading of one raw word.
 *
 * The Arabic definite article is a *variant*, never a replacement: a department
 * stored as "الأسنان" and a patient typing "اسنان" are the same word, and
 * comparing only the full forms would reject the argument the model correctly
 * normalized. Both readings are admitted on both sides of the comparison, which
 * can only ever make a genuine match easier to find — never an invented one.
 */
function variantsOf(word: string): string[] {
  const out = new Set<string>();
  const push = (value: string) => {
    for (const token of normalizeEntityText(value).split(" ")) {
      if (token.length >= 2) out.add(token);
    }
  };
  push(word);
  if (word.startsWith("ال") && word.length > 3) push(word.slice(2));
  return [...out];
}

/** Every content token of a text, article variants included, frame words kept. */
function contentTokens(value: string): string[] {
  const out = new Set<string>();
  for (const raw of value.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length === 0) continue;
    for (const token of variantsOf(raw)) out.add(token);
  }
  return [...out];
}

/**
 * The vocabulary of everything the patient typed this episode.
 *
 * Built once per turn and passed to each check, so a tool with two entity
 * arguments does not re-tokenize the transcript twice.
 */
export type PatientVocabulary = {
  tokens: ReadonlySet<string>;
  /** How many utterances went in. Zero means the check has no evidence to work from. */
  utterances: number;
};

export function buildPatientVocabulary(
  utterances: readonly string[],
): PatientVocabulary {
  const tokens = new Set<string>();
  let counted = 0;
  for (const raw of utterances) {
    if (typeof raw !== "string" || raw.trim().length === 0) continue;
    counted += 1;
    for (const token of contentTokens(raw)) tokens.add(token);
  }
  return { tokens, utterances: counted };
}

/**
 * Did the patient actually say this?
 *
 * `true` — at least one content token of the argument, outside the request
 * frame, appears in what the patient wrote. The argument is honoured.
 *
 * `false` — the argument is either pure request-frame, or names something the
 * patient never mentioned. The caller treats it as absent.
 *
 * With **no vocabulary at all** (`utterances === 0`) the answer is `true`. A
 * turn whose transcript could not be read must not silently start discarding
 * the model's arguments: the failure mode of a missing transcript is the
 * behaviour that shipped before this module, not a new one nobody has tested.
 * The intake gate in `intake-provenance.ts` deliberately makes the opposite
 * choice, because the consequence there is a fabricated medical record rather
 * than a redundant question.
 */
export function isPatientSourcedArgument(
  value: string | null | undefined,
  vocabulary: PatientVocabulary,
): boolean {
  const text = (value ?? "").trim();
  if (text.length === 0) return false;
  if (vocabulary.utterances === 0) return true;
  const tokens = contentTokens(text).filter((token) => !FRAME_TOKENS.has(token));
  if (tokens.length === 0) return false;
  return tokens.some((token) => vocabulary.tokens.has(token));
}

/**
 * The argument as the tool should read it: the patient's value, or `undefined`.
 *
 * Returning `undefined` rather than a sentinel is deliberate — every call site
 * already has correct, server-owned behaviour for an argument that was not
 * supplied, and this makes the discarded case take that path exactly.
 */
export function patientSourcedArgument(
  value: string | null | undefined,
  vocabulary: PatientVocabulary,
): string | undefined {
  return isPatientSourcedArgument(value, vocabulary) ? (value ?? undefined) : undefined;
}
