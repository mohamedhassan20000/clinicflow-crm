/**
 * The two deterministic new-patient intake answers the server owns the reading
 * of: the English spelling of a name, and blood type.
 *
 * Both were previously the model's job, and both are the kind of job a model
 * should not have. A spelling it "confirms" on the patient's behalf is a name
 * nobody chose, written onto a medical file; a blood type it decides to skip is
 * a question that was never asked. So the reading of the answer happens here —
 * pure, table-driven, no clinic data, no I/O — and the caller acts on the
 * verdict rather than on a sentence.
 *
 * Nothing in this module grants authority. It reads one short message and
 * returns one of a closed set of verdicts; every write that follows still goes
 * through the same staging RPC, with the same validation, as before.
 */

import { normalizeHumanText } from "@/lib/ai/human-input";
import { toTitleCaseName } from "@/lib/ai/name-transliteration";

const ARABIC_SCRIPT = /[؀-ۿ]/;

/**
 * "أيوه", "تمام", "صح", "yes" — an unqualified agreement and nothing else.
 *
 * Anchored to the whole message on purpose. "تمام بس خليه Anas" agrees *and*
 * corrects, and reading only the first word of it would file the spelling the
 * patient just replaced. A message with a Latin name in it is handled by the
 * correction branch below, which is tried first for exactly that reason.
 */
const AFFIRMATION =
  /^(?:نعم|أيوه|ايوه|ايوة|أيوة|اه|آه|أه|تمام|صح|صحيح|مظبوط|مضبوط|ماشي|أكيد|اكيد|زي\s*ما\s*كتبت|كده\s*تمام|تمام\s*كده|yes|yep|yeah|ok|okay|correct|right|exactly|perfect|that'?s\s*right|looks?\s*good)\s*[.!،؟?]*$/i;

/** "لا", "غلط", "no" — a rejection with no replacement spelling in it. */
const NEGATION =
  /^(?:لا|لأ|غلط|مش\s*صح|مش\s*مظبوط|خطأ|no|nope|wrong|not\s*(?:correct|right))\s*[.!،؟?]*$/i;

/**
 * The framing a patient wraps a corrected spelling in — "خليه …", "اكتبه …",
 * "make it …", "it should be …".
 *
 * Shape only. Removing it can only narrow what is left, and what is left is
 * still required to be Latin letters before it is treated as a name.
 */
const SPELLING_FRAME =
  /(?:خليه|خليها|خلّيه|اكتبه|أكتبه|اكتبها|اكتب|الصح|الصحيح|الاسم|اسمي|هو|هي|بس|لا|لأ|مش|كده|please|make\s*it|write\s*it|it'?s|it\s*is|should\s*be|actually|no|rather|spell(?:ed|ing)?|my\s*name\s*is|the\s*name\s*is|name)/giu;

const LATIN_NAME_PART = /^[A-Za-z][A-Za-z'`-]*$/;

export type NameConfirmationReading =
  /** The patient accepted the spelling exactly as it was shown to them. */
  | { status: "confirmed" }
  /** The patient supplied their own Latin spelling. It is authoritative. */
  | { status: "corrected"; name: string }
  /** A "no" with nothing to replace it. Ask them to write it. */
  | { status: "rejected" }
  /**
   * The patient wrote fewer name parts than are on file and it is not clear
   * whether they are replacing the whole name or respelling one part of it.
   * The caller asks one short question rather than guessing.
   */
  | { status: "ambiguous_correction"; existing: string; offered: string }
  /** Not an answer to the spelling question at all. */
  | { status: "unclear" };

// ---------------------------------------------------------------------------
// Partial name corrections
// ---------------------------------------------------------------------------

/**
 * "علي ادريس" → "Edris" is a correction to *one component*, not a new name.
 *
 * ## The defect this exists for
 *
 * Manual QA staged a third party as «علي ادريس», the server proposed a Latin
 * spelling, and the patient answered with the single token "Edris" — spelling
 * out the part the transliteration had got wrong. `readLatinSpelling` read that
 * as the whole answer, so the staged beneficiary became a one-word "Edris" and
 * the first name the patient had given was gone.
 *
 * ## The rule
 *
 * The name already on file is authoritative conversational state. A shorter
 * correction is merged into it *component by component*, and only when each
 * token the patient wrote clearly corresponds to exactly one component already
 * there. Correspondence is by consonant skeleton, which is what survives
 * transliteration: `Edris` and `Adris` are both `drs`, and `Idris` is too.
 *
 * Anything else is refused rather than guessed. A token matching nothing, or
 * matching two components, produces `ambiguous_correction` — one short question
 * instead of a name nobody chose. Nothing here appends, and nothing invents a
 * component the patient did not write.
 */
const SKELETON_DROPPED = /[aeiouyh'`\-]/g;

function consonantSkeleton(part: string): string {
  return part.toLocaleLowerCase("en").replace(SKELETON_DROPPED, "");
}

/** Two name parts that are plausibly the same name, spelled differently. */
function sameNameComponent(stored: string, written: string): boolean {
  const a = stored.toLocaleLowerCase("en");
  const b = written.toLocaleLowerCase("en");
  if (a === b) return true;
  const skeletonA = consonantSkeleton(a);
  const skeletonB = consonantSkeleton(b);
  // A skeleton short enough to collide by accident proves nothing on its own.
  if (skeletonA.length < 2 || skeletonB.length < 2) return false;
  return skeletonA === skeletonB;
}

export type NameCorrectionMerge =
  /** Only the matched components changed; every other one is untouched. */
  | { status: "merged"; name: string }
  /** The correction is a whole name in its own right. Replace outright. */
  | { status: "replaced"; name: string }
  /** Genuinely unclear. Ask one short question. */
  | { status: "ambiguous" };

/**
 * Merge a partial spelling correction into the name already on file.
 *
 * `existing` is whatever the conversation has staged; `correction` is what the
 * patient just wrote. A correction with at least as many components as the
 * existing name is a replacement — the patient rewrote the whole thing.
 */
export function mergeNameCorrection(
  existing: string | null | undefined,
  correction: string,
): NameCorrectionMerge {
  const target = (correction ?? "").trim().split(/\s+/).filter(Boolean);
  const current = (existing ?? "").trim().split(/\s+/).filter(Boolean);
  if (target.length === 0) return { status: "ambiguous" };
  // Nothing on file, or a correction that is itself several words: the patient
  // has written a whole name, including when it is shorter than what is on
  // file — "Anas Talal Ali" replacing "Anas Talal Abdulmaqsoud Ali" drops a
  // component deliberately, and merging it back in would restore a part they
  // just removed.
  if (current.length < 2 || target.length > 1) {
    return { status: "replaced", name: toTitleCaseName(target.join(" ")) };
  }

  // One word against a name of two or more. That is not a name; it is a
  // component of one, and the only question is which component it corrects.
  const token = target[0]!;
  const matches = current
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => sameNameComponent(part, token));
  // No component to correct, or two equally good ones: this is not a
  // correction the server may make on the patient's behalf.
  if (matches.length !== 1) return { status: "ambiguous" };
  const merged = [...current];
  merged[matches[0]!.index] = toTitleCaseName(token);
  return { status: "merged", name: merged.join(" ") };
}

/**
 * Reads a reply to "is this how you spell your name in English?".
 *
 * Three verdicts and one non-answer. The ordering below is the whole design: a
 * message that is *entirely* an agreement or a refusal is that, and anything
 * else carrying Latin letters is a spelling the patient chose — so "تمام بس
 * خليه Anas Talal" is a correction rather than the agreement its first word
 * looks like, and "ok" is an agreement rather than a one-word name.
 */
export function readNameConfirmation(
  text: string | null | undefined,
  proposed: string,
): NameConfirmationReading {
  const raw = normalizeHumanText(text ?? "").trim();
  if (!raw) return { status: "unclear" };
  // Long enough to be a paragraph is not an answer to a yes/no question.
  if (raw.length > 160) return { status: "unclear" };

  // Whole-message agreement first: "ok" and "correct" are Latin words and would
  // otherwise be read as somebody's name. Both patterns are anchored to the
  // entire message, so "تمام بس خليه Anas Talal Ali" is not one of them and
  // falls through to the correction branch below, which is the point.
  if (AFFIRMATION.test(raw)) return { status: "confirmed" };
  if (NEGATION.test(raw)) return { status: "rejected" };

  const corrected = readLatinSpelling(raw);
  if (corrected) {
    // The same spelling written back at us is an agreement, not a correction.
    if (corrected.toLocaleLowerCase("en") === proposed.toLocaleLowerCase("en")) {
      return { status: "confirmed" };
    }
    // A correction shorter than the name on file respells part of it. The
    // staged identity is authoritative; only the part they addressed moves.
    const merge = mergeNameCorrection(proposed, corrected);
    if (merge.status === "ambiguous") {
      return { status: "ambiguous_correction", existing: proposed, offered: corrected };
    }
    return merge.name.toLocaleLowerCase("en") === proposed.toLocaleLowerCase("en")
      ? { status: "confirmed" }
      : { status: "corrected", name: merge.name };
  }
  return { status: "unclear" };
}

/** The one short question a partial correction we cannot place deserves. */
export function buildNameCorrectionQuestion(
  locale: "ar" | "en",
  existing: string,
  offered: string,
): string {
  return locale === "ar"
    ? `الاسم المسجّل حاليًا هو «${existing}». تقصد أغيّر الاسم كله لـ«${offered}»، ولا ده تصحيح لجزء منه بس؟`
    : `The name on file is "${existing}". Do you want the whole name changed to "${offered}", or is that a correction to one part of it?`;
}

/**
 * The Latin-script name inside a short message, or null.
 *
 * Requires at least one whole word of Latin letters after the framing is
 * removed, and refuses a message that still carries Arabic script — "خليه أنس"
 * is a name in Arabic and belongs on the transliteration path, not on the
 * "the patient supplied a Latin spelling" path.
 */
export function readLatinSpelling(text: string | null | undefined): string | null {
  const raw = normalizeHumanText(text ?? "").trim();
  if (!raw || !/[A-Za-z]/.test(raw)) return null;
  const stripped = raw
    .replace(SPELLING_FRAME, " ")
    .replace(/[^A-Za-z\s'`-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return null;
  if (ARABIC_SCRIPT.test(stripped)) return null;
  const parts = stripped.split(" ").filter((part) => LATIN_NAME_PART.test(part));
  if (parts.length === 0) return null;
  const joined = parts.join(" ");
  if (joined.replace(/[^A-Za-z]/g, "").length < 2) return null;
  return toTitleCaseName(joined);
}

/** The question, in the clinic's words, showing the spelling being proposed. */
export function buildNameConfirmationQuestion(
  locale: "ar" | "en",
  proposed: string,
): string {
  return locale === "ar"
    ? `تمام، هكتب الاسم بالإنجليزي كده:\n${proposed}\nهل الكتابة صحيحة؟`
    : `I will write the name in English like this:\n${proposed}\nIs that spelling correct?`;
}

/** The follow-up when the patient said no but gave nothing to write instead. */
export function buildNameSpellingRequest(locale: "ar" | "en"): string {
  return locale === "ar"
    ? "تمام، ممكن تكتبلي الاسم بالإنجليزي زي ما تحب يتكتب؟"
    : "No problem — could you write the name in English exactly as you would like it spelled?";
}

// ---------------------------------------------------------------------------
// Blood type
// ---------------------------------------------------------------------------

/**
 * "لا أعرف", "معرفش", "skip" — the patient declining a field that is optional.
 *
 * A decline is an *answer*: it resolves the question, stores nothing, and must
 * never block a registration. It is deliberately not a catch-all — an
 * unreadable value is not a decline, and gets one more chance to be read.
 */
const BLOOD_TYPE_DECLINE =
  /(?:لا\s*أعرف|لا\s*اعرف|مش\s*عارف|مش\s*عارفة|معرفش|ما\s*أعرف|ما\s*اعرف|مش\s*فاكر|مش\s*متأكد|مانيش\s*عارف|مش\s*مهم|سيبها|تخطى|تخطي|بعدين|don'?t\s*know|do\s*not\s*know|dunno|not\s*sure|no\s*idea|unknown|skip|later|pass|prefer\s*not)/i;

export function isBloodTypeDeclined(text: string | null | undefined): boolean {
  const raw = normalizeHumanText(text ?? "").trim();
  if (!raw || raw.length > 160) return false;
  return BLOOD_TYPE_DECLINE.test(raw);
}

/** The question, asked so that declining is obviously allowed. */
export function buildBloodTypeQuestion(locale: "ar" | "en"): string {
  return locale === "ar"
    ? "وفصيلة الدم لو تعرفها؟ ولو مش عارف عادي قول لا أعرف."
    : "And your blood type, if you know it? If you are not sure, just say you do not know.";
}

/** The one retry after something that was neither a blood type nor a decline. */
export function buildBloodTypeRetry(locale: "ar" | "en"): string {
  return locale === "ar"
    ? "معلش، ما قدرتش أقرا فصيلة الدم. اكتبها كده: O+ أو A- مثلًا، ولو مش عارف قول لا أعرف."
    : "Sorry, I could not read that blood type. Write it like O+ or A-, or tell me you do not know.";
}
